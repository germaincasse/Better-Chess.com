// Offscreen document: hosts the Stockfish workers (service workers cannot create Web Workers).
// Jobs are accepted at once and their result is sent back in a separate "done" message, so a
// long analysis never depends on one long-lived message channel to the service worker.
import { EnginePool } from './lib/engine-pool.js';
import { MATE_CP, buildReport, replayGame, whiteCp } from './lib/analysis.js';
import { detectOpening, loadOpeningDb } from './lib/openings.js';

const pool = new EnginePool(chrome.runtime.getURL('engine/stockfish.js'), 16);
let queue = Promise.resolve();
/** gameId -> promise of the report, for jobs queued or running. */
const jobs = new Map();

function engineCount(setting) {
  if (setting > 0) return Math.min(8, setting);
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(6, cores - 2));
}

function toBackground(msg) {
  return chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});
}

async function analyze({ game, settings, tabId }) {
  let replay;
  try {
    replay = replayGame({ tcn: game.tcn, pgn: game.pgn, initialFen: game.initialFen });
  } catch (e) {
    // Illegal move or FEN for chess.js: a variant (Chess960...) or a position it cannot replay.
    console.warn('Better Chess.com Free: game not replayable', e);
    throw new Error('err.unsupportedGame');
  }
  if (replay.plies.length < 2) throw new Error('err.tooShort');
  // Named openings only make sense from the standard starting position.
  replay.opening = game.initialFen ? null : detectOpening(replay.plies, await loadOpeningDb());

  const fens = [...replay.plies.map((p) => p.fenBefore), replay.finalFen];
  // A finished game's final position is scored by the rules, not searched.
  const searched = replay.terminal ? fens.slice(0, -1) : fens;

  const t0 = performance.now();
  let results;
  try {
    await pool.resize(engineCount(settings.engines));
    let lastSent = 0;
    results = await pool.evaluateAll(searched, settings.depth, (done, total) => {
      const now = performance.now();
      if (done === total || now - lastSent > 150) {
        lastSent = now;
        toBackground({ type: 'progress', tabId, gameId: game.id, done, total });
      }
    });
  } catch (e) {
    // Never reuse a pool that failed: the next game gets fresh workers.
    pool.terminate();
    throw e;
  }

  const evals = fens.map((fen, i) => {
    const r = results[i];
    if (r) return { cpWhite: whiteCp(r, fen), best: r.best, pv: r.pv, depth: r.depth };
    const whiteToMove = fen.split(' ')[1] === 'w';
    const cpWhite = replay.terminal === 'checkmate' ? (whiteToMove ? -MATE_CP : MATE_CP) : 0;
    return { cpWhite, best: null, pv: [], depth: 0 };
  });

  const report = buildReport(game, replay, evals, settings);
  report.durationMs = Math.round(performance.now() - t0);
  report.engines = pool.workers.length;
  return report;
}

function enqueue(msg) {
  const { game, jobId, tabId } = msg;
  let job = jobs.get(game.id);
  if (!job) {
    // One game at a time: the pool is shared.
    job = queue.then(() => analyze(msg));
    queue = job.catch(() => {});
    jobs.set(game.id, job);
    job.finally(() => jobs.delete(game.id)).catch(() => {});
  }
  job.then(
    (report) => toBackground({ type: 'done', jobId, tabId, gameId: game.id, ok: true, report }),
    (e) => toBackground({ type: 'done', jobId, tabId, gameId: game.id, ok: false, error: e?.message || String(e) }),
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  switch (msg.type) {
    case 'ping':
      sendResponse({ ok: true });
      break;
    case 'status':
      sendResponse({ ok: true, busy: jobs.size });
      break;
    case 'analyze':
      enqueue(msg);
      sendResponse({ ok: true });
      break;
    case 'shutdown':
      pool.terminate();
      sendResponse({ ok: true });
      break;
  }
});
