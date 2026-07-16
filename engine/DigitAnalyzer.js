'use strict';

/**
 * DigitAnalyzer
 * Maintains a rolling window of last-digits per market and computes:
 *   - percentage distribution (0-9)
 *   - bar ranking (Green=most, Blue=2nd most, Yellow=2nd least, Red=least)
 *   - the digit sequence tail (for entry-trigger pattern checks)
 */
class DigitAnalyzer {
  constructor(sampleWindow = 1000) {
    this.sampleWindow = sampleWindow;
    this.buffers = new Map(); // symbol -> array of digits (oldest..newest)
  }

  setSampleWindow(n) {
    this.sampleWindow = n;
    for (const [symbol, buf] of this.buffers) {
      if (buf.length > n) this.buffers.set(symbol, buf.slice(buf.length - n));
    }
  }

  seedHistory(symbol, digits) {
    const trimmed = digits.slice(-this.sampleWindow);
    this.buffers.set(symbol, trimmed);
  }

  pushTick(symbol, digit) {
    const buf = this.buffers.get(symbol) || [];
    buf.push(digit);
    if (buf.length > this.sampleWindow) buf.shift();
    this.buffers.set(symbol, buf);
  }

  hasData(symbol) {
    const buf = this.buffers.get(symbol);
    return buf && buf.length >= Math.min(100, this.sampleWindow);
  }

  getTail(symbol, n) {
    const buf = this.buffers.get(symbol) || [];
    return buf.slice(-n);
  }

  /** Returns { percentages: [0..9]->%, ranking: {green,blue,yellow,red} } */
  getStats(symbol) {
    const buf = this.buffers.get(symbol) || [];
    const counts = new Array(10).fill(0);
    for (const d of buf) counts[d]++;
    const total = buf.length || 1;
    const percentages = counts.map((c) => (c / total) * 100);

    const order = percentages
      .map((pct, digit) => ({ digit, pct }))
      .sort((a, b) => b.pct - a.pct);

    return {
      percentages,
      total: buf.length,
      ranking: {
        green: order[0].digit,
        blue: order[1].digit,
        yellow: order[8].digit,
        red: order[9].digit,
      },
      order,
    };
  }
}

module.exports = DigitAnalyzer;
