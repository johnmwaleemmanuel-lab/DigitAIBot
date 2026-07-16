'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const fs = require('fs');

const BotController = require('./engine/BotController');
const SessionStore = require('./engine/SessionStore');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const bot = new BotController(cfg);
const sessionStore = new SessionStore();

const PORT = process.env.PORT || 4040;

// ---- Bridge bot events -> all connected dashboard clients ----
const forward = (event) => bot.on(event, (payload) => io.emit(event, payload));
[
  'log',
  'status',
  'tick',
  'scanUpdate',
  'marketStats',
  'scanStatus',
  'tradeAttempt',
  'tradePlaced',
  'tradeRejected',
  'tradeResult',
  'stateUpdate',
  'stopped',
  'marketUnavailable',
  'historyUpdate',
  'accountInfo',
  'balanceUpdate',
  'authError',
].forEach(forward);

// Whenever the Deriv `authorize` response confirms the real account
// id/type, persist that back into the saved session so it stays accurate.
bot.on('sessionConfirmed', ({ accountId, accountType }) => {
  const existing = sessionStore.load();
  if (existing) {
    existing.accountId = accountId;
    existing.accountType = accountType;
    sessionStore.save(existing);
  }
});

// =====================================================================
// Deriv OAuth flow
//
// IMPORTANT one-time setup (outside this code, on Deriv's side): the
// app registered under appId (config.json -> deriv.appId) must have its
// "Redirect URL" set, in Deriv's app management dashboard, to:
//   http://localhost:<PORT>/auth/deriv/callback
// Deriv's OAuth implementation redirects back to whatever URL was
// configured there — it is not passed as a query parameter here — so
// this bot cannot fully automate that one registration step.
// =====================================================================

app.get('/auth/deriv/login', (req, res) => {
  const authorizeUrl = `https://oauth.deriv.com/oauth2/authorize?app_id=${encodeURIComponent(
    cfg.deriv.appId
  )}`;
  res.redirect(authorizeUrl);
});

// Deriv redirects the browser here with ?acct1=...&token1=...&cur1=...
// (and acct2/token2/cur2, etc. if the user has multiple Deriv accounts).
// The actual parsing + account picking happens client-side in this page.
app.get('/auth/deriv/callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'oauth-callback.html'));
});

// Called by oauth-callback.html once the user has picked which Deriv
// account to use (or automatically, if only one was returned).
app.post('/auth/deriv/session', (req, res) => {
  const { accountId, token, accountType } = req.body || {};
  if (!accountId || !token) {
    return res.status(400).json({ ok: false, error: 'Missing accountId or token' });
  }
  sessionStore.save({ accountId, token, accountType: accountType || 'unknown' });
  bot.applyCredentials({
    appId: cfg.deriv.appId,
    apiToken: token,
    accountId,
    accountType: accountType || 'unknown',
  });
  res.json({ ok: true });
});

app.post('/auth/deriv/logout', (req, res) => {
  sessionStore.clear();
  bot.logout();
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  const session = sessionStore.load();

  socket.emit('config', {
    markets: bot.markets,
    mode: bot.mode,
    singleStrategy: bot.singleStrategy,
    stake: cfg.stake,
    risk: cfg.risk,
  });
  socket.emit('session', {
    loggedIn: !!session,
    accountId: session ? session.accountId : null,
    accountType: session ? session.accountType : null,
  });
  socket.emit('stateUpdate', bot._publicState());
  socket.emit('historyUpdate', bot.getHistory());
  if (bot.accountInfo) socket.emit('accountInfo', bot.accountInfo);

  socket.on('startBot', () => bot.start());
  socket.on('stopBot', () => bot.stop('User pressed Exit/Stop'));

  socket.on('setMode', ({ mode, singleStrategy }) => {
    bot.setMode(mode, singleStrategy);
    io.emit('stateUpdate', bot._publicState());
  });

  socket.on('updateSettings', (settings) => {
    if (settings.stakeBase) cfg.stake.base = Number(settings.stakeBase);
    if (settings.martingaleMultiplier)
      cfg.stake.martingaleMultiplier = Number(settings.martingaleMultiplier);
    if (settings.targetProfit) cfg.risk.targetProfit = Number(settings.targetProfit);
    if (settings.targetStopLoss) cfg.risk.targetStopLoss = Number(settings.targetStopLoss);
    if (settings.sampleWindow) bot.analyzer.setSampleWindow(Number(settings.sampleWindow));
    if (settings.consecutiveLossThreshold)
      cfg.recovery.consecutiveLossThreshold = Number(settings.consecutiveLossThreshold);
    io.emit('log', { level: 'info', message: 'Settings updated.', ts: Date.now() });
  });
});

// Auto-login on server startup if a saved session already exists —
// keeps the user logged in until they explicitly log out.
const existingSession = sessionStore.load();
if (existingSession) {
  bot.applyCredentials({
    appId: cfg.deriv.appId,
    apiToken: existingSession.token,
    accountId: existingSession.accountId,
    accountType: existingSession.accountType,
  });
}

server.listen(PORT, () => {
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`Deriv Digit Bot dashboard running on port ${PORT}`);
  console.log(`Public URL: ${publicUrl}`);
  console.log(`Deriv OAuth redirect URL that must be registered on Deriv: ${publicUrl}/auth/deriv/callback`);
});
