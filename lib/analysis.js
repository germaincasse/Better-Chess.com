// Pure game analysis helpers: chess.com move decoding, phases, move classification.
import { Chess, DEFAULT_POSITION } from './chess.js';

// chess.com "TCN" move encoding (callback endpoints): two characters per move.
const TCN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=';
const TCN_PROMO = 'qnrbkp';

export function decodeTcn(tcn) {
  const moves = [];
  for (let i = 0; i + 1 < tcn.length; i += 2) {
    const from = TCN.indexOf(tcn[i]);
    let to = TCN.indexOf(tcn[i + 1]);
    let promotion;
    if (from < 0 || to < 0 || from > 63) throw new Error(`Unreadable chess.com move: ${tcn.slice(i, i + 2)}`);
    if (to > 63) {
      promotion = TCN_PROMO[Math.floor((to - 64) / 3)];
      to = from + (from < 16 ? -8 : 8) + ((to - 1) % 3) - 1;
    }
    moves.push({ from: square(from), to: square(to), promotion });
  }
  return moves;
}

function square(i) {
  return 'abcdefgh'[i % 8] + (Math.floor(i / 8) + 1);
}

/** Replays the game; returns every move with the positions around it. */
export function replayGame({ tcn, pgn, initialFen }) {
  const chess = new Chess(initialFen || DEFAULT_POSITION);
  if (pgn) {
    chess.loadPgn(pgn);
    const history = chess.history({ verbose: true });
    return toPlies(history, chess);
  }
  const history = [];
  for (const m of decodeTcn(tcn || '')) {
    const move = chess.move(m.promotion ? m : { from: m.from, to: m.to });
    history.push(move);
  }
  return toPlies(history, chess);
}

function toPlies(history, finalChess) {
  const plies = history.map((m, i) => ({
    ply: i,
    color: m.color === 'w' ? 'white' : 'black',
    moveNumber: Number(m.before.split(' ')[5]),
    san: m.san,
    uci: m.from + m.to + (m.promotion ?? ''),
    from: m.from,
    to: m.to,
    fenBefore: m.before,
    fenAfter: m.after,
    pieces: countPieces(m.before),
  }));
  let terminal = null;
  if (finalChess.isCheckmate()) terminal = 'checkmate';
  else if (finalChess.isDraw()) terminal = 'draw';
  return { plies, finalFen: finalChess.fen(), terminal };
}

/** Knights, bishops, rooks and queens left on the board, both sides. */
export function countPieces(fen) {
  const board = fen.split(' ')[0];
  let n = 0;
  for (const ch of board) if ('nbrqNBRQ'.includes(ch)) n++;
  return n;
}

export function phaseOf(moveNumber, pieces, settings) {
  // Endgame first: a game started from an endgame position is not an opening.
  if (pieces <= settings.endgamePieces) return 'endgame';
  if (moveNumber <= settings.openingMoves) return 'opening';
  return 'middlegame';
}

export const MATE_CP = 10000;

/** Engine score (side to move) to centipawns from White's point of view. */
export function whiteCp(score, fen) {
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  if (score.mate !== undefined && score.mate !== null) {
    // "mate 0": the side to move is mated.
    const m = score.mate;
    const cp = m === 0 ? -MATE_CP : Math.sign(m) * (MATE_CP - Math.abs(m) * 10);
    return cp * sign;
  }
  return (score.cp ?? 0) * sign;
}

/** Lichess win-chance model, 0..100 from the given side. */
export function winPct(cpWhite, color) {
  const cp = Math.max(-1500, Math.min(1500, color === 'white' ? cpWhite : -cpWhite));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Lichess per-move accuracy from the win percentages before and after the move. */
export function moveAccuracy(winBefore, winAfter) {
  if (winAfter >= winBefore) return 100;
  const acc = 103.1668 * Math.exp(-0.04354 * (winBefore - winAfter)) - 3.1669 + 1;
  return Math.max(0, Math.min(100, acc));
}

/** Lichess thresholds, in win percentage points lost. */
export function classify(loss) {
  if (loss >= 15) return 'blunder';
  if (loss >= 10) return 'mistake';
  if (loss >= 5) return 'inaccuracy';
  return null;
}

export const PHASES = ['opening', 'middlegame', 'endgame'];

/** Converts a UCI line to SAN from a position; stops at the first illegal move. */
export function uciLineToSan(fen, ucis, max = 8) {
  const chess = new Chess(fen);
  const out = [];
  for (const u of ucis.slice(0, max)) {
    try {
      const m = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(m.san);
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Builds the report from the replayed game and one engine result per position
 * (evals[i] for the position before ply i, evals[plies.length] for the final one).
 */
export function buildReport(game, replay, evals, settings) {
  const { plies } = replay;
  const cps = evals.map((e) => e.cpWhite);
  const moves = plies.map((p, i) => {
    const before = cps[i];
    const after = cps[i + 1];
    const best = evals[i].best;
    const isBest = best === p.uci;
    const wb = winPct(before, p.color);
    const wa = winPct(after, p.color);
    const loss = isBest ? 0 : Math.max(0, wb - wa);
    const phase = phaseOf(p.moveNumber, p.pieces, settings);
    const bestLine = isBest ? [] : uciLineToSan(p.fenBefore, evals[i].pv?.length ? evals[i].pv : [best], 8);
    return {
      ply: p.ply,
      color: p.color,
      moveNumber: p.moveNumber,
      san: p.san,
      uci: p.uci,
      fenBefore: p.fenBefore,
      phase,
      evalBefore: before,
      evalAfter: after,
      best: isBest ? null : { uci: best, san: bestLine[0] ?? null, line: bestLine },
      loss: Math.round(loss * 10) / 10,
      accuracy: Math.round((isBest ? 100 : moveAccuracy(wb, wa)) * 10) / 10,
      cls: classify(loss),
    };
  });

  const summary = (color) => {
    const out = {};
    for (const ph of PHASES) {
      const mine = moves.filter((m) => m.color === color && m.phase === ph);
      out[ph] = {
        moves: mine.length,
        inaccuracy: mine.filter((m) => m.cls === 'inaccuracy').length,
        mistake: mine.filter((m) => m.cls === 'mistake').length,
        blunder: mine.filter((m) => m.cls === 'blunder').length,
        accuracy: mine.length ? Math.round(mine.reduce((s, m) => s + m.accuracy, 0) / mine.length) : null,
        firstMove: mine[0]?.moveNumber ?? null,
        lastMove: mine.at(-1)?.moveNumber ?? null,
      };
    }
    const all = moves.filter((m) => m.color === color);
    out.accuracy = all.length ? Math.round(all.reduce((s, m) => s + m.accuracy, 0) / all.length) : null;
    return out;
  };

  const opp = game.myColor === 'white' ? 'black' : 'white';
  return {
    gameId: game.id,
    gameType: game.type,
    url: game.url,
    white: game.white,
    black: game.black,
    whiteElo: game.whiteElo,
    blackElo: game.blackElo,
    result: game.result,
    termination: game.termination,
    timeClass: game.timeClass,
    endTime: game.endTime,
    myColor: game.myColor,
    isPlayer: game.isPlayer !== false,
    opponent: game.myColor === 'white' ? game.black : game.white,
    /** { eco, name (English), ply } of the deepest named opening position, or null. */
    opening: replay.opening ?? null,
    depth: settings.depth,
    openingMoves: settings.openingMoves,
    endgamePieces: settings.endgamePieces,
    evals: cps,
    finalFen: replay.finalFen,
    moves,
    mine: summary(game.myColor),
    theirs: summary(opp),
    analyzedAt: Date.now(),
  };
}
