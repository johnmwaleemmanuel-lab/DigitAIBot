'use strict';

const fs = require('fs');
const path = require('path');

/**
 * TradeHistoryStore
 * Persists every completed trade to a local JSONL file (one JSON object
 * per line) so trade history survives bot restarts and can be reviewed/
 * evaluated later (win rate, per-strategy performance, etc.).
 */
class TradeHistoryStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, '..', 'data', 'trade_history.jsonl');
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '');
  }

  loadAll() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  append(entry) {
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
      return true;
    } catch (e) {
      return false;
    }
  }

  clear() {
    try {
      fs.writeFileSync(this.filePath, '');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Simple evaluation stats: overall + per-strategy + per-market win rate. */
  computeStats(entries) {
    const stats = {
      totalTrades: entries.length,
      wins: 0,
      losses: 0,
      totalProfit: 0,
      winRate: 0,
      byStrategy: {},
      byMarket: {},
    };

    for (const t of entries) {
      stats.totalProfit += t.profit;
      if (t.won) stats.wins++;
      else stats.losses++;

      const strat = t.strategy || 'UNKNOWN';
      if (!stats.byStrategy[strat]) {
        stats.byStrategy[strat] = { trades: 0, wins: 0, profit: 0 };
      }
      stats.byStrategy[strat].trades++;
      stats.byStrategy[strat].profit += t.profit;
      if (t.won) stats.byStrategy[strat].wins++;

      const market = t.symbol || 'UNKNOWN';
      if (!stats.byMarket[market]) {
        stats.byMarket[market] = { trades: 0, wins: 0, profit: 0 };
      }
      stats.byMarket[market].trades++;
      stats.byMarket[market].profit += t.profit;
      if (t.won) stats.byMarket[market].wins++;
    }

    stats.winRate = stats.totalTrades ? (stats.wins / stats.totalTrades) * 100 : 0;
    return stats;
  }
}

module.exports = TradeHistoryStore;
