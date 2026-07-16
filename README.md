# Deriv Digit AI Bot

Automation-ready trading bot for Deriv digit contracts — Over/Under, Even-Odd,
and Reverse Psychology strategies — with an AI Mode that runs all four
strategies simultaneously, confidence-scores every market, and auto-selects
the best trade. Includes Martingale recovery, risk caps, and a live animated
dashboard.

## 1. Install

```bash
npm install
```

## 2. One-time Deriv OAuth setup (required before first login)

This bot now uses **Deriv OAuth** instead of manual App ID / API Token entry.
Before the "Connect with Deriv" button will work, you must register the
redirect URL for your app once, in Deriv's app management dashboard —
matching wherever you're actually running this (localhost, or a deployed
URL like Render).

1. Go to Deriv's API app management page and open the app matching the
   App ID in `config.json` (`deriv.appId`).
2. Set its **Redirect URL** to exactly:
   - Local: `http://localhost:4040/auth/deriv/callback`
   - Deployed (e.g. Render): `https://YOUR-APP-NAME.onrender.com/auth/deriv/callback`
3. Save it.

**The App ID in `config.json` must be the one actually registered with
that redirect URL.** If they don't match, Deriv will authenticate you but
has nowhere valid to send you back — you'll just stay on Deriv's own
site after approving. This is the #1 cause of "Connect with Deriv
doesn't come back to my app."

This registration is a one-time step on Deriv's side — the bot cannot
automate it, since Deriv ties each app's OAuth redirect to a
pre-registered URL rather than accepting it as a request parameter.

## 3. Run

### Locally
```bash
npm start
```
Then open **http://localhost:4040**.

### Deployed (e.g. Render)
Set the `PUBLIC_URL` environment variable to your deployed URL (used only
for an accurate startup log message — it doesn't change OAuth behavior,
which relies entirely on what's registered on Deriv's side):
```
PUBLIC_URL=https://digitaibot.onrender.com
```
Render sets `PORT` automatically — no change needed there.

**⚠️ Important if deploying to Render's free/standard tier:** its disk is
usually **ephemeral** — files written at runtime (`data/session.json`,
`data/trade_history.jsonl`) can be wiped on redeploy or a restart/spin-down.
That means your login session and trade history may not survive a Render
restart unless you attach a **persistent disk** (Render's paid disk
add-on, mounted at a path you then point `SessionStore`/`TradeHistoryStore`
at). Worth knowing before you rely on long-running history for evaluation.

Click **"Connect with Deriv"** on whichever URL you're running.

- If your Deriv login has multiple accounts (e.g. real + demo), you'll
  see a quick picker so you choose which one to use — the bot never
  silently picks a real-money account for you.
- Your account ID, account type, and live balance are fetched and shown
  automatically once connected.
- The session is saved locally (`data/session.json`) so you stay logged
  in across restarts — press **"Disconnect / Logout"** to clear it and
  require signing in again.

## 4. Using the dashboard

- **AI Mode** (default) — runs Over, Under, Even-Odd, and Reverse Psychology
  together, ranks every market by confidence score, and trades the best one.
  You can also click the floating **AI orb** button (bottom-right) at any
  time to jump straight into AI Mode and start the bot.
- **Single Strategy Mode** — lock the bot to one specific strategy.
- **Settings drawer** — edit base stake, Martingale multiplier, target
  profit/stop-loss, tick sample window, and the consecutive-loss recovery
  threshold, all live.
- **Exit / Stop** — finishes any active trade, then halts the bot.

## 5. Important notes

- Account type (demo vs real) is determined by **which Deriv account you
  authorize with**, shown live in the dashboard header and account panel.
  Double-check you're on the account you intend before trading — especially
  before switching to a **real** account.
- Martingale has **no maximum step cap** by default — your Target
  Stop-Loss is the only safety net against a losing streak. Set it
  deliberately.
- All strategy rules (entry triggers, percentage thresholds, bar logic,
  confidence weighting, recovery logic) implement the specification we
  locked step-by-step — see `Deriv_Digit_Bot_Strategy_Spec.md` for the
  full written spec this bot was built from, including the newer
  **Over/Under Strategy 2** (single-tap entry variant).

## 6. Trade History & Evaluation

- Every completed trade is **persisted to disk** at
  `data/trade_history.jsonl` (one JSON line per trade) — it survives
  bot restarts and page refreshes, and reloads automatically when the
  dashboard reconnects.
- The dashboard's **"Trade History & Evaluation"** panel shows: total
  trades, win rate, total P/L, best-performing strategy, a cumulative
  P/L chart, and a full sortable-by-time table (market, strategy,
  confidence, stake, result, profit).

## 7. Account switching & logout

- To switch Deriv accounts, click **"Disconnect / Logout"** — this clears
  the saved session (`data/session.json`) and disconnects the bot. You'll
  need to click "Connect with Deriv" and authorize again to reconnect
  (optionally with a different Deriv account).
- Logging out never auto-reconnects — that's intentional, so a logout is
  a real logout.

## 8. Known limitations (being upfront about these)

- **Market closures / weekends:** some symbols (indices tracking real
  markets) close on weekends. If a subscribe/history request fails for
  a closed or temporarily unavailable symbol, the bot logs it, shows
  "Closed / unavailable" on that market's card, and simply skips it —
  it does not halt or retry aggressively.
- **API rate limits:** startup/reconnect now subscribes to each market
  with a small stagger (150ms apart) rather than firing all ~15 at
  once, to reduce the chance of hitting Deriv's rate limits. This has
  **not been stress-tested against Deriv's actual limits** — if you
  increase the sample window significantly or add more markets, watch
  the log panel for rate-limit warnings and let me know if you hit any.
- This bot has not been run against a live Deriv connection from my
  side (no network access in my build environment) — the API calls are
  built correctly against Deriv's documented WebSocket API, but please
  test on your demo account first and report anything that errors.

