'use strict';

const EVEN = [0, 2, 4, 6, 8];
const ODD = [1, 3, 5, 7, 9];

/**
 * StrategyEngine
 * Pure detection logic — given digit stats + recent tick tail for a market,
 * returns every strategy signal that currently passes its mandatory gate,
 * each with a 0-100 confidence score (Step 5 weighting: 50/30/20).
 *
 * Does NOT place trades or track bot state — that lives in BotController.
 */
class StrategyEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.prevPercentages = new Map(); // symbol -> previous cycle's percentages[10], for "reducing" trend checks
  }

  evaluateMarket(symbol, stats, tail) {
    const signals = [];

    const overSig = this._checkOver(stats, tail);
    if (overSig) signals.push(overSig);

    const underSig = this._checkUnder(stats, tail);
    if (underSig) signals.push(underSig);

    const evenOddSig = this._checkEvenOdd(stats, tail);
    if (evenOddSig) signals.push(evenOddSig);

    const reverseSig = this._checkReversePsychology(stats);
    if (reverseSig) signals.push(reverseSig);

    const overUnder2Sig = this._checkOverUnder2(symbol, stats, tail);
    if (overUnder2Sig) signals.push(overUnder2Sig);

    // remember this cycle's percentages for next cycle's "reducing" trend check
    this.prevPercentages.set(symbol, stats.percentages.slice());

    return signals.map((s) => ({ ...s, symbol }));
  }

  // ---------------- OVER ----------------
  _checkOver(stats, tail) {
    let best = null;
    for (const variant of this.cfg.overVariants) {
      const losing = variant === 2 ? [0, 1, 2] : [0, 1, 2, 3];
      const winning = variant === 2 ? [3, 4, 5, 6, 7, 8, 9] : [4, 5, 6, 7, 8, 9];
      const trigger = this._entryTrigger(tail, losing, winning, true);
      if (!trigger) continue;
      if (!this._gatePasses(stats, losing, winning)) continue;

      const confidence = this._score(stats, losing, winning);
      if (!best || confidence > best.confidence) {
        best = {
          strategy: 'OVER',
          variant,
          barrier: variant,
          confidence,
          triggerDigit: trigger.triggerDigit,
          losing,
          winning,
        };
      }
    }
    return best;
  }

  // ---------------- UNDER ----------------
  _checkUnder(stats, tail) {
    let best = null;
    for (const variant of this.cfg.underVariants) {
      const losing = variant === 7 ? [7, 8, 9] : [6, 7, 8, 9];
      const winning = variant === 7 ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5];
      const trigger = this._entryTrigger(tail, losing, winning, true);
      if (!trigger) continue;
      if (!this._gatePasses(stats, losing, winning)) continue;

      const confidence = this._score(stats, losing, winning);
      if (!best || confidence > best.confidence) {
        best = {
          strategy: 'UNDER',
          variant,
          barrier: variant,
          confidence,
          triggerDigit: trigger.triggerDigit,
          losing,
          winning,
        };
      }
    }
    return best;
  }

  /**
   * 3 consecutive losing digits, then 1 winning digit = trigger (Over/Under).
   * excludeZeroNine: excludes digit 0/9 from being used as trigger or
   * confirmation digit (per source-notes exclusion, Over/Under only).
   */
  _entryTrigger(tail, losingSet, winningSet, excludeZeroNine) {
    if (tail.length < 4) return null;
    const last4 = tail.slice(-4);
    const confirmDigits = last4.slice(0, 3);
    const triggerDigit = last4[3];

    const allLosing = confirmDigits.every((d) => losingSet.includes(d));
    const triggerWins = winningSet.includes(triggerDigit);
    if (!allLosing || !triggerWins) return null;

    if (excludeZeroNine) {
      const touchesExcluded =
        confirmDigits.includes(0) ||
        confirmDigits.includes(9) ||
        triggerDigit === 0 ||
        triggerDigit === 9;
      if (touchesExcluded) return null;
    }
    return { triggerDigit };
  }

  /**
   * OVER/UNDER STRATEGY 2 — as specified by the user:
   *   OVER 3 v2: digits 0,1,2,3 must each be <10%, OR if at/above 10%
   *     must be trending down vs the previous scan cycle. Green bar
   *     (most-appearing digit) must sit in the winning set (4-9); Red bar
   *     (least-appearing digit) must sit in the losing set (0-3).
   *     Entry: the instant a tick lands on 0, 1, 2, or 3 — enter OVER 3.
   *   UNDER 7 v2: mirrored — losing set 7,8,9; winning set 0-6.
   *     Entry: the instant a tick lands on 7, 8, or 9 — enter UNDER 7.
   * Unlike the original Over/Under (3-losing-ticks-then-1-winning-tick),
   * this variant enters on a single tap of any losing digit.
   */
  _checkOverUnder2(symbol, stats, tail) {
    const over3 = this._checkOverUnder2Variant(symbol, stats, tail, {
      losing: [0, 1, 2, 3],
      winning: [4, 5, 6, 7, 8, 9],
      side: 'OVER',
      barrier: 3,
    });
    const under7 = this._checkOverUnder2Variant(symbol, stats, tail, {
      losing: [7, 8, 9],
      winning: [0, 1, 2, 3, 4, 5, 6],
      side: 'UNDER',
      barrier: 7,
    });

    if (over3 && under7) return over3.confidence >= under7.confidence ? over3 : under7;
    return over3 || under7 || null;
  }

  _checkOverUnder2Variant(symbol, stats, tail, { losing, winning, side, barrier }) {
    const prev = this.prevPercentages.get(symbol);

    const losingOk = losing.every((d) => {
      const pct = stats.percentages[d];
      if (pct < this.cfg.threshold.losingMax) return true;
      if (!prev) return false; // no history yet to confirm a reducing trend
      return pct < prev[d]; // at/above threshold but trending down = still acceptable
    });
    if (!losingOk) return null;

    const { green, red } = stats.ranking;
    if (!winning.includes(green)) return null;
    if (!losing.includes(red)) return null;

    if (tail.length < 1) return null;
    const lastDigit = tail[tail.length - 1];
    if (!losing.includes(lastDigit)) return null; // entry: price must have just tapped the losing zone

    const confidence = this._score(stats, losing, winning);
    return {
      strategy: 'OVER_UNDER_2',
      side,
      barrier,
      confidence,
      triggerDigit: lastDigit,
      losing,
      winning,
    };
  }

  /** Mandatory gate: all losing-side % must be below threshold. */
  _gatePasses(stats, losing, winning) {
    const { losingMax } = this.cfg.threshold;
    return losing.every((d) => stats.percentages[d] < losingMax);
  }

  // ---------------- EVEN / ODD ----------------
  _checkEvenOdd(stats, tail) {
    const { losingMax } = this.cfg.threshold;
    const oddPcts = ODD.map((d) => ({ d, pct: stats.percentages[d] }));
    const above = oddPcts.filter((o) => o.pct >= losingMax);
    const below = oddPcts.filter((o) => o.pct < losingMax);

    if (above.length !== 1 || below.length !== 4) return null;

    const triggerDigit = above[0].d;
    if (tail.length < 2) return null;
    const preceding = tail[tail.length - 2];
    if (!ODD.includes(preceding)) return null;

    const confidence = this._score(stats, ODD, EVEN);
    return {
      strategy: 'EVEN_ODD',
      side: 'EVEN',
      confidence,
      triggerDigit,
      losing: ODD,
      winning: EVEN,
    };
  }

  // ---------------- REVERSE PSYCHOLOGY ----------------
  _checkReversePsychology(stats) {
    const { green, blue, yellow, red } = stats.ranking;
    const { losingMax } = this.cfg.threshold;

    const greenIsEven = EVEN.includes(green);
    const blueIsEven = EVEN.includes(blue);
    if (greenIsEven !== blueIsEven) return null; // no clear dominant side

    const dominant = greenIsEven ? EVEN : ODD;
    const weak = greenIsEven ? ODD : EVEN;

    // Trigger A: Red Bar Reversal - red bar has shifted onto the weak side
    // while green/blue/yellow remain on the dominant side.
    const yellowIsDominant = dominant.includes(yellow);
    const redIsWeak = weak.includes(red);
    const triggerA = yellowIsDominant && redIsWeak;

    // Trigger B: Percentage Recovery - exactly one weak-side digit has
    // recovered above threshold while dominant side is still overbought
    // (majority of dominant-side digits >= threshold).
    const weakPcts = weak.map((d) => stats.percentages[d]);
    const recovering = weak.filter((d) => stats.percentages[d] >= losingMax);
    const dominantPcts = dominant.map((d) => stats.percentages[d]);
    const dominantOverbought = dominantPcts.filter((p) => p >= losingMax).length >= 3;
    const triggerB = recovering.length === 1 && dominantOverbought;

    if (!triggerA && !triggerB) return null;

    // Score adapted for contrarian logic: "winning" (side we bet on) = weak
    // side; overbought strength of dominant side stands in for percentage
    // gap; bar alignment = green+blue confirmed still on dominant side.
    const confidence = this._reverseScore(dominant, weak, stats);

    return {
      strategy: 'REVERSE_PSYCHOLOGY',
      side: weak === EVEN ? 'EVEN' : 'ODD',
      confidence,
      triggerType: triggerA ? 'RED_BAR_REVERSAL' : 'PERCENTAGE_RECOVERY',
      losing: dominant,
      winning: weak,
    };
  }

  // ---------------- SCORING (50/30/20 per Step 5) ----------------
  _score(stats, losing, winning) {
    const w = this.cfg.confidenceWeights;
    const { losingMax, losingIdeal, winningStrong } = this.cfg.threshold;

    // 1. Percentage strength: how far below losingMax the losing digits sit
    const avgLosing = losing.reduce((a, d) => a + stats.percentages[d], 0) / losing.length;
    const gap = Math.max(0, losingMax - avgLosing); // bigger gap = stronger
    const pctScore = Math.min(100, (gap / (losingMax - Math.max(0, losingIdeal - 5))) * 100);

    // 2. Bar alignment: green & blue on winning side
    const alignScore =
      (winning.includes(stats.ranking.green) ? 50 : 0) +
      (winning.includes(stats.ranking.blue) ? 50 : 0);

    // 3. Strength count: winning digits at/above winningStrong
    const strongCount = winning.filter((d) => stats.percentages[d] >= winningStrong).length;
    const countScore = Math.min(100, (strongCount / 2) * 100);

    return Math.round(
      pctScore * w.percentageStrength + alignScore * w.barAlignment + countScore * w.strengthCount
    );
  }

  _reverseScore(dominant, weak, stats) {
    const w = this.cfg.confidenceWeights;
    const { losingMax, winningStrong } = this.cfg.threshold;

    const avgDominant = dominant.reduce((a, d) => a + stats.percentages[d], 0) / dominant.length;
    const overboughtGap = Math.max(0, avgDominant - losingMax);
    const pctScore = Math.min(100, (overboughtGap / 5) * 100);

    const alignScore =
      (dominant.includes(stats.ranking.green) ? 50 : 0) +
      (dominant.includes(stats.ranking.blue) ? 50 : 0);

    const overboughtCount = dominant.filter((d) => stats.percentages[d] >= winningStrong).length;
    const countScore = Math.min(100, (overboughtCount / 3) * 100);

    return Math.round(
      pctScore * w.percentageStrength + alignScore * w.barAlignment + countScore * w.strengthCount
    );
  }
}

module.exports = StrategyEngine;
