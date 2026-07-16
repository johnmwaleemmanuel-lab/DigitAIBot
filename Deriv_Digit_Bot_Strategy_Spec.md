# Deriv Digit Trading Bot — Complete Strategy Specification
### (Automation-Ready, Zero-Ambiguity Build Document)

---

## 0. Operating Mode Selector (New)

Before the bot starts, the user selects one of two modes on the dashboard:

| Mode | Behavior |
|---|---|
| **A. Single Strategy Mode** | User manually selects ONE strategy (Over, Under, Even-Odd, or Reverse Psychology). Bot scans all markets but ONLY evaluates/trades that one chosen strategy. Recovery Mode (Step 8) and Conflict Resolution (Step 3) do not apply, since only one strategy is active. |
| **B. AI Mode (Full Automation)** | Bot runs all 4 strategies simultaneously across all markets, using Confidence Scoring (Step 5) to rank opportunities, Conflict Resolution (Step 3) when strategies overlap, and full Recovery Mode logic (Step 8). This is the default "hands-off" mode. |

Mode can be switched only while the bot is stopped (not mid-trade).

---

## 1. Strategy Objective

Build an automated trading bot that connects directly to Deriv's live tick feed and continuously scans for **three strategy families** (Over, Under, Even-Odd) plus a fourth contrarian overlay (Reverse Psychology), executing trades **only** when all rules for a strategy are fully met — no partial or guessed entries. A locally-hosted dashboard displays live digit stats, bar colors, confidence scores, and trade activity in real time. Goal: remove manual/emotional decision-making entirely.

---

## 2. Market and Timeframe

- **Markets scanned (all, simultaneously):**
  - Plain Volatility Indices: Vol 10, 25, 50, 75, 100
  - Volatility Indices in Seconds: Vol 10(1s), 25(1s), 50(1s), 75(1s), 100(1s)
  - Jump Indices: Jump 10, 25, 50, 75, 100
- **Timeframe:** Tick-based (live tick stream), not OHLC candles.
- **Tick confirmation window (contract duration):**
  - Plain Volatility Indices → 1 tick
  - Jump Indices & Seconds Volatilities → 2 ticks (new accounts) / 3 ticks (old accounts)
  - **Auto-detected** by account age; **user-editable override** per market.
- **Sample window for digit statistics:** default **1000 ticks**, user-editable.
- **Market ranking:** In AI Mode, all qualifying markets are scored (Step 5) and the highest-confidence valid setup is selected.

---

## 3. Pattern Definitions

### Shared Elements (all strategies)
- **Bar legend** (based on last-digit frequency ranking over the sample window):
  - 🟩 Green = most appearing digit
  - 🟦 Blue = 2nd most appearing digit
  - 🟨 Yellow = 2nd least appearing digit
  - 🟥 Red = least appearing digit
- **Percentage threshold:** losing-side digits should read below **10.5%** (ideal: below **10%**); winning-side digits should read above 10.5%.

### 3.1 Over Strategy
- Winning digits: 3–9 (Over 2) or 4–9 (Over 3). Losing digits: 0,1,2 (or 0,1,2,3).
- Setup valid when losing-side digits are declining/<10.5%.
- Entry trigger: 3 consecutive losing digits (0,1,2 in any order) → then 1 winning digit (3–9) → enter immediately.
- **Exclusion:** Digits 0 and 9 may never be used as the entry-point trigger or confirmation digit.

### 3.2 Under Strategy
- Winning digits: 0–6 (Under 7) or 0–5 (Under 6). Losing digits: 7,8,9 (or 6,7,8,9).
- Setup valid when losing-side digits are declining/<10.5%.
- Entry trigger: 3 consecutive losing digits (7,8,9 in any order) → then 1 winning digit (0–6) → enter immediately.
- **Exclusion:** Digits 0 and 9 may never be used as the entry-point trigger or confirmation digit.

### 3.3 Even-Odd Strategy
- Winning side: Even digits (0,2,4,6,8) — always the traded side.
- Losing/entry-zone side: Odd digits (1,3,5,7,9).
- Setup valid when all 5 Odd digits read <10.5%, EXCEPT exactly one that breaks above 10.5%.
- Entry trigger: the one Odd digit above 10.5% = entry point, AND the immediately preceding tick's digit must also be Odd → enter Even immediately.
- (No 0/9 exclusion here — this strategy uses its own digit logic as defined in source notes.)

### 3.4 Reverse Psychology Strategy (Contrarian)
- Trades AGAINST the currently overcrowded side.
- **Trigger A — Red Bar Reversal:** dominant side's Blue/Green/Yellow bars remain in place, but the Red Bar shifts to the weak side → enter weak side using that digit.
- **Trigger B — Percentage Recovery:** one digit on the weak side recovers above 10.5% while the dominant side is still overbought → enter weak side using that digit.
- Applies symmetrically whether Even or Odd side is currently overcrowded.

### 3.5 Over/Under Strategy 2 (Single-Tap Variant)
A second, faster-entry Over/Under variant, distinct from 3.1/3.2:
- **OVER 3 v2:** digits 0,1,2,3 must each read below 10%, OR — if at/above 10% — must be trending down vs. the previous scan cycle. The Green Bar (most-appearing digit) must sit among the winning digits (4–9); the Red Bar (least-appearing digit) must sit among the losing digits (0–3). Entry: the instant a tick lands on 0, 1, 2, or 3 — enter OVER 3 immediately (single tap, not a 3-tick sequence).
- **UNDER 7 v2:** mirrored — losing digits 7,8,9 must read <10% or be trending down at/above 10%; Green Bar among 0–6; Red Bar among 7–9. Entry: the instant a tick lands on 7, 8, or 9 — enter UNDER 7 immediately.
- Scored using the same 50/30/20 confidence weighting as all other strategies (Step 5).
- Treated as a momentum strategy for Conflict Resolution (3.6) and Recovery Mode (Step 8) purposes.

### 3.6 Conflict Resolution (AI Mode only)
- If a market simultaneously qualifies for a momentum strategy (Over/Under/Even-Odd) AND Reverse Psychology, the bot calculates a confidence score (Step 5) for each and **executes the highest-scoring one**. The non-selected qualifying strategy is logged but not traded.

---

## 4. Entry Logic

1. Bot scans live tick data continuously per market (per selected Mode).
2. When an entry trigger condition fires (Step 3) for one or more strategies on a market:
   - Single Strategy Mode → trade if the chosen strategy's trigger fires.
   - AI Mode → if multiple strategies qualify, compare confidence scores (Step 5), trade the highest.
3. Entry executes **immediately on the next tick** — no additional gating checks (no balance/spread delay).
4. Contract placed = Digit contract (Over/Under/Even/Odd matching the strategy).
5. **Tick duration:** auto-set by strategy/market rules (Step 2), user-editable.
6. **Stake:** user-configured base amount (default $0.35), modified by Martingale state if applicable (Step 9).

---

## 5. Confirmation Logic (Confidence Scoring)

Each qualifying market/strategy combination is scored 0–100:

| Factor | Weight | Definition |
|---|---|---|
| **Percentage Strength** | 50% | How far losing-side digits sit below 10.5% (best <10%) — sliding scale, further below = higher score |
| **Bar Alignment** | 30% | Green & Blue bars confirmed on the winning side |
| **Winning-Side Strength Count** | 20% | 2+ winning-side digits reading 11%+ (fallback: digits in 10–10.7% range trending up score lower but still valid) |

- A trade only fires if it first passes the **mandatory minimum gate** (losing digits <10.5% AND entry trigger pattern completed). The score then ranks *among* already-valid setups — it never overrides the minimum requirement.
- Used for: (a) selecting the best market in AI Mode, (b) resolving Conflict Rule ties between momentum and Reverse Psychology.

---

## 6. Trade Management

- **Single active trade at a time** — no concurrent trades across markets, in either mode.
- Scanning **never stops**, even while a trade is active — confidence scores keep recalculating in the background.
- **On trade completion (win or loss):**
  - Bot re-evaluates all markets.
  - AI Mode: switches to the new highest-scoring market/strategy if it now exceeds the current one.
  - Single Strategy Mode: continues scanning only within the chosen strategy.
- **No early exit / no cancellation mid-trade** (Digit contracts run to expiry).

---

## 7. Exit Logic (Session-Level)

Individual trades always resolve automatically at contract expiry — no manual closing of a live contract.

- **Manual Exit:** Dashboard "Exit/Stop" button — bot finishes the current active trade to completion, then halts all scanning/trading (no new trades opened).
- **Automatic Exit Conditions** (only two triggers, both user-configurable fixed $ amounts):
  - **Target Profit reached** → bot stops trading for the session.
  - **Target Stop-Loss (SL) reached** → bot stops trading for the session.
- Once either trigger fires, behavior mirrors manual exit: finish active trade, then stop.

---

## 8. Re-entry Logic

**After a win:**
- Bot immediately resumes scanning (per active Mode) and re-enters on the next valid highest-score setup — no cooldown.

**Loss Recovery Flow (AI Mode only — requires multi-strategy context):**
- **Consecutive-loss threshold:** default **2**, user-editable.
- Recovery Mode triggers **only** when the losses occurred while trading **Over/Under or Reverse Psychology** (i.e., switching *into* Even-Odd as the recovery vehicle).
- If losses occurred while already trading **Even-Odd**, this is NOT a mode switch — standard Martingale (Step 9) applies directly, no special recovery logic.
- Recovery Mode behavior: switch to Even-Odd → pick highest-confidence-score market → apply Martingale stake progression.
  - Win during recovery → reset stake, exit Recovery Mode, resume normal multi-strategy scanning.
  - Loss during recovery → remain in Recovery Mode, increase Martingale stake again, retry Even-Odd → repeats until a win **or** Target SL halts the bot.
- **Single Strategy Mode:** Recovery Mode does not apply (there is no other strategy to switch to); standard Martingale progression applies on losses within the chosen strategy.

---

## 9. Risk Management

- **Base stake:** default **$0.35**, user-editable.
- **Martingale multiplier:** default **2x** stake after each loss, **no maximum step cap**, user-editable multiplier.
- **Target Profit:** fixed **$ amount**, user-editable — halts bot when reached (Step 7).
- **Target Stop-Loss:** fixed **$ amount**, user-editable — halts bot when reached (Step 7). This is the **only safety net** against uncapped Martingale growth — must be set deliberately by the user.
- **Recovery Mode Martingale:** same 2x default rule applies within Even-Odd recovery trades (Step 8), stacking on prior losses already taken in the sequence.

---

## 10. Exception Handling

1. **Connection drop (mid-trade or otherwise):** Bot auto-reconnects immediately once back online → queries Deriv API for the pending/completed contract result → updates win/loss state, consecutive-loss counter, and Profit/Loss totals accordingly → only then resumes scanning/trading.
2. **Digit 0 & 9 exclusion:** Applies **only to Over/Under strategy** — digits 0 and 9 may never be used as the entry-point trigger or confirmation digit. Does not apply to Even-Odd or Reverse Psychology.
3. **No valid setup found:** Bot keeps scanning silently in the background; dashboard shows a live **"No Signal — Scanning..."** status.
4. **Deriv API rejects a trade** (market closed, insufficient balance, stake limits, etc.): Bot logs the error to the dashboard/history and keeps scanning — does not halt.

---

## 11. Complete Automation-Ready Decision Flow

```
START
 │
 ├─► User selects Mode: [Single Strategy: X] or [AI Mode: All 4]
 │
 ├─► LOOP (continuous, while bot is running):
 │
 │    ├─► IF a trade is currently active:
 │    │      → Skip entry logic, continue background scanning/scoring only
 │    │      → Wait for contract expiry
 │    │      → On result (win/loss): update stats, go to RE-ENTRY CHECK
 │    │
 │    ├─► IF no trade active:
 │    │      → SCAN all markets' live tick streams (last 1000 ticks, editable)
 │    │      → For each market, compute digit % distribution + bar rankings
 │    │
 │    │      → FOR each strategy active in current Mode:
 │    │           → Check mandatory gate (losing digits <10.5%, entry trigger pattern present)
 │    │           → IF gate passed: compute Confidence Score (50/30/20 weighting)
 │    │
 │    │      → IF zero markets/strategies pass gate:
 │    │           → Dashboard: "No Signal — Scanning..." → loop again (silent)
 │    │
 │    │      → IF one or more pass gate:
 │    │           → IF Single Strategy Mode: pick highest-score valid market for chosen strategy
 │    │           → IF AI Mode:
 │    │                → IF a market qualifies for BOTH a momentum strategy AND Reverse Psychology:
 │    │                     → Compare their scores → select higher one (Conflict Rule)
 │    │                → Rank all remaining valid candidates by score → select global highest
 │    │
 │    │      → CHECK Re-entry/Recovery state:
 │    │           → IF Recovery Mode is active (2+ consecutive losses from Over/Under/Reverse Psych, AI Mode only):
 │    │                → Force strategy = Even-Odd, highest-score market, apply Martingale stake
 │    │           → ELSE: use normally selected strategy/market, apply current stake
 │    │                (base stake, or Martingale-adjusted if prior loss in same strategy)
 │    │
 │    │      → PLACE TRADE:
 │    │           → Contract = Digit type matching strategy
 │    │           → Duration = auto tick count (editable)
 │    │           → Stake = base or Martingale-adjusted
 │    │           → Execute immediately on next tick
 │    │
 │    │      → IF API rejects trade: log error, do NOT halt, loop again
 │
 ├─► ON TRADE RESULT (win/loss):
 │      → Update running Profit/Loss totals
 │      → IF WIN:
 │           → Reset Martingale stake to base
 │           → IF was in Recovery Mode: exit Recovery Mode
 │           → Reset consecutive-loss counter
 │      → IF LOSS:
 │           → Increment consecutive-loss counter
 │           → Apply Martingale multiplier (default 2x) to next stake
 │           → IF consecutive-loss counter ≥ threshold (default 2) AND strategy ∈ {Over, Under, Reverse Psychology} AND AI Mode:
 │                → Enter Recovery Mode (force Even-Odd next trade)
 │
 ├─► CHECK EXIT CONDITIONS (after every trade result):
 │      → IF Target Profit reached OR Target SL reached OR Manual Exit pressed:
 │           → Finish current trade if any is active (already handled above)
 │           → HALT — stop scanning, stop trading
 │      → ELSE: loop back to SCAN
 │
 ├─► ON CONNECTION LOSS (any point):
 │      → Attempt reconnect immediately
 │      → On reconnect: query API for last known contract result → sync state → resume loop
 │
END (only via Manual Exit, Target Profit, or Target SL)
```

---

## Summary of User-Editable Settings

| Setting | Default | Editable |
|---|---|---|
| Sample window (ticks) | 1000 | ✅ |
| Tick confirmation duration | Auto (1 / 2-3 by account age) | ✅ |
| Base stake | $0.35 | ✅ |
| Martingale multiplier | 2x | ✅ |
| Martingale max steps | None (uncapped) | ✅ |
| Consecutive-loss recovery threshold | 2 | ✅ |
| Target Profit | User-set ($) | ✅ |
| Target Stop-Loss | User-set ($) | ✅ |
| Operating Mode | Single Strategy / AI Mode | ✅ |
