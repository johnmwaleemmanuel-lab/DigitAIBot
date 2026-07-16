'use strict';

const EventEmitter = require('events');
const DerivClient = require('../deriv/DerivClient');
const DigitAnalyzer = require('./DigitAnalyzer');
const StrategyEngine = require('./StrategyEngine');
const TradeHistoryStore = require('./TradeHistoryStore');

const ALL_STRATEGIES = ['OVER', 'UNDER', 'EVEN_ODD', 'REVERSE_PSYCHOLOGY', 'OVER_UNDER_2'];
const MOMENTUM_STRATEGIES = ['OVER', 'UNDER', 'OVER_UNDER_2'];

class BotController extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.client = new DerivClient(cfg);
    this.analyzer = new DigitAnalyzer(cfg.sampleWindowTicks);
    this.strategyEngine = new StrategyEngine(cfg);

    this.running = false;
    this.tradeActive = false;
    this.mode = cfg.mode; // 'AI' | 'SINGLE'
    this.singleStrategy = cfg.singleStrategy;

    this.currentStake = cfg.stake.base;
    this.consecutiveLosses = 0;
    this.recoveryMode = false;

    this.sessionProfit = 0;
    this.markets = [
      ...cfg.markets.plainVolatility.map((s) => ({ symbol: s, group: 'plain' })),
      ...cfg.markets.secondsVolatility.map((s) => ({ symbol: s, group: 'seconds' })),
      ...cfg.markets.jumpIndices.map((s) => ({ symbol: s, group: 'jump' })),
    ];

    this.scanTimer = null;
    this.lastScanSignals = [];
    this.history = new TradeHistoryStore();
    this.tradeLog = this.history.loadAll();
    this._needResubscribe = false;

    this._wireClient();
  }

  log(message, level = 'info') {
    this.emit('log', { level, message, ts: Date.now() });
  }

  _wireClient() {
    this.client.on('log', (level, message) => this.log(message, level));
    this.client.on('connected', () => {
      this.emit('status', { connected: true });
      if (this._needResubscribe) {
        this._needResubscribe = false;
        this._resubscribeAll().catch((e) => this.log(`Resubscribe failed: ${e.message}`, 'error'));
      }
    });
    this.client.on('disconnected', () => this.emit('status', { connected: false }));

    this.client.on('history', (symbol, digits) => {
      this.analyzer.seedHistory(symbol, digits);
    });

    this.client.on('tick', (symbol, digit) => {
      this.analyzer.pushTick(symbol, digit);
      this.emit('tick', { symbol, digit });
    });

    this.client.on('contractResult', (result) => this._onContractResult(result));

    this.client.on('noOpenContract', () => {
      this.tradeActive = false;
    });

    this.client.on('accountInfo', (info) => {
      this.accountInfo = {
        loginid: info.loginid,
        isVirtual: info.isVirtual,
        balance: info.balance,
        currency: info.currency,
      };
      // The authorize response is the source of truth for account type —
      // reconcile cfg + emit so the server can persist the confirmed session.
      this.cfg.deriv.accountId = info.loginid;
      this.cfg.deriv.accountType = info.isVirtual ? 'demo' : 'real';
      this.emit('accountInfo', this.accountInfo);
      this.emit('sessionConfirmed', {
        accountId: info.loginid,
        accountType: this.cfg.deriv.accountType,
      });
    });

    this.client.on('balanceUpdate', (bal) => {
      if (this.accountInfo) this.accountInfo.balance = bal.balance;
      this.emit('balanceUpdate', bal);
    });

    this.client.on('authError', (message) => {
      this.emit('authError', { message });
    });

    // Market closed / not tradable right now (e.g. weekend closures on some
    // symbols) or a subscribe call getting rejected (e.g. rate-limited) —
    // logged and surfaced to the dashboard, never halts the bot.
    this.client.on('marketUnavailable', (symbol, reason) => {
      this.log(`Market unavailable: ${symbol} (${reason}) — skipping until it recovers`, 'warn');
      this.emit('marketUnavailable', { symbol, reason });
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.client.connect();

    await new Promise((resolve) => {
      if (this.client.authorized) return resolve();
      this.client.once('connected', resolve);
    });

    await this._resubscribeAll();

    this.log('Bot started. Mode: ' + this.mode);
    this.scanTimer = setInterval(() => this._scanCycle(), this.cfg.scanIntervalMs);
  }

  /**
   * Fetches pip sizes + (re)subscribes to every market's tick stream.
   * Staggered with a small delay per symbol to avoid bursting Deriv's
   * API rate limits when subscribing to all ~15 markets at once.
   */
  async _resubscribeAll() {
    const symbols = this.markets.map((m) => m.symbol);
    await this.client.fetchPipSizes(symbols);
    for (const s of symbols) {
      try {
        await this.client.subscribeMarket(s, this.cfg.sampleWindowTicks);
      } catch (e) {
        this.emit('marketUnavailable', { symbol: s, reason: e.message });
      }
      await new Promise((r) => setTimeout(r, 150)); // stagger to respect rate limits
    }
  }

  /**
   * Apply new Deriv credentials (App ID / API Token / Account ID / Type)
   * at runtime and reconnect immediately — used when the user edits
   * credentials from the dashboard's "Deriv Connection" panel.
   */
  applyCredentials(creds) {
    Object.assign(this.cfg.deriv, creds);
    this.log(`Applying new Deriv credentials for account ${this.cfg.deriv.accountId}...`, 'warn');

    this.client.authorized = false;
    this.client.subscribedSymbols.clear();
    this.client.pipSizes.clear();
    this._needResubscribe = this.running;

    try {
      if (this.client.ws) {
        this.client.ws.removeAllListeners(); // old socket's close/error must not trigger reconnect logic
        this.client.ws.close();
      }
    } catch (e) {
      /* ignore */
    }
    this.client.connect(); // opens a fresh socket with the updated cfg.deriv (same object reference)
  }

  /** Full logout: stop trading if running, disconnect the Deriv socket. */
  logout() {
    if (this.running) this.stop('User logged out');
    this.client.disconnect();
    this.accountInfo = null;
    this.emit('status', { connected: false });
    this.log('Logged out of Deriv.');
  }

  stop(reason = 'Manual stop') {
    this.running = false;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    this.log(`Bot stopped: ${reason}`);
    this.emit('stopped', { reason });
  }

  setMode(mode, singleStrategy) {
    this.mode = mode;
    if (singleStrategy) this.singleStrategy = singleStrategy;
  }

  _tickDurationFor(group) {
    if (this.cfg.tickDuration.userOverride) return this.cfg.tickDuration.userOverride;
    if (group === 'plain') return this.cfg.tickDuration.plainVolatility;
    return this.cfg.tickDuration.isNewAccount
      ? this.cfg.tickDuration.secondsOrJump_newAccount
      : this.cfg.tickDuration.secondsOrJump_oldAccount;
  }

  _scanCycle() {
    if (!this.running) return;

    // Check risk targets even while idle
    if (this._riskLimitHit()) return;

    if (this.tradeActive) {
      this.emit('scanStatus', { status: 'trade-active' });
      return;
    }

    const activeStrategies = this.mode === 'SINGLE' ? [this._singleStrategyKey()] : ALL_STRATEGIES;

    let candidates = [];
    const marketStats = [];
    for (const { symbol, group } of this.markets) {
      if (!this.analyzer.hasData(symbol)) continue;
      const stats = this.analyzer.getStats(symbol);
      const tail = this.analyzer.getTail(symbol, 10);
      marketStats.push({ symbol, percentages: stats.percentages, ranking: stats.ranking });

      const signals = this.strategyEngine.evaluateMarket(symbol, stats, tail);
      for (const sig of signals) {
        if (!activeStrategies.includes(sig.strategy)) continue;
        candidates.push({ ...sig, group });
      }
    }

    this.lastScanSignals = candidates;
    this.emit('marketStats', { marketStats });
    this.emit('scanUpdate', { candidates });

    if (candidates.length === 0) {
      this.emit('scanStatus', { status: 'no-signal' });
      return;
    }

    const selected = this._selectBest(candidates);
    this._executeTrade(selected);
  }

  _singleStrategyKey() {
    // maps config's single-strategy label to engine strategy keys
    const map = {
      OVER_UNDER: ['OVER', 'UNDER'],
      OVER: ['OVER'],
      UNDER: ['UNDER'],
      EVEN_ODD: ['EVEN_ODD'],
      REVERSE_PSYCHOLOGY: ['REVERSE_PSYCHOLOGY'],
      OVER_UNDER_2: ['OVER_UNDER_2'],
    };
    return map[this.singleStrategy] || ['OVER', 'UNDER'];
  }

  _selectBest(candidates) {
    // Recovery Mode forces Even-Odd only (AI mode)
    if (this.mode === 'AI' && this.recoveryMode) {
      const evenOddOnly = candidates.filter((c) => c.strategy === 'EVEN_ODD');
      if (evenOddOnly.length > 0) {
        return evenOddOnly.sort((a, b) => b.confidence - a.confidence)[0];
      }
      // no Even-Odd signal yet; wait for one instead of trading anything else
      return null;
    }

    // Conflict Rule: per-market, momentum vs reverse-psychology -> highest score wins
    const bySymbol = new Map();
    for (const c of candidates) {
      const existing = bySymbol.get(c.symbol);
      if (!existing || c.confidence > existing.confidence) bySymbol.set(c.symbol, c);
    }
    const resolved = [...bySymbol.values()];
    resolved.sort((a, b) => b.confidence - a.confidence);
    return resolved[0];
  }

  async _executeTrade(selected) {
    if (!selected) return;
    this.tradeActive = true;

    const group = selected.group;
    const durationTicks = this._tickDurationFor(group);
    const stake = this.currentStake;

    let strategyType;
    let barrier = null;
    if (selected.strategy === 'OVER' || (selected.strategy === 'OVER_UNDER_2' && selected.side === 'OVER')) {
      strategyType = 'OVER';
      barrier = selected.barrier;
    } else if (selected.strategy === 'UNDER' || (selected.strategy === 'OVER_UNDER_2' && selected.side === 'UNDER')) {
      strategyType = 'UNDER';
      barrier = selected.barrier;
    } else if (selected.strategy === 'EVEN_ODD') {
      strategyType = 'EVEN';
    } else if (selected.strategy === 'REVERSE_PSYCHOLOGY') {
      strategyType = selected.side === 'EVEN' ? 'EVEN' : 'ODD';
    }

    this.emit('tradeAttempt', { ...selected, stake, durationTicks });
    this.log(
      `Placing trade: ${selected.strategy} ${selected.symbol} stake=$${stake.toFixed(
        2
      )} confidence=${selected.confidence}%`
    );

    const result = await this.client.buyDigitContract({
      symbol: selected.symbol,
      strategyType,
      barrier,
      stake,
      durationTicks,
    });

    if (!result.ok) {
      this.tradeActive = false;
      this.log(`Trade rejected: ${result.error}`, 'error');
      this.emit('tradeRejected', { ...selected, error: result.error });
      return; // keep scanning, do not halt
    }

    this.emit('tradePlaced', {
      ...selected,
      stake,
      contractId: result.contractId,
    });
  }

  _onContractResult(result) {
    this.tradeActive = false;
    this.sessionProfit += result.profit;

    const matchedSignal = this.lastScanSignals.find((s) => s.symbol === result.symbol);

    const entry = {
      ts: Date.now(),
      symbol: result.symbol,
      strategy: matchedSignal ? matchedSignal.strategy : null,
      confidence: matchedSignal ? matchedSignal.confidence : null,
      barrier: matchedSignal ? matchedSignal.barrier || null : null,
      profit: result.profit,
      won: result.won,
      stake: this.currentStake,
      sessionProfit: this.sessionProfit,
    };
    this.tradeLog.push(entry);
    this.history.append(entry); // persists to disk (data/trade_history.jsonl) — survives restarts
    this.emit('tradeResult', entry);
    this.emit('historyUpdate', {
      trades: this.tradeLog,
      stats: this.history.computeStats(this.tradeLog),
    });
    this.log(
      `Trade ${result.won ? 'WON' : 'LOST'}: ${result.profit >= 0 ? '+' : ''}$${result.profit.toFixed(
        2
      )} | Session P/L: $${this.sessionProfit.toFixed(2)}`
    );

    if (result.won) {
      this.currentStake = this.cfg.stake.base;
      this.consecutiveLosses = 0;
      if (this.recoveryMode) {
        this.recoveryMode = false;
        this.log('Recovery successful — resuming normal multi-strategy scanning.');
      }
    } else {
      this.consecutiveLosses += 1;
      this.currentStake = this.currentStake * this.cfg.stake.martingaleMultiplier;
      if (this.cfg.stake.maxMartingaleSteps) {
        // uncapped by default; only applies if user sets a cap
      }

      const lastStrategy = this.lastScanSignals.find((s) => s.symbol === result.symbol);
      const strategyKey = lastStrategy ? lastStrategy.strategy : null;
      const fromMomentumOrReverse =
        strategyKey && MOMENTUM_STRATEGIES.concat(['REVERSE_PSYCHOLOGY']).includes(strategyKey);

      if (
        this.mode === 'AI' &&
        !this.recoveryMode &&
        this.consecutiveLosses >= this.cfg.recovery.consecutiveLossThreshold &&
        fromMomentumOrReverse
      ) {
        this.recoveryMode = true;
        this.log('Consecutive losses reached threshold — entering Even-Odd Recovery Mode.', 'warn');
      }
    }

    this.emit('stateUpdate', this._publicState());
    this._riskLimitHit();
  }

  _riskLimitHit() {
    if (this.sessionProfit >= this.cfg.risk.targetProfit) {
      if (!this.tradeActive) {
        this.stop(`Target Profit reached ($${this.sessionProfit.toFixed(2)})`);
        return true;
      }
    }
    if (this.sessionProfit <= -Math.abs(this.cfg.risk.targetStopLoss)) {
      if (!this.tradeActive) {
        this.stop(`Target Stop-Loss reached ($${this.sessionProfit.toFixed(2)})`);
        return true;
      }
    }
    return false;
  }

  getHistory() {
    return {
      trades: this.tradeLog,
      stats: this.history.computeStats(this.tradeLog),
    };
  }

  _publicState() {
    return {
      running: this.running,
      mode: this.mode,
      singleStrategy: this.singleStrategy,
      tradeActive: this.tradeActive,
      currentStake: this.currentStake,
      consecutiveLosses: this.consecutiveLosses,
      recoveryMode: this.recoveryMode,
      sessionProfit: this.sessionProfit,
      targetProfit: this.cfg.risk.targetProfit,
      targetStopLoss: this.cfg.risk.targetStopLoss,
    };
  }
}

module.exports = BotController;
