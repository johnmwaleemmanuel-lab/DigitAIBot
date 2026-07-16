'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');

/**
 * DerivClient
 * Thin wrapper around the Deriv WebSocket API v3.
 * Handles: auth, pip-size discovery, tick history + live subscription,
 * digit contract purchase, portfolio lookup (for reconnect sync).
 *
 * Emits:
 *   'connected'            - after successful authorize
 *   'disconnected'         - socket closed
 *   'tick' (symbol, digit, quote, epoch)
 *   'contractResult' (payload)  - fires when an open contract settles
 *   'log' (level, message)
 *   'error' (err)
 */
class DerivClient extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ws = null;
    this.reqId = 1;
    this.pending = new Map(); // req_id -> {resolve, reject}
    this.pipSizes = new Map(); // symbol -> decimal places
    this.subscribedSymbols = new Set();
    this.authorized = false;
    this.reconnecting = false;
    this.openContractId = null;
    this.openContractSubId = null;
    this.intentionalDisconnect = false;
  }

  log(msg, level = 'info') {
    this.emit('log', level, msg);
  }

  connect() {
    this.intentionalDisconnect = false;
    const url = `wss://ws.derivws.com/websockets/v3?app_id=${this.cfg.deriv.appId}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.log('WebSocket connected, authorizing...');
      this._send({ authorize: this.cfg.deriv.apiToken });
    });

    this.ws.on('message', (raw) => this._handleMessage(raw));

    this.ws.on('close', () => {
      this.authorized = false;
      this.emit('disconnected');
      if (this.intentionalDisconnect) {
        this.log('Disconnected (logout) — will not auto-reconnect.');
        return;
      }
      this.log('Disconnected from Deriv. Reconnecting immediately...', 'warn');
      this._reconnect();
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
      this.log(`WebSocket error: ${err.message}`, 'error');
    });
  }

  disconnect() {
    this.intentionalDisconnect = true;
    this.authorized = false;
    this.subscribedSymbols.clear();
    try {
      if (this.ws) this.ws.close();
    } catch (e) {
      /* ignore */
    }
  }

  _reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    setTimeout(() => {
      this.reconnecting = false;
      this.connect();
    }, 1000);
  }

  _send(payload) {
    const reqId = this.reqId++;
    payload.req_id = reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(reqId);
        reject(e);
      }
    });
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.req_id && this.pending.has(msg.req_id)) {
      const { resolve, reject } = this.pending.get(msg.req_id);
      this.pending.delete(msg.req_id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg);
    }

    switch (msg.msg_type) {
      case 'authorize':
        if (msg.error) {
          this.log(`Authorization failed: ${msg.error.message}`, 'error');
          this.emit('authError', msg.error.message);
          return;
        }
        this.authorized = true;
        this.log(`Authorized as ${msg.authorize.loginid} (${this.cfg.deriv.accountType})`);

        this.emit('accountInfo', {
          loginid: msg.authorize.loginid,
          isVirtual: !!msg.authorize.is_virtual,
          balance: msg.authorize.balance,
          currency: msg.authorize.currency,
          fullname: msg.authorize.fullname,
        });

        this.emit('connected');
        this._syncOpenContracts();
        this._send({ balance: 1, subscribe: 1 }).catch((e) =>
          this.log(`Balance subscribe failed: ${e.message}`, 'warn')
        );
        break;

      case 'balance':
        if (msg.balance) {
          this.emit('balanceUpdate', {
            balance: msg.balance.balance,
            currency: msg.balance.currency,
          });
        }
        break;

      case 'active_symbols':
        break; // handled via _send promise resolution

      case 'history':
        break; // handled via _send promise resolution

      case 'tick':
        if (msg.tick) this._onTick(msg.tick);
        break;

      case 'proposal_open_contract': {
        const c = msg.proposal_open_contract;
        if (c && c.is_sold) {
          this.emit('contractResult', {
            contractId: c.contract_id,
            profit: c.profit,
            payout: c.payout,
            buyPrice: c.buy_price,
            won: c.profit > 0,
            symbol: c.underlying,
          });
          this.openContractId = null;
        }
        break;
      }

      case 'buy':
        break; // handled via _send promise resolution

      default:
        break;
    }
  }

  _onTick(tick) {
    const pip = this.pipSizes.get(tick.symbol);
    const decimals = pip !== undefined ? pip : this._inferDecimals(tick.quote);
    const fixed = Number(tick.quote).toFixed(decimals);
    const digit = parseInt(fixed[fixed.length - 1], 10);
    this.emit('tick', tick.symbol, digit, tick.quote, tick.epoch);
  }

  _inferDecimals(quote) {
    const s = String(quote);
    const idx = s.indexOf('.');
    return idx === -1 ? 0 : s.length - idx - 1;
  }

  async fetchPipSizes(symbols) {
    try {
      const res = await this._send({ active_symbols: 'brief', product_type: 'basic' });
      const list = res.active_symbols || [];
      for (const s of list) {
        if (symbols.includes(s.symbol)) {
          const decimals = this._inferDecimals(s.pip);
          this.pipSizes.set(s.symbol, decimals);
        }
      }
      this.log(`Pip sizes loaded for ${this.pipSizes.size} symbols`);
    } catch (e) {
      this.log(`Could not fetch active_symbols: ${e.message}`, 'warn');
    }
  }

  async subscribeMarket(symbol, sampleWindow) {
    if (this.subscribedSymbols.has(symbol)) return;
    this.subscribedSymbols.add(symbol);

    try {
      const hist = await this._send({
        ticks_history: symbol,
        count: sampleWindow,
        end: 'latest',
        style: 'ticks',
      });
      const prices = hist.history ? hist.history.prices : [];
      const decimals = this.pipSizes.get(symbol) || this._inferDecimals(prices[0]);
      const digits = prices.map((p) => {
        const fixed = Number(p).toFixed(decimals);
        return parseInt(fixed[fixed.length - 1], 10);
      });
      this.emit('history', symbol, digits);
    } catch (e) {
      // Common causes: market closed for the weekend, symbol temporarily
      // suspended, or a rate-limit rejection. Surface it, don't throw —
      // the bot keeps scanning other markets.
      this.log(`History fetch failed for ${symbol}: ${e.message}`, 'warn');
      this.emit('marketUnavailable', symbol, e.message);
    }

    // live subscription
    this._send({ ticks: symbol, subscribe: 1 }).catch((e) => {
      this.log(`Subscribe failed for ${symbol}: ${e.message}`, 'warn');
      this.emit('marketUnavailable', symbol, e.message);
    });
  }

  async _syncOpenContracts() {
    try {
      const res = await this._send({ portfolio: 1 });
      const contracts = (res.portfolio && res.portfolio.contracts) || [];
      const digitContract = contracts.find((c) =>
        /^DIGIT/.test(c.contract_type || '')
      );
      if (digitContract) {
        this.log(`Found open contract on reconnect: ${digitContract.contract_id}`, 'warn');
        this.openContractId = digitContract.contract_id;
        this._send({
          proposal_open_contract: 1,
          contract_id: digitContract.contract_id,
          subscribe: 1,
        }).catch(() => {});
      } else {
        this.emit('noOpenContract');
      }
    } catch (e) {
      this.log(`Portfolio sync failed: ${e.message}`, 'warn');
    }
  }

  /**
   * Buy a digit contract directly (no proposal round-trip).
   * strategyType: 'OVER' | 'UNDER' | 'EVEN' | 'ODD'
   */
  async buyDigitContract({ symbol, strategyType, barrier, stake, durationTicks }) {
    const contractTypeMap = {
      OVER: 'DIGITOVER',
      UNDER: 'DIGITUNDER',
      EVEN: 'DIGITEVEN',
      ODD: 'DIGITODD',
    };
    const contract_type = contractTypeMap[strategyType];
    const params = {
      amount: stake,
      basis: 'stake',
      contract_type,
      currency: this.cfg.deriv.currency,
      duration: durationTicks,
      duration_unit: 't',
      symbol,
    };
    if (strategyType === 'OVER' || strategyType === 'UNDER') {
      params.barrier = String(barrier);
    }

    try {
      const res = await this._send({ buy: 1, price: stake, parameters: params });
      if (res.buy) {
        this.openContractId = res.buy.contract_id;
        this._send({
          proposal_open_contract: 1,
          contract_id: res.buy.contract_id,
          subscribe: 1,
        }).catch(() => {});
        return { ok: true, contractId: res.buy.contract_id, buyPrice: res.buy.buy_price };
      }
      return { ok: false, error: 'Unknown buy response' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = DerivClient;
