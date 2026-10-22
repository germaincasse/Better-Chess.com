// A pool of single-threaded Stockfish workers (UCI over postMessage), one search per worker at a time.

const SEARCH_TIMEOUT_MS = 120000;

class UciWorker {
  constructor(url, hashMb) {
    this.listeners = new Set();
    this.failed = null;
    this.worker = new Worker(url);
    this.worker.onmessage = (e) => {
      const line = String(e.data);
      for (const fn of [...this.listeners]) fn(line);
    };
    this.worker.onerror = (e) => {
      console.warn('Stockfish worker error', e.message);
      this.fail(new Error('err.engineStopped'));
    };
    this.ready = this.until('uciok', () => this.send('uci')).then(() => {
      this.send(`setoption name Hash value ${hashMb}`);
      return this.until('readyok', () => this.send('isready'));
    });
    // A failure before readiness is reported by whoever awaits `ready`.
    this.ready.catch(() => {});
  }

  /** Marks the worker dead and rejects everything waiting on it. */
  fail(error) {
    this.failed ??= error;
    for (const fn of [...this.listeners]) fn(null);
    this.listeners.clear();
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  until(token, kick) {
    return new Promise((resolve, reject) => {
      if (this.failed) return reject(this.failed);
      const fn = (line) => {
        if (line === null) {
          this.listeners.delete(fn);
          reject(this.failed);
        } else if (line === token) {
          this.listeners.delete(fn);
          resolve();
        }
      };
      this.listeners.add(fn);
      kick();
    });
  }

  /** Resolves with { cp | mate (side to move), best, pv, depth }. */
  search(fen, depth) {
    return new Promise((resolve, reject) => {
      if (this.failed) return reject(this.failed);
      let last = null;
      const timer = setTimeout(() => {
        this.fail(new Error('err.engineTimeout'));
        this.worker.terminate();
      }, SEARCH_TIMEOUT_MS);
      const fn = (line) => {
        if (line === null) {
          clearTimeout(timer);
          this.listeners.delete(fn);
          reject(this.failed);
          return;
        }
        if (line.startsWith('info ') && line.includes(' score ')) {
          const t = line.split(' ');
          const s = t.indexOf('score');
          if (t[s + 3] === 'lowerbound' || t[s + 3] === 'upperbound') return;
          const mp = t.indexOf('multipv');
          if (mp >= 0 && t[mp + 1] !== '1') return;
          const value = Number(t[s + 2]);
          const pvAt = t.indexOf('pv');
          last = {
            depth: Number(t[t.indexOf('depth') + 1]),
            cp: t[s + 1] === 'cp' ? value : undefined,
            mate: t[s + 1] === 'mate' ? value : undefined,
            pv: pvAt >= 0 ? t.slice(pvAt + 1) : [],
          };
        } else if (line.startsWith('bestmove')) {
          clearTimeout(timer);
          this.listeners.delete(fn);
          const best = line.split(' ')[1];
          resolve({ ...(last ?? { depth: 0, cp: 0, pv: [] }), best: best === '(none)' ? null : best });
        }
      };
      this.listeners.add(fn);
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  newGame() {
    this.send('ucinewgame');
  }

  terminate() {
    this.fail(new Error('err.interrupted'));
    this.worker.terminate();
  }
}

export class EnginePool {
  constructor(url, hashMb = 16) {
    this.url = url;
    this.hashMb = hashMb;
    this.workers = [];
  }

  async resize(size) {
    for (const w of this.workers.filter((w) => w.failed)) w.terminate();
    this.workers = this.workers.filter((w) => !w.failed);
    while (this.workers.length > size) this.workers.pop().terminate();
    while (this.workers.length < size) this.workers.push(new UciWorker(this.url, this.hashMb));
    await Promise.all(this.workers.map((w) => w.ready));
  }

  /**
   * Evaluates every position; results come back in input order.
   * onProgress(done, total) after each position. Any worker failure stops every worker
   * and rejects, so no search can leak into the next game.
   */
  async evaluateAll(fens, depth, onProgress) {
    for (const w of this.workers) w.newGame();
    const results = new Array(fens.length);
    let next = 0;
    let done = 0;
    let stopped = false;
    const run = async (w) => {
      while (!stopped && next < fens.length) {
        const i = next++;
        results[i] = await w.search(fens[i], depth);
        if (stopped) return;
        done++;
        onProgress?.(done, fens.length);
      }
    };
    try {
      await Promise.all(this.workers.map(run));
    } catch (e) {
      stopped = true;
      this.terminate();
      throw e;
    }
    return results;
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
