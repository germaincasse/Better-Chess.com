import { DEFAULT_SETTINGS, getSettings } from './lib/settings.js';
import { translateOpening } from './lib/openings.js';

const OFFSCREEN_URL = 'offscreen.html';
const IDLE_ALARM = 'close-engine';
const STATS_TTL = 15 * 60 * 1000;
const MAX_HISTORY = 300;
const MAX_REPORTS = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- engine host

let readyPromise = null;
/** analyzeGame calls not yet registered in `inflight` (settings and cache lookups). */
let starting = 0;
/** gameId -> promise of the report, while this service worker lives. */
const inflight = new Map();
/** jobId -> { resolve, reject }, settled by the offscreen "done" message. */
const pending = new Map();

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

function ensureOffscreen() {
  readyPromise ??= (async () => {
    if (!(await hasOffscreen())) {
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['WORKERS'],
          justification: 'Analyse Stockfish dans des Web Workers',
        });
      } catch (e) {
        // Another caller may have created it in the meantime.
        if (!(await hasOffscreen())) throw e;
      }
    }
    // The document's module script may not have registered its listener yet.
    for (let i = 0; i < 30; i++) {
      try {
        if ((await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' }))?.ok) return;
      } catch {}
      await sleep(100);
    }
    throw new Error('err.engineNotStarted');
  })().finally(() => {
    readyPromise = null;
  });
  return readyPromise;
}

function scheduleIdleClose() {
  chrome.alarms.create(IDLE_ALARM, { delayInMinutes: 5 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== IDLE_ALARM) return;
  if (starting > 0 || inflight.size > 0) return scheduleIdleClose();
  try {
    if (!(await hasOffscreen())) return;
    // Ask the document itself: it outlives this service worker, which may have restarted mid-job.
    const status = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' });
    if (status?.busy || starting > 0 || inflight.size > 0) return scheduleIdleClose();
    await chrome.offscreen.closeDocument();
  } catch {}
});

function sameParams(report, settings) {
  return (
    report.depth === settings.depth &&
    report.openingMoves === settings.openingMoves &&
    report.endgamePieces === settings.endgamePieces
  );
}

async function runJob(game, settings, tabId) {
  const jobId = crypto.randomUUID();
  const result = new Promise((resolve, reject) => pending.set(jobId, { resolve, reject }));
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'analyze', jobId, game, settings, tabId });
    if (!res?.ok) throw new Error('err.engineRejected');
  } catch (e) {
    pending.delete(jobId);
    throw e;
  }
  return result;
}

async function analyzeGame(game, tabId, force) {
  let job;
  starting++;
  try {
    const settings = await getSettings();
    if (!force) {
      const cached = await getReport(game.id);
      if (cached && sameParams(cached, settings)) return cached;
    }
    job = inflight.get(game.id);
    if (!job) {
      job = runJob(game, settings, tabId).finally(() => {
        inflight.delete(game.id);
        scheduleIdleClose();
      });
      inflight.set(game.id, job);
    }
  } finally {
    starting--;
  }
  return job;
}

async function onJobDone(msg) {
  if (msg.ok) {
    try {
      await storeReport(msg.report);
    } catch (e) {
      console.warn('Better Chess.com Free: report not stored', e);
    }
  }
  const waiter = pending.get(msg.jobId);
  pending.delete(msg.jobId);
  if (waiter) {
    if (msg.ok) waiter.resolve(msg.report);
    else waiter.reject(new Error(msg.error || 'err.analysisFailed'));
  } else if (msg.tabId != null) {
    // This service worker restarted during the job: nobody awaits it, tell the tab directly.
    const payload = { type: 'cce:done', gameId: msg.gameId, ok: msg.ok, report: msg.report, error: msg.error };
    chrome.tabs.sendMessage(msg.tabId, payload).catch(() => {});
  }
  scheduleIdleClose();
}

// ---------------------------------------------------------------- reports and history

async function loadReport(gameId) {
  const key = `report:${gameId}`;
  return (await chrome.storage.local.get(key))[key] ?? null;
}

/** Loads a report and marks it as recently used, so the LRU keeps it. */
async function getReport(gameId) {
  const report = await loadReport(gameId);
  if (report) {
    const { reportIndex = [] } = await chrome.storage.local.get('reportIndex');
    if (reportIndex[0] !== gameId) {
      await chrome.storage.local.set({ reportIndex: [gameId, ...reportIndex.filter((id) => id !== gameId)] });
    }
  }
  return report;
}

function myResult(report) {
  if (report.result === '1-0') return report.myColor === 'white' ? 'win' : 'loss';
  if (report.result === '0-1') return report.myColor === 'black' ? 'win' : 'loss';
  if (report.result === '1/2-1/2') return 'draw';
  return null;
}

function summaryOf(report) {
  const phases = {};
  for (const ph of ['opening', 'middlegame', 'endgame']) {
    const s = report.mine[ph];
    phases[ph] = { moves: s.moves, inaccuracy: s.inaccuracy, mistake: s.mistake, blunder: s.blunder, accuracy: s.accuracy };
  }
  return {
    id: report.gameId,
    url: report.url,
    date: report.endTime ? report.endTime * 1000 : report.analyzedAt,
    opponent: report.opponent,
    myColor: report.myColor,
    result: myResult(report),
    timeClass: report.timeClass,
    opening: report.opening ? { eco: report.opening.eco, name: report.opening.name } : null,
    accuracy: report.mine.accuracy,
    phases,
  };
}

async function storeReport(report) {
  const { reportIndex = [], history = [] } = await chrome.storage.local.get(['reportIndex', 'history']);
  const index = [report.gameId, ...reportIndex.filter((id) => id !== report.gameId)];
  const dropped = index.splice(MAX_REPORTS);
  const update = { [`report:${report.gameId}`]: report, reportIndex: index };
  // Games watched as a spectator get a report, but stay out of the personal statistics.
  if (report.isPlayer !== false) {
    update.history = [summaryOf(report), ...history.filter((h) => h.id !== report.gameId)]
      .sort((a, b) => b.date - a.date)
      .slice(0, MAX_HISTORY);
  }
  await chrome.storage.local.set(update);
  if (dropped.length) await chrome.storage.local.remove(dropped.map((id) => `report:${id}`));
}

async function clearHistory() {
  const { reportIndex = [] } = await chrome.storage.local.get('reportIndex');
  await chrome.storage.local.remove(['history', 'reportIndex', ...reportIndex.map((id) => `report:${id}`)]);
}

// ---------------------------------------------------------------- player ratings

const statsMem = new Map();
const statsInflight = new Map();

function pickTimeClass(entry) {
  if (!entry?.last && !entry?.best) return null;
  const r = entry.record ?? {};
  const rating = entry.last?.rating ?? null;
  return {
    rating,
    best: Math.max(entry.best?.rating ?? 0, rating ?? 0) || null,
    bestDate: entry.best?.date ?? null,
    games: (r.win ?? 0) + (r.loss ?? 0) + (r.draw ?? 0),
  };
}

async function fetchStats(key, fresh = false) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(key)}/stats`, { cache: fresh ? "no-store" : "default" });
    if (res.status === 429 && attempt < 2) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (res.status === 404 || res.status === 410) return { username: key, missing: true };
    if (!res.ok) throw new Error(`chess.com stats HTTP ${res.status}`);
    const j = await res.json();
    return {
      username: key,
      rapid: pickTimeClass(j.chess_rapid),
      blitz: pickTimeClass(j.chess_blitz),
      bullet: pickTimeClass(j.chess_bullet),
    };
  }
}

/** fresh: skip every cache (a game just ended and the ratings changed). */
async function getPlayerStats(username, fresh = false) {
  const key = username.trim().toLowerCase();
  const now = Date.now();
  const ttl = fresh ? 0 : STATS_TTL;
  const mem = statsMem.get(key);
  if (mem && now - mem.at < ttl) return mem.data;
  const storeKey = `stats:${key}`;
  const stored = (await chrome.storage.session.get(storeKey))[storeKey];
  if (stored && now - stored.at < ttl) {
    statsMem.set(key, stored);
    return stored.data;
  }
  if (!statsInflight.has(key)) {
    statsInflight.set(
      key,
      fetchStats(key, fresh)
        .then(async (data) => {
          const entry = { at: Date.now(), data };
          statsMem.set(key, entry);
          await chrome.storage.session.set({ [storeKey]: entry }).catch(() => {});
          return data;
        })
        .finally(() => statsInflight.delete(key)),
    );
  }
  return statsInflight.get(key);
}

// ---------------------------------------------------------------- messages

function reply(promise, sendResponse) {
  promise.then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return;
  if (msg?.target === 'background') {
    if (msg.type === 'progress' && msg.tabId != null) {
      chrome.tabs.sendMessage(msg.tabId, { type: 'cce:progress', gameId: msg.gameId, done: msg.done, total: msg.total }).catch(() => {});
    } else if (msg.type === 'done') {
      onJobDone(msg);
    }
    return;
  }
  switch (msg?.type) {
    case 'cce:settings':
      return reply(getSettings(), sendResponse);
    case 'cce:stats':
      return reply(getPlayerStats(msg.username, !!msg.fresh), sendResponse);
    case 'cce:analyze':
      return reply(analyzeGame(msg.game, sender.tab?.id ?? null, msg.force), sendResponse);
    case 'cce:opening':
      return reply(translateOpening(msg.name, msg.lang), sendResponse);
    case 'cce:report':
      return reply(getReport(msg.gameId), sendResponse);
    case 'cce:clearHistory':
      return reply(clearHistory(), sendResponse);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings } });
});
