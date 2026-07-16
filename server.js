'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

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
// Deriv OAuth 2.0 flow — Authorization Code + PKCE
// (per Deriv's OAuth 2.0 guide: auth.deriv.com/oauth2/auth + /oauth2/token)
//
// IMPORTANT one-time setup (outside this code, on Deriv's side): the
// app registered under appId (config.json -> deriv.appId) must have its
// "Redirect URL" set, in Deriv's app management dashboard, to exactly:
//   REDIRECT_URI (see below)
// =====================================================================

const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = `${PUBLIC_URL}/auth/deriv/callback`;

// Holds in-flight PKCE code_verifier + state pairs while the user is on
// Deriv's site authenticating. Server-side equivalent of the browser's
// sessionStorage — a Node backend has no per-tab storage, and this is a
// single-user local bot, so an in-memory Map keyed by `state` is enough.
// Entries are single-use (deleted on callback) and expire after 10 minutes
// in case the user abandons the flow.
const pkceStore = new Map();
const PKCE_TTL_MS = 10 * 60 * 1000;

function base64url(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function beginPkceFlow() {
  const codeVerifier = base64url(crypto.randomBytes(64));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = crypto.randomBytes(16).toString('hex');
  pkceStore.set(state, { codeVerifier, createdAt: Date.now() });
  // Opportunistic cleanup of stale/abandoned attempts.
  for (const [key, val] of pkceStore) {
    if (Date.now() - val.createdAt > PKCE_TTL_MS) pkceStore.delete(key);
  }
  return { codeVerifier, codeChallenge, state };
}

function buildAuthorizeUrl({ codeChallenge, state, signup }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.deriv.appId,
    redirect_uri: REDIRECT_URI,
    scope: 'trade account_manage',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  if (signup) params.set('prompt', 'registration');
  return `https://auth.deriv.com/oauth2/auth?${params.toString()}`;
}

// Exchanges an authorization code for an access token. Must happen
// server-side — never expose this call or its result to the browser.
function exchangeCodeForToken({ code, codeVerifier }) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.deriv.appId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
    }).toString();

    const req = https.request(
      'https://auth.deriv.com/oauth2/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            return reject(new Error('Invalid response from Deriv token endpoint.'));
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.access_token) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error_description || parsed.error || 'Token exchange failed.'));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.get('/auth/deriv/login', (req, res) => {
  const { codeChallenge, state } = beginPkceFlow();
  res.redirect(buildAuthorizeUrl({ codeChallenge, state, signup: false }));
});

app.get('/auth/deriv/signup', (req, res) => {
  const { codeChallenge, state } = beginPkceFlow();
  res.redirect(buildAuthorizeUrl({ codeChallenge, state, signup: true }));
});

// Deriv redirects the browser here with ?code=...&state=... on success,
// or ?error=...&error_description=... if the user cancelled/denied.
app.get('/auth/deriv/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.redirect(`/?authError=${encodeURIComponent(errorDescription || error)}`);
  }
  if (!code || !state) {
    return res.redirect(`/?authError=${encodeURIComponent('Missing code or state in redirect.')}`);
  }

  const pending = pkceStore.get(state);
  pkceStore.delete(state); // single-use, whether or not it matches
  if (!pending) {
    return res.redirect(
      `/?authError=${encodeURIComponent('State mismatch or expired login attempt — please try again.')}`
    );
  }

  try {
    const { access_token: accessToken } = await exchangeCodeForToken({
      code,
      codeVerifier: pending.codeVerifier,
    });

    // The token exchange only gives us an access_token — no account id or
    // account type. Those come back from the Deriv WebSocket `authorize`
    // call, which BotController already performs and reconciles via the
    // 'sessionConfirmed' event (see the bot.on('sessionConfirmed', ...)
    // handler above), so we persist a minimal session for now.
    sessionStore.save({ accountId: null, token: accessToken, accountType: null });
    bot.applyCredentials({
      appId: cfg.deriv.appId,
      apiToken: accessToken,
      accountId: null,
      accountType: 'unknown',
    });
    res.redirect('/');
  } catch (e) {
    res.redirect(`/?authError=${encodeURIComponent(e.message)}`);
  }
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
  console.log(`Deriv Digit Bot dashboard running on port ${PORT}`);
  console.log(`Public URL: ${PUBLIC_URL}`);
  console.log(`Deriv OAuth redirect URL that must be registered on Deriv: ${REDIRECT_URI}`);
});
