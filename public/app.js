'use strict';

const socket = io();

// ---------- Petal background ----------
(function spawnPetals() {
  const field = document.getElementById('petalField');
  const COUNT = 18;
  for (let i = 0; i < COUNT; i++) {
    const p = document.createElement('div');
    p.className = 'petal';
    p.style.left = Math.random() * 100 + 'vw';
    const duration = 10 + Math.random() * 12;
    const swayDuration = 3 + Math.random() * 3;
    p.style.animationDuration = `${duration}s, ${swayDuration}s`;
    p.style.animationDelay = `${Math.random() * 10}s, 0s`;
    p.style.opacity = 0.15 + Math.random() * 0.3;
    field.appendChild(p);
  }
})();

// ---------- State ----------
let currentMode = 'AI';
const marketCards = new Map(); // symbol -> DOM node

// ---------- Elements ----------
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');
const modeAiBtn = document.getElementById('modeAiBtn');
const modeSingleBtn = document.getElementById('modeSingleBtn');
const singleSelectWrap = document.getElementById('singleSelectWrap');
const singleStrategySelect = document.getElementById('singleStrategySelect');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const sessionPL = document.getElementById('sessionPL');
const currentStakeEl = document.getElementById('currentStake');
const consecLossesEl = document.getElementById('consecLosses');
const recoveryBadge = document.getElementById('recoveryBadge');
const scanStatusEl = document.getElementById('scanStatus');
const marketGrid = document.getElementById('marketGrid');
const feed = document.getElementById('feed');
const aiFab = document.getElementById('aiFab');
const marketCardTpl = document.getElementById('marketCardTpl');

// ---------- Deriv OAuth ----------
const connectDerivBtn = document.getElementById('connectDerivBtn');
const logoutBtn = document.getElementById('logoutBtn');
const loggedOutView = document.getElementById('loggedOutView');
const loggedInView = document.getElementById('loggedInView');
const acctIdDisplay = document.getElementById('acctIdDisplay');
const acctTypeBadge = document.getElementById('acctTypeBadge');
const acctBalanceDisplay = document.getElementById('acctBalanceDisplay');
const topAccountType = document.getElementById('topAccountType');
const topAccountId = document.getElementById('accountId');

connectDerivBtn.addEventListener('click', () => {
  window.location.href = '/auth/deriv/login';
});

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true;
  logoutBtn.textContent = 'Logging out…';
  try {
    await fetch('/auth/deriv/logout', { method: 'POST' });
  } finally {
    window.location.reload();
  }
});

let isLoggedIn = false;
let isRunning = false;
function refreshRunControls() {
  startBtn.disabled = isRunning || !isLoggedIn;
  stopBtn.disabled = !isRunning;
}

function renderAccountUI({ loggedIn, accountId, accountType, balance, currency }) {
  isLoggedIn = !!loggedIn;
  loggedOutView.style.display = loggedIn ? 'none' : 'block';
  loggedInView.style.display = loggedIn ? 'block' : 'none';

  if (loggedIn) {
    acctIdDisplay.textContent = accountId || '—';
    acctTypeBadge.textContent = (accountType || '—').toUpperCase();
    acctTypeBadge.className = 'account-type-badge' + (accountType === 'real' ? ' real' : '');
    acctBalanceDisplay.textContent = balance != null ? `${Number(balance).toFixed(2)} ${currency || ''}`.trim() : '—';

    topAccountId.textContent = accountId || '—';
    topAccountType.textContent = (accountType || '—').toUpperCase();
  } else {
    topAccountId.textContent = 'Not connected';
    topAccountType.textContent = '—';
  }
  refreshRunControls();
}

// ---------- Mode switching ----------
function setModeUI(mode) {
  currentMode = mode;
  modeAiBtn.classList.toggle('active', mode === 'AI');
  modeSingleBtn.classList.toggle('active', mode === 'SINGLE');
  singleSelectWrap.style.display = mode === 'SINGLE' ? 'block' : 'none';
  aiFab.classList.toggle('engaged', mode === 'AI');
}

modeAiBtn.addEventListener('click', () => {
  setModeUI('AI');
  socket.emit('setMode', { mode: 'AI' });
});
modeSingleBtn.addEventListener('click', () => {
  setModeUI('SINGLE');
  socket.emit('setMode', { mode: 'SINGLE', singleStrategy: singleStrategySelect.value });
});
singleStrategySelect.addEventListener('change', () => {
  if (currentMode === 'SINGLE') {
    socket.emit('setMode', { mode: 'SINGLE', singleStrategy: singleStrategySelect.value });
  }
});

// ---------- Floating AI button ----------
aiFab.addEventListener('click', () => {
  setModeUI('AI');
  socket.emit('setMode', { mode: 'AI' });
  if (startBtn && !startBtn.disabled) {
    socket.emit('startBot');
  }
  aiFab.classList.remove('engaged');
  void aiFab.offsetWidth; // restart animation
  aiFab.classList.add('engaged');
});

// ---------- Start / Stop ----------
startBtn.addEventListener('click', () => {
  socket.emit('startBot');
  startBtn.disabled = true;
  stopBtn.disabled = false;
});
stopBtn.addEventListener('click', () => {
  socket.emit('stopBot');
  stopBtn.disabled = true;
  startBtn.disabled = false;
});

// ---------- Settings ----------
document.getElementById('saveSettingsBtn').addEventListener('click', () => {
  socket.emit('updateSettings', {
    stakeBase: document.getElementById('setStake').value,
    martingaleMultiplier: document.getElementById('setMartingale').value,
    targetProfit: document.getElementById('setTP').value,
    targetStopLoss: document.getElementById('setSL').value,
    sampleWindow: document.getElementById('setSample').value,
    consecutiveLossThreshold: document.getElementById('setLossTrigger').value,
  });
});

// ---------- Feed helper ----------
function addFeedItem(html, cls = '') {
  const item = document.createElement('div');
  item.className = `feed-item ${cls}`;
  const ts = new Date().toLocaleTimeString();
  item.innerHTML = `<span class="ts">${ts}</span>${html}`;
  feed.prepend(item);
  while (feed.children.length > 120) feed.removeChild(feed.lastChild);
}

// ---------- Market card helpers ----------
function ensureMarketCard(symbol) {
  if (marketCards.has(symbol)) return marketCards.get(symbol);
  const node = marketCardTpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.market-name').textContent = symbol;

  const barsWrap = node.querySelector('.digit-bars');
  for (let d = 0; d <= 9; d++) {
    const col = document.createElement('div');
    col.className = 'digit-bar-col';
    col.innerHTML = `<div class="digit-bar" data-digit="${d}" style="height:2%"></div><span class="digit-label">${d}</span>`;
    barsWrap.appendChild(col);
  }

  marketGrid.appendChild(node);
  marketCards.set(symbol, node);
  return node;
}

function updateConfidenceRing(node, score) {
  const ring = node.querySelector('.ring-fg');
  const offset = 100 - Math.max(0, Math.min(100, score));
  ring.style.strokeDashoffset = offset;
  node.querySelector('.confidence-num').textContent = Math.round(score);
}

// ---------- Socket events ----------
socket.on('config', (cfg) => {
  const all = cfg.markets || [];
  all.forEach((m) => ensureMarketCard(m.symbol));
  setModeUI(cfg.mode || 'AI');
  if (cfg.singleStrategy) singleStrategySelect.value = cfg.singleStrategy;
  if (cfg.stake) {
    document.getElementById('setStake').value = cfg.stake.base;
    document.getElementById('setMartingale').value = cfg.stake.martingaleMultiplier;
  }
  if (cfg.risk) {
    document.getElementById('setTP').value = cfg.risk.targetProfit;
    document.getElementById('setSL').value = cfg.risk.targetStopLoss;
  }
});

socket.on('session', (session) => {
  renderAccountUI({
    loggedIn: session.loggedIn,
    accountId: session.accountId,
    accountType: session.accountType,
  });
});

let lastAccountInfo = {};
socket.on('accountInfo', (info) => {
  lastAccountInfo = info;
  renderAccountUI({
    loggedIn: true,
    accountId: info.loginid,
    accountType: info.isVirtual ? 'demo' : 'real',
    balance: info.balance,
    currency: info.currency,
  });
});

socket.on('balanceUpdate', ({ balance, currency }) => {
  lastAccountInfo.balance = balance;
  acctBalanceDisplay.textContent = `${Number(balance).toFixed(2)} ${currency || ''}`.trim();
});

socket.on('authError', ({ message }) => {
  addFeedItem(`⚠ Deriv authorization failed: ${message}. Please reconnect.`, 'error');
  renderAccountUI({ loggedIn: false });
});

socket.on('status', ({ connected }) => {
  connDot.className = 'pulse-dot ' + (connected ? 'online' : 'offline');
  connText.textContent = connected ? 'Connected to Deriv' : 'Disconnected';
});

socket.on('log', ({ level, message }) => {
  const cls = level === 'error' ? 'error' : '';
  addFeedItem(message, cls);
});

socket.on('scanStatus', ({ status }) => {
  if (status === 'no-signal') {
    scanStatusEl.textContent = 'No Signal — Scanning…';
    scanStatusEl.classList.remove('active');
  } else if (status === 'trade-active') {
    scanStatusEl.textContent = 'Trade Active';
    scanStatusEl.classList.add('active');
  }
});

socket.on('scanUpdate', ({ candidates }) => {
  scanStatusEl.textContent = candidates.length ? `${candidates.length} signal(s) found` : 'No Signal — Scanning…';
  scanStatusEl.classList.toggle('active', candidates.length > 0);

  // reset all cards to neutral, then mark hot ones
  marketCards.forEach((node) => {
    node.classList.remove('signal-hot');
    const tag = node.querySelector('.signal-tag');
    tag.textContent = 'No signal';
    tag.className = 'signal-tag none';
  });

  candidates.forEach((c) => {
    const node = ensureMarketCard(c.symbol);
    node.classList.add('signal-hot');
    updateConfidenceRing(node, c.confidence);
    const tag = node.querySelector('.signal-tag');
    tag.textContent = `${c.strategy} · ${c.confidence}%`;
    tag.className = 'signal-tag hot';
  });
});

socket.on('tick', ({ symbol }) => {
  const node = marketCards.get(symbol);
  if (node) {
    node.style.transition = 'none';
  }
});

socket.on('marketStats', ({ marketStats }) => {
  marketStats.forEach(({ symbol, percentages, ranking }) => {
    const node = ensureMarketCard(symbol);
    const colorFor = {};
    colorFor[ranking.green] = 'green';
    colorFor[ranking.blue] = 'blue';
    colorFor[ranking.yellow] = 'yellow';
    colorFor[ranking.red] = 'red';

    percentages.forEach((pct, digit) => {
      const bar = node.querySelector(`.digit-bar[data-digit="${digit}"]`);
      if (!bar) return;
      const heightPct = Math.max(2, Math.min(100, pct * 4)); // scaled for visibility
      bar.style.height = `${heightPct}%`;
      bar.className = 'digit-bar' + (colorFor[digit] ? ` ${colorFor[digit]}` : '');
      bar.title = `${pct.toFixed(1)}%`;
    });
  });
});

socket.on('tradePlaced', (t) => {
  addFeedItem(`Trade placed: <b>${t.strategy}</b> on <b>${t.symbol}</b> — stake $${t.stake.toFixed(2)}, confidence ${t.confidence}%`);
});

socket.on('tradeRejected', (t) => {
  addFeedItem(`Trade rejected on ${t.symbol}: ${t.error}`, 'error');
});

socket.on('tradeResult', (r) => {
  addFeedItem(
    `${r.won ? '✅ WIN' : '❌ LOSS'} on <b>${r.symbol}</b>: ${r.profit >= 0 ? '+' : ''}$${r.profit.toFixed(2)} | Session P/L $${r.sessionProfit.toFixed(2)}`,
    r.won ? 'win' : 'loss'
  );
});

socket.on('stateUpdate', (s) => {
  sessionPL.textContent = `$${s.sessionProfit.toFixed(2)}`;
  sessionPL.style.color = s.sessionProfit >= 0 ? 'var(--green)' : 'var(--red)';
  currentStakeEl.textContent = `$${s.currentStake.toFixed(2)}`;
  consecLossesEl.textContent = s.consecutiveLosses;
  recoveryBadge.textContent = s.recoveryMode ? 'ACTIVE' : 'OFF';
  recoveryBadge.className = 'metric-value ' + (s.recoveryMode ? 'badge-on' : 'badge-off');

  isRunning = s.running;
  refreshRunControls();
});

socket.on('stopped', ({ reason }) => {
  addFeedItem(`Bot stopped: ${reason}`, 'error');
  isRunning = false;
  refreshRunControls();
});

socket.on('marketUnavailable', ({ symbol, reason }) => {
  addFeedItem(`⚠ ${symbol} unavailable right now (${reason}) — skipping, will retry automatically`, 'warn');
  const node = marketCards.get(symbol);
  if (node) {
    const tag = node.querySelector('.signal-tag');
    tag.textContent = 'Closed / unavailable';
    tag.className = 'signal-tag none';
  }
});

// ---------- Trade History: stats, cumulative P/L chart, table ----------
const hTotal = document.getElementById('hTotal');
const hWinRate = document.getElementById('hWinRate');
const hTotalPL = document.getElementById('hTotalPL');
const hBestStrategy = document.getElementById('hBestStrategy');
const historyTableBody = document.getElementById('historyTableBody');
const plCanvas = document.getElementById('plChart');
const plCtx = plCanvas.getContext('2d');

function renderHistoryStats(stats) {
  hTotal.textContent = stats.totalTrades;
  hWinRate.textContent = `${stats.winRate.toFixed(1)}%`;
  hTotalPL.textContent = `$${stats.totalProfit.toFixed(2)}`;
  hTotalPL.style.color = stats.totalProfit >= 0 ? 'var(--green)' : 'var(--red)';

  let best = '—';
  let bestProfit = -Infinity;
  Object.entries(stats.byStrategy || {}).forEach(([name, s]) => {
    if (s.profit > bestProfit) {
      bestProfit = s.profit;
      best = `${name} ($${s.profit.toFixed(2)})`;
    }
  });
  hBestStrategy.textContent = best;
}

function renderHistoryTable(trades) {
  historyTableBody.innerHTML = '';
  if (!trades.length) {
    historyTableBody.innerHTML = '<tr class="history-empty-row"><td colspan="8">No trades yet — start the bot to begin building history.</td></tr>';
    return;
  }
  // newest first
  const rows = trades.slice(-200).reverse();
  rows.forEach((t) => {
    const tr = document.createElement('tr');
    tr.className = t.won ? 'win' : 'loss';
    tr.innerHTML = `
      <td>${new Date(t.ts).toLocaleTimeString()}</td>
      <td>${t.symbol}</td>
      <td>${t.strategy || '—'}${t.barrier ? ' (' + t.barrier + ')' : ''}</td>
      <td>${t.confidence != null ? t.confidence + '%' : '—'}</td>
      <td>$${t.stake.toFixed(2)}</td>
      <td>${t.won ? 'WIN' : 'LOSS'}</td>
      <td>${t.profit >= 0 ? '+' : ''}$${t.profit.toFixed(2)}</td>
      <td>$${t.sessionProfit.toFixed(2)}</td>`;
    historyTableBody.appendChild(tr);
  });
}

function renderPLChart(trades) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = plCanvas.clientWidth || plCanvas.parentElement.clientWidth;
  const cssHeight = 120;
  plCanvas.width = cssWidth * dpr;
  plCanvas.height = cssHeight * dpr;
  plCanvas.style.height = cssHeight + 'px';
  plCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  plCtx.clearRect(0, 0, cssWidth, cssHeight);

  if (!trades.length) {
    plCtx.fillStyle = '#8888a8';
    plCtx.font = '12px JetBrains Mono, monospace';
    plCtx.fillText('Cumulative P/L will appear here once trades start.', 10, cssHeight / 2);
    return;
  }

  const points = trades.map((t) => t.sessionProfit);
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const range = max - min || 1;
  const padding = 10;
  const stepX = (cssWidth - padding * 2) / Math.max(1, points.length - 1);

  const yFor = (v) => cssHeight - padding - ((v - min) / range) * (cssHeight - padding * 2);

  // zero line
  plCtx.strokeStyle = 'rgba(255,255,255,0.15)';
  plCtx.setLineDash([4, 4]);
  plCtx.beginPath();
  plCtx.moveTo(padding, yFor(0));
  plCtx.lineTo(cssWidth - padding, yFor(0));
  plCtx.stroke();
  plCtx.setLineDash([]);

  // gradient area fill
  const grad = plCtx.createLinearGradient(0, 0, 0, cssHeight);
  const positive = points[points.length - 1] >= 0;
  grad.addColorStop(0, positive ? 'rgba(53,224,161,0.35)' : 'rgba(255,77,109,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  plCtx.beginPath();
  plCtx.moveTo(padding, yFor(points[0]));
  points.forEach((v, i) => plCtx.lineTo(padding + i * stepX, yFor(v)));
  plCtx.lineTo(padding + (points.length - 1) * stepX, cssHeight - padding);
  plCtx.lineTo(padding, cssHeight - padding);
  plCtx.closePath();
  plCtx.fillStyle = grad;
  plCtx.fill();

  // line
  plCtx.beginPath();
  plCtx.moveTo(padding, yFor(points[0]));
  points.forEach((v, i) => plCtx.lineTo(padding + i * stepX, yFor(v)));
  plCtx.strokeStyle = positive ? '#35e0a1' : '#ff4d6d';
  plCtx.lineWidth = 2;
  plCtx.stroke();
}

let lastTrades = [];
socket.on('historyUpdate', ({ trades, stats }) => {
  lastTrades = trades;
  renderHistoryStats(stats);
  renderHistoryTable(trades);
  renderPLChart(trades);
});

window.addEventListener('resize', () => renderPLChart(lastTrades));
