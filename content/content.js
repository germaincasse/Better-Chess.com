// Better Chess.com Free content script (chess.com): opponent ratings and end-of-game Stockfish report.
(() => {
  'use strict';
  if (window.__chessCoachLoaded) return;
  window.__chessCoachLoaded = true;

  // ================================================================ constants

  const MATE_CP = 10000;
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  // cburnett pieces (Lichess, GPLv2+), bundled: see pieces/NOTICE.md.
  const PIECES_URL = chrome.runtime.getURL('pieces/');

  const ICONS = {
    rapid:
      '<svg viewBox="0 0 24 24" fill="#81b64c" aria-hidden="true"><path d="M9.5 1.5h5v2.2h-5zM11 3h2v2h-2z"/><path fill-rule="evenodd" d="M12 4.6a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2Zm0 2.6a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z"/><path d="M12 13.2V8.4a4.8 4.8 0 0 1 4.8 4.8Z"/><path d="m18.4 4.9 1.7 1.7-1.5 1.5-1.7-1.7z"/></svg>',
    blitz:
      '<svg viewBox="0 0 24 24" fill="#f7c631" aria-hidden="true"><path d="M14.6 1.5 4.8 13.6h6.1L9.4 22.5l9.8-12.3h-6.2l1.6-8.7Z"/></svg>',
    bullet:
      '<svg viewBox="0 0 24 24" fill="#e3aa24" aria-hidden="true"><g transform="rotate(45 12 12)"><path d="M9 20.4V11.5C9 7.6 10.4 4.6 12 2.5c1.6 2.1 3 5.1 3 9v8.9Z"/><path d="M8.2 21h7.6v2H8.2z"/></g></svg>',
    logo: '<svg viewBox="5 8 36 37" fill="currentColor" aria-hidden="true"><path d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21"/><path d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.042-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4.003 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.994-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-1.992 2.5-3c1 0 1 3 1 3"/><rect x="12.5" y="38" width="28" height="5" rx="2.2"/></svg>',
    refresh:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20.5 3.5v5h-5"/></svg>',
    minimize:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>',
    close:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="m6.5 6.5 11 11m0-11-11 11"/></svg>',
  };

  const TIME_CLASSES = ['rapid', 'blitz', 'bullet'];

  const PHASES = ['opening', 'middlegame', 'endgame'];

  const CLASS = {
    blunder: { sym: '??', color: '#fa412d' },
    mistake: { sym: '?', color: '#ffa459' },
    inaccuracy: { sym: '?!', color: '#f7c631' },
  };
  const BEST_COLOR = '#81b64c';

  // ================================================================ utils

  let settings = {
    language: CCE_I18N.DEFAULT_LANGUAGE,
    username: '',
    showRatings: true,
    showPeak: true,
    autoAnalyze: true,
    showInaccuracies: false,
    syncBoard: true,
  };
  let alive = true;
  let observer = null;
  let ticker = null;

  function debug(...args) {
    try {
      if (localStorage.getItem('chessCoachDebug')) console.debug('[Better Chess.com Free]', ...args);
    } catch {}
  }

  async function send(msg) {
    let res;
    try {
      res = await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (/context invalidated/i.test(e?.message)) shutdown();
      throw e;
    }
    if (!res?.ok) throw new Error(res?.error || 'err.noResponse');
    return res.data;
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') Object.assign(el.style, v);
        else if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }

  // ---------------------------------------------------------------- i18n

  const t = (key, params) => CCE_I18N.t(settings.language, key, params);
  /** "3 blunders", "1 mistake"... */
  const countOf = (cls, n) => t(`cls.${cls}`, { n });
  const phaseLabel = (ph) => t(`phase.${ph}`);
  const phaseIn = (ph) => t(`phaseIn.${ph}`);
  const pct = (n) => t('fmt.pct', { n });
  /** Error messages travel as i18n keys; anything else is shown as is. */
  const errorText = (msg) => (CCE_I18N.has(msg) ? t(msg) : msg || t('err.analysisFailed'));
  const joinAnd = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} ${t('and')} ${parts.at(-1)}` : parts[0] ?? '');

  /** Translated opening names, fetched once per language and name. */
  const openingCache = new Map();

  function openingName(name) {
    if (!name || settings.language === 'en') return name;
    const key = `${settings.language}|${name}`;
    if (openingCache.has(key)) return openingCache.get(key) ?? name;
    openingCache.set(key, null);
    send({ type: 'cce:opening', name, lang: settings.language })
      .then((translated) => {
        openingCache.set(key, translated || name);
        Panel.rerender();
      })
      .catch(() => openingCache.set(key, name));
    return name;
  }

  function fmtEval(cp) {
    if (Math.abs(cp) >= MATE_CP - 1000) {
      const n = Math.round((MATE_CP - Math.abs(cp)) / 10);
      if (n === 0) return cp > 0 ? '1-0' : '0-1';
      return `${cp > 0 ? '' : '-'}M${n}`;
    }
    const v = cp / 100;
    if (Math.abs(v) < 0.05) return '0.0';
    return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
  }

  function winPctWhite(cp) {
    const c = Math.max(-1500, Math.min(1500, cp));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
  }

  const moveLabel = (moveNumber, color, san) => `${moveNumber}${color === 'white' ? '.' : '...'} ${san}`;

  function lineLabel(m, sans) {
    let n = m.moveNumber;
    let white = m.color === 'white';
    const parts = [];
    sans.forEach((san, i) => {
      if (white) parts.push(`${n}. ${san}`);
      else parts.push(i === 0 ? `${n}... ${san}` : san);
      if (!white) n++;
      white = !white;
    });
    return parts.join(' ');
  }

  function accuracyColor(acc) {
    if (acc == null) return '#8b8987';
    if (acc >= 90) return '#81b64c';
    if (acc >= 75) return '#b5c94a';
    if (acc >= 60) return '#f7c631';
    return '#fa412d';
  }

  function timeClassOf(timeControl, type) {
    if (type === 'daily' || /\//.test(timeControl || '')) return 'daily';
    const [base, inc] = String(timeControl || '').split('+').map(Number);
    if (!base) return null;
    const total = base + 40 * (inc || 0);
    if (total < 180) return 'bullet';
    if (total < 600) return 'blitz';
    return 'rapid';
  }

  // ================================================================ who am I

  function myUsername() {
    return (settings.username || document.documentElement.dataset.cceUser || '').trim().toLowerCase();
  }

  // ================================================================ player ratings

  const USERNAME_SEL =
    '[data-test-element="user-tagline-username"], .user-tagline-username, .user-tagline-compact-username';
  const PLAYER_SEL = '.player-component, .board-layout-player, #board-layout-player-top, #board-layout-player-bottom';
  const PLAYER_AREA_SEL = '#board-layout-player-top, #board-layout-player-bottom, .board-layout-player';
  /** After a failed stats request, wait this long before asking again for the same player. */
  const BADGE_RETRY_MS = 60000;
  /** The badge copies the username color; re-read it now and then (theme changes) rather than every tick. */
  const BADGE_COLOR_MS = 5000;

  // Names chess.com shows (translated) while a seat is still empty: seeking an opponent, loading.
  const PLACEHOLDER_NAMES = new Set([
    'opponent', 'player', 'guest',
    'adversaire', 'joueur', 'invite', 'invité',
    'gegner', 'spieler', 'gast',
    'oponente', 'jugador', 'invitado', 'jogador', 'convidado',
    'avversario', 'giocatore', 'ospite',
    'tegenstander', 'speler', 'przeciwnik', 'gracz',
  ]);

  function readUsername(el) {
    const link = el.matches('a[href*="/member/"]') ? el : el.querySelector('a[href*="/member/"]');
    const m = link?.getAttribute('href')?.match(/\/member\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
    const text = el.textContent.trim();
    if (!/^[A-Za-z0-9_-]{3,}$/.test(text) || PLACEHOLDER_NAMES.has(text.toLowerCase())) return null;
    return text;
  }

  /** Username behind a tagline. chess.com may show the real name instead: the clock color tells who it is. */
  function playerUsername(el, player) {
    const name = readUsername(el);
    if (name || !/\s/.test(el.textContent.trim())) return name;
    const area = el.closest(PLAYER_AREA_SEL) ?? player;
    const clock = area.querySelector('.clock-white, .clock-black');
    if (!clock || !game?.players) return null;
    return game.players[clock.classList.contains('clock-white') ? 'white' : 'black'] || null;
  }

  function scanPlayers() {
    if (!settings.showRatings) {
      document.querySelectorAll('.cce-ratings').forEach((b) => b.remove());
      return;
    }
    const now = Date.now();
    const done = new Set();
    for (const el of document.querySelectorAll(USERNAME_SEL)) {
      const player = el.closest(PLAYER_SEL);
      if (!player || done.has(player)) continue;
      done.add(player);
      const name = playerUsername(el, player);
      let badge = player.querySelector('.cce-ratings');
      if (!name) {
        badge?.remove();
        continue;
      }
      const retry = badge?.dataset.retryAt && now > Number(badge.dataset.retryAt);
      if (badge?.dataset.user === name.toLowerCase() && !retry) {
        // The tagline container is dark; only the username carries the readable color for the theme.
        if (now - Number(badge.dataset.colorAt || 0) > BADGE_COLOR_MS) {
          badge.style.color = getComputedStyle(el).color;
          badge.dataset.colorAt = String(now);
        }
        continue;
      }
      badge?.remove();
      badge = makeBadge(name);
      badge.style.color = getComputedStyle(el).color;
      badge.dataset.colorAt = String(now);
      (el.closest('.cc-user-block-component') ?? el.parentElement).append(badge);
    }
  }

  function fillBadge(badge, stats) {
    if (stats.missing) {
      // Unknown or closed account: keep the hidden element, its data-user stops the scan from asking again.
      badge.hidden = true;
      return;
    }
    badge.className = 'cce-ratings';
    badge.removeAttribute('title');
    badge.replaceChildren(...TIME_CLASSES.map((tc) => ratingItem(tc, stats[tc])));
  }

  function makeBadge(name) {
    const badge = h('span', { class: 'cce-ratings cce-loading', 'data-user': name.toLowerCase(), title: t('badge.loading') }, '…');
    send({ type: 'cce:stats', username: name })
      .then((stats) => fillBadge(badge, stats))
      .catch((e) => {
        debug('stats', name, e);
        badge.hidden = true;
        badge.dataset.retryAt = String(Date.now() + BADGE_RETRY_MS);
      });
    return badge;
  }

  function ratingItem(tc, s) {
    const label = t(`tc.${tc}`);
    if (!s?.rating) {
      return h('span', { class: 'cce-rating cce-none', title: t('badge.none', { tc: label }), html: ICONS[tc] }, h('b', null, '-'));
    }
    const when = s.bestDate
      ? ` (${new Date(s.bestDate * 1000).toLocaleDateString(settings.language, { month: 'short', year: 'numeric' })})`
      : '';
    const title = t('badge.title', {
      tc: label,
      rating: s.rating,
      best: s.best ?? s.rating,
      when,
      games: t('badge.games', { n: s.games }),
    });
    return h(
      'span',
      { class: 'cce-rating', title, html: ICONS[tc] },
      h('b', null, s.rating),
      s.best && settings.showPeak ? h('i', null, `(${s.best})`) : null,
    );
  }

  /**
   * A game just ended: ratings changed. Re-reads both players' stats bypassing the cache, in place
   * (no flicker); chess.com's API may lag a few seconds, hence the second pass.
   */
  function refreshRatingsAfterGame() {
    for (const delay of [3000, 20000]) {
      setTimeout(() => {
        if (!alive) return;
        for (const badge of document.querySelectorAll('.cce-ratings[data-user]')) {
          send({ type: 'cce:stats', username: badge.dataset.user, fresh: true })
            .then((stats) => badge.isConnected && fillBadge(badge, stats))
            .catch((e) => debug('stats refresh', e));
        }
      }, delay);
    }
  }

  // ================================================================ game detection

  const GAME_URL_RES = [
    /\/game\/(live|daily)\/(\d+)/,
    /\/(live|daily)\/game\/(\d+)/,
    /\/analysis\/game\/(live|daily)\/(\d+)/,
  ];

  function gameRefFromUrl(url) {
    if (!url) return null;
    for (const re of GAME_URL_RES) {
      const m = url.match(re);
      if (m) return { type: m[1], id: m[2] };
    }
    let m = url.match(/\/game\/(\d+)(?:[/?#]|$)/);
    if (m) return { type: null, id: m[1] };
    m = url.match(/[#&?]g=(\d+)/);
    if (m) return { type: 'live', id: m[1] };
    return null;
  }

  function gameRefFromDom() {
    // On /play/online the URL may not carry the game id; the game-over modal links to the game.
    for (const a of document.querySelectorAll('[class*="game-over"] a[href]')) {
      const ref = gameRefFromUrl(a.getAttribute('href'));
      if (ref) return ref;
    }
    return null;
  }

  function currentGameRef() {
    return gameRefFromUrl(location.pathname + location.search + location.hash) ?? gameRefFromDom();
  }

  function gameOverVisible() {
    if (document.querySelector('.game-result, .player-game-over-component')) return true;
    // chess.com may mount the game-over modal hidden during the game: it only counts once shown.
    return [...document.querySelectorAll('[class*="game-over-modal"]')].some((el) => el.checkVisibility?.() ?? true);
  }

  async function fetchGame(g) {
    const types = g.type ? [g.type] : ['live', 'daily'];
    for (const type of types) {
      const res = await fetch(`${location.origin}/callback/${type}/game/${g.id}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.game) {
        g.type = type;
        return data;
      }
    }
    throw new Error('err.gameNotFound');
  }

  function gameInfo(g, data) {
    const G = data.game;
    const hd = G.pgnHeaders ?? {};
    const white = hd.White ?? '';
    const black = hd.Black ?? '';
    const me = myUsername();
    let myColor = null;
    if (me && white.toLowerCase() === me) myColor = 'white';
    else if (me && black.toLowerCase() === me) myColor = 'black';
    const isPlayer = myColor !== null || !me;
    myColor ??= data.players?.bottom?.color === 'black' ? 'black' : 'white';
    const moveList = G.moveList ?? '';
    return {
      id: g.id,
      type: g.type,
      url: `https://www.chess.com/game/${g.type}/${g.id}`,
      tcn: moveList,
      initialFen: G.initialSetup && G.initialSetup !== START_FEN ? G.initialSetup : null,
      plyCount: Math.floor(moveList.length / 2),
      white,
      black,
      whiteElo: hd.WhiteElo ?? null,
      blackElo: hd.BlackElo ?? null,
      result: hd.Result ?? null,
      termination: G.resultMessage || hd.Termination || '',
      timeControl: hd.TimeControl ?? '',
      timeClass: timeClassOf(hd.TimeControl, g.type),
      endTime: G.endTime ?? null,
      myColor,
      isPlayer,
    };
  }

  // ================================================================ game controller

  let game = null;
  /** Game id of the previous tick's page, to notice leaving a game page. */
  let lastRefId = null;

  async function checkGame(g) {
    if (g.checking) return;
    g.checking = true;
    const wasLive = g.status === 'live';
    try {
      const data = await fetchGame(g);
      g.checkedAt = Date.now();
      g.failures = 0;
      if (game !== g) return;
      const hd = data.game.pgnHeaders ?? {};
      if (hd.White && hd.Black) g.players = { white: hd.White, black: hd.Black };
      // Never analyze a game in progress.
      if (!data.game.isFinished) {
        g.status = 'live';
        return;
      }
      if (data.game.type && data.game.type !== 'chess') {
        g.status = 'unsupported';
        return;
      }
      g.info = gameInfo(g, data);
      if (g.info.plyCount < 2) {
        g.status = 'unsupported';
        return;
      }
      g.status = 'finished';
      if (wasLive) refreshRatingsAfterGame();
      const cached = await send({ type: 'cce:report', gameId: g.id }).catch(() => null);
      if (game !== g) return;
      if (cached) {
        g.status = 'done';
        Panel.report(g.id, cached, false, () => analyze(g, true));
        return;
      }
      const justEnded = g.info.endTime && Date.now() / 1000 - g.info.endTime < 300;
      if (settings.autoAnalyze && justEnded && g.info.isPlayer && g.info.plyCount >= 6) analyze(g, false, false);
      else Panel.offer(g.id, () => analyze(g, false, true));
    } catch (e) {
      debug('check', e);
      g.checkedAt = Date.now();
      g.failures = (g.failures ?? 0) + 1;
      if (g.status === 'new') g.status = 'live';
    } finally {
      g.checking = false;
    }
  }

  async function analyze(g, force, open = Panel.isOpen()) {
    if (g.status === 'analyzing' || !g.info) return;
    g.status = 'analyzing';
    Panel.progress(g.id, 0, g.info.plyCount + 1, open);
    try {
      const report = await send({ type: 'cce:analyze', game: g.info, force });
      g.status = 'done';
      if (game === g) Panel.report(g.id, report, true, () => analyze(g, true));
    } catch (e) {
      if (!alive) return;
      g.status = 'finished';
      if (game === g) Panel.error(g.id, errorText(e.message), () => analyze(g, force));
    }
  }

  function tick() {
    if (!alive) return;
    // Extension reloaded or removed: this script is orphaned.
    if (!chrome.runtime?.id) {
      shutdown();
      return;
    }
    try {
      scanPlayers();
    } catch (e) {
      debug('ratings', e);
    }
    const ref = currentGameRef();
    if (!ref) {
      // Leaving a game for a lobby page: put the report out of the way once, so it can still be reopened.
      if (lastRefId !== null && Panel.isOpen() && !gameOverVisible()) Panel.collapse();
      lastRefId = null;
      return;
    }
    lastRefId = ref.id;
    if (!game || game.id !== ref.id) {
      game = { id: ref.id, type: ref.type, status: 'new', checkedAt: 0, checking: false, failures: 0 };
      Panel.reset(game.id);
      debug('game', game.id);
    }
    if (game.status === 'new') {
      checkGame(game);
    } else if (game.status === 'live') {
      const base = gameOverVisible() ? 2000 : 30000;
      const backoff = game.failures ? Math.min(60000, 2000 * 2 ** game.failures) : 0;
      if (Date.now() - game.checkedAt > Math.max(base, backoff)) checkGame(game);
    }
  }

  function shutdown() {
    if (!alive) return;
    alive = false;
    observer?.disconnect();
    clearInterval(ticker);
    Panel.destroy();
    document.querySelectorAll('.cce-ratings').forEach((b) => b.remove());
  }

  async function saveSetting(patch) {
    try {
      const { settings: stored } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...stored, ...patch } });
    } catch (e) {
      debug('settings', e);
      if (!chrome.runtime?.id) shutdown();
    }
  }

  // Clicks the move in chess.com's own move list (finished games only), so the big board shows it.
  function syncChesscomBoard(m) {
    if (!settings.syncBoard) return;
    const strip = (str) => str.replace(/[+#?!\s]/g, '');
    const target = strip(m.san).replace(/^[NBRQK]/, '');
    let fallback = null;
    for (const i of [m.ply, m.ply + 1, m.ply - 1]) {
      const node = document.querySelector(`.node[data-node="0-${i}"]`);
      if (!node) continue;
      fallback ??= node;
      if (strip(node.textContent).includes(target)) {
        node.click();
        return;
      }
    }
    fallback?.click();
  }

  // ================================================================ panel

  const Panel = (() => {
    let host = null;
    let shadow = null;
    let wrap = null;
    let pos = loadPos();
    const st = {
      gameId: null,
      view: null, // offer | progress | report | error
      open: false,
      dismissed: false,
      done: 0,
      total: 0,
      report: null,
      error: null,
      onAction: null,
      filter: null,
      selected: null,
      /** Minimized by the user (or moved out of the way): a finishing analysis must not pop it open. */
      keepCollapsed: false,
    };

    function loadPos() {
      try {
        const p = JSON.parse(localStorage.getItem('chessCoachPanelPos'));
        if (Number.isFinite(p?.right) && Number.isFinite(p?.bottom)) return p;
      } catch {}
      return { right: 16, bottom: 16 };
    }

    function savePos() {
      try {
        localStorage.setItem('chessCoachPanelPos', JSON.stringify(pos));
      } catch {}
    }

    // `pos` is where the user put it; the applied position is clamped to the current size, so the
    // pill can sit anywhere while the panel always opens fully on screen with at least ~320 px of height.
    function applyPos() {
      if (!wrap) return;
      const width = wrap.offsetWidth || 120;
      const height = wrap.offsetHeight || 48;
      const need = st.open ? Math.min(336, innerHeight) : height;
      const right = Math.max(0, Math.min(pos.right, innerWidth - width));
      const bottom = Math.max(0, Math.min(pos.bottom, innerHeight - need));
      wrap.style.right = `${right}px`;
      wrap.style.bottom = `${bottom}px`;
      wrap.style.setProperty('--max-h', `${innerHeight - bottom - 16}px`);
    }

    function mount() {
      if (host?.isConnected) return;
      host = document.createElement('div');
      host.id = 'chess-coach-host';
      shadow = host.attachShadow({ mode: 'open' });
      shadow.append(h('style', null, PANEL_CSS));
      wrap = h('div', { class: 'wrap' });
      shadow.append(wrap);
      document.body.append(host);
      applyPos();
      addEventListener('resize', applyPos);
    }

    function startDrag(e) {
      if (e.button !== 0 || e.target.closest('button, a, input, label')) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      const r0 = innerWidth - rect.right;
      const b0 = innerHeight - rect.bottom;
      const move = (ev) => {
        pos = { right: r0 - (ev.clientX - sx), bottom: b0 - (ev.clientY - sy) };
        applyPos();
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        savePos();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    }

    function render() {
      if (!alive) return;
      mount();
      const scroll = wrap.querySelector('.body')?.scrollTop ?? 0;
      wrap.replaceChildren();
      if (!st.view || st.dismissed) {
        host.style.display = 'none';
        return;
      }
      host.style.display = '';
      wrap.append(st.open ? renderPanel() : renderPill());
      applyPos();
      const body = wrap.querySelector('.body');
      if (body) body.scrollTop = scroll;
    }

    function progressPct() {
      return st.total ? Math.round((100 * st.done) / st.total) : 0;
    }

    function progressText() {
      const count = st.done ? ` ${t('progress.count', { done: st.done, total: st.total })}` : '';
      return `${t('progress.text', { total: st.total })}${count}`;
    }

    /** Updates a progress view in place: re-rendering it at every message would swallow clicks. */
    function updateProgress() {
      if (!wrap) return false;
      const label = wrap.querySelector('.pill-label');
      const text = wrap.querySelector('.progress-text');
      const bar = wrap.querySelector('.bar div');
      if (st.open ? !(text && bar) : !label) return false;
      if (label) label.textContent = t('pill.progress', { pct: pct(progressPct()) });
      if (text) text.textContent = progressText();
      if (bar) bar.style.width = `${progressPct()}%`;
      return true;
    }

    function iconButton(icon, title, onclick) {
      return h('button', { class: 'icon-btn', title, 'aria-label': title, html: icon, onclick });
    }

    // ---------------------------------------------------------- pill

    function seriousCount(r) {
      return PHASES.reduce((s, ph) => s + r.mine[ph].mistake + r.mine[ph].blunder, 0);
    }

    function renderPill() {
      let label;
      let dot = null;
      if (st.view === 'offer') label = t('pill.analyze');
      else if (st.view === 'progress') label = t('pill.progress', { pct: pct(progressPct()) });
      else if (st.view === 'error') label = t('pill.failed');
      else {
        const n = seriousCount(st.report);
        label = n ? t('serious', { n }) : t('pill.noSerious');
        dot = n ? CLASS.blunder.color : BEST_COLOR;
      }
      const main = () => {
        if (st.view === 'offer') st.onAction?.();
        st.open = true;
        st.keepCollapsed = false;
        render();
      };
      return h(
        'div',
        { class: 'pill', onpointerdown: startDrag },
        h('span', { class: 'logo grip', title: t('pill.drag'), html: ICONS.logo }),
        h(
          'button',
          { class: 'pill-main', onclick: main, title: t('pill.open') },
          dot && h('span', { class: 'dot', style: { background: dot } }),
          h('span', { class: 'pill-label' }, label),
        ),
        iconButton(ICONS.close, t('pill.hide'), () => {
          st.dismissed = true;
          render();
        }),
      );
    }

    // ---------------------------------------------------------- panel

    function renderPanel() {
      const panel = h('div', { class: 'panel' });
      panel.append(
        h(
          'div',
          { class: 'head', onpointerdown: startDrag },
          h('div', { class: 'title' }, h('span', { class: 'logo', html: ICONS.logo }), t('panel.title')),
          h(
            'div',
            { class: 'actions' },
            st.view === 'report' && iconButton(ICONS.refresh, t('panel.rerun'), () => st.onAction?.()),
            iconButton(ICONS.minimize, t('panel.minimize'), () => {
              st.open = false;
              st.keepCollapsed = true;
              render();
            }),
            iconButton(ICONS.close, t('panel.close'), () => {
              st.dismissed = true;
              render();
            }),
          ),
        ),
      );
      const body = h('div', { class: 'body' });
      if (st.view === 'offer') body.append(renderOffer());
      else if (st.view === 'progress') body.append(renderProgress());
      else if (st.view === 'error') body.append(renderError());
      else body.append(renderReport(st.report));
      panel.append(body);
      return panel;
    }

    function renderOffer() {
      return h(
        'div',
        { class: 'center' },
        h('p', null, t('offer.text')),
        h('button', { class: 'btn', onclick: () => st.onAction?.() }, t('offer.button')),
      );
    }

    function renderProgress() {
      return h(
        'div',
        { class: 'center' },
        h('p', { class: 'progress-text' }, progressText()),
        h('div', { class: 'bar' }, h('div', { style: { width: `${progressPct()}%` } })),
      );
    }

    function renderError() {
      return h(
        'div',
        { class: 'center' },
        h('p', { class: 'error' }, st.error),
        h('button', { class: 'btn', onclick: () => st.onAction?.() }, t('error.retry')),
      );
    }

    // ---------------------------------------------------------- report

    function weakestPhase(mine) {
      let best = null;
      let bestScore = 0;
      for (const ph of PHASES) {
        const s = mine[ph];
        const score = s.blunder * 2 + s.mistake;
        if (score > bestScore || (score === bestScore && score > 0 && (s.accuracy ?? 100) < (mine[best].accuracy ?? 100))) {
          best = ph;
          bestScore = score;
        }
      }
      return best;
    }

    function phaseErrorText(s, ph) {
      const parts = [];
      if (s.blunder) parts.push(countOf('blunder', s.blunder));
      if (s.mistake) parts.push(countOf('mistake', s.mistake));
      return t('alert.errorsIn', { list: joinAnd(parts), in: phaseIn(ph) });
    }

    function renderAlert(r) {
      const mine = r.mine;
      const weak = weakestPhase(mine);
      if (!weak) {
        const inacc = PHASES.reduce((s, ph) => s + mine[ph].inaccuracy, 0);
        return h(
          'div',
          { class: 'alert good' },
          h('div', { class: 'alert-title' }, t('alert.noneTitle')),
          h('div', null, inacc ? t('alert.inaccOnly', { list: countOf('inaccuracy', inacc) }) : t('alert.clean')),
        );
      }
      const lines = PHASES.filter((ph) => mine[ph].blunder + mine[ph].mistake > 0).map((ph) => phaseErrorText(mine[ph], ph));
      return h(
        'div',
        { class: 'alert bad' },
        h('div', { class: 'alert-title' }, t('alert.weak', { phase: t(`phaseThe.${weak}`) })),
        h('div', null, `${lines.join(', ')}.`),
      );
    }

    function rangeText(ph, s) {
      if (!s.moves) return t(`range.notReached.${ph}`);
      if (ph === 'endgame') return t('range.from', { n: s.firstMove });
      return s.firstMove === s.lastMove ? t('range.single', { n: s.firstMove }) : t('range.span', { a: s.firstMove, b: s.lastMove });
    }

    function chip(cls, n) {
      return h(
        'span',
        { class: `chip${n ? '' : ' zero'}`, style: { '--c': CLASS[cls].color }, title: countOf(cls, n) },
        h('b', null, CLASS[cls].sym),
        ` ${n}`,
      );
    }

    function renderPhases(r) {
      const weak = weakestPhase(r.mine);
      return h(
        'div',
        { class: 'phases' },
        PHASES.map((ph) => {
          const s = r.mine[ph];
          const cls = ['phase', weak === ph && 'weak', st.filter === ph && 'active', !s.moves && 'empty'].filter(Boolean).join(' ');
          return h(
            'button',
            {
              class: cls,
              disabled: !s.moves,
              title: st.filter === ph ? t('filter.all') : t('filter.phase', { phase: phaseLabel(ph).toLowerCase() }),
              onclick: () => {
                st.filter = st.filter === ph ? null : ph;
                st.selected = null;
                render();
              },
            },
            h('div', { class: 'ph-name' }, phaseLabel(ph)),
            h('div', { class: 'ph-range' }, rangeText(ph, s)),
            h('div', { class: 'ph-acc', style: { color: accuracyColor(s.accuracy) } }, s.moves ? pct(s.accuracy) : '-'),
            h('div', { class: 'ph-chips' }, chip('blunder', s.blunder), chip('mistake', s.mistake), chip('inaccuracy', s.inaccuracy)),
          );
        }),
      );
    }

    function visibleErrors(r) {
      return r.moves.filter(
        (m) =>
          m.color === r.myColor &&
          m.cls &&
          (m.cls !== 'inaccuracy' || settings.showInaccuracies) &&
          (!st.filter || m.phase === st.filter),
      );
    }

    function renderGraph(r) {
      const n = r.evals.length - 1;
      const W = Math.max(1, n);
      const pts = r.evals.map((cp, i) => `L${i} ${(100 - winPctWhite(cp)).toFixed(2)}`).join(' ');
      // Phase segments, by ply (each ply belongs to the phase of the move played from it).
      const segs = [];
      r.moves.forEach((m) => {
        const last = segs.at(-1);
        if (last && last.phase === m.phase) last.end = m.ply + 1;
        else segs.push({ phase: m.phase, start: m.ply, end: m.ply + 1 });
      });
      const seps = segs
        .slice(1)
        .map((s) => `<line x1="${s.start}" y1="0" x2="${s.start}" y2="100" class="sep" vector-effect="non-scaling-stroke"/>`)
        .join('');
      const svg = `<svg viewBox="0 0 ${W} 100" preserveAspectRatio="none">
        <rect x="0" y="0" width="${W}" height="100" class="black-area"/>
        <path d="M0 100 ${pts} L${n} 100 Z" class="white-area"/>
        <line x1="0" y1="50" x2="${W}" y2="50" class="mid" vector-effect="non-scaling-stroke"/>${seps}</svg>`;
      const graph = h('div', { class: 'graph' }, h('div', { class: 'graph-plot', html: svg }));
      const plot = graph.firstChild;
      for (const m of visibleErrors(r)) {
        const x = ((m.ply + 1) / W) * 100;
        const y = Math.max(9, Math.min(91, 100 - winPctWhite(m.evalAfter)));
        plot.append(
          h('button', {
            class: `marker${st.selected === m.ply ? ' sel' : ''}`,
            style: { left: `${x}%`, top: `${y}%`, background: CLASS[m.cls].color },
            title: `${moveLabel(m.moveNumber, m.color, m.san)}${CLASS[m.cls].sym}`,
            onclick: () => select(m),
          }),
        );
      }
      graph.append(
        h(
          'div',
          { class: 'graph-labels' },
          segs.map((s) => {
            const w = ((s.end - s.start) / W) * 100;
            return h('span', { style: { width: `${w}%` } }, w > 14 ? phaseLabel(s.phase) : '');
          }),
        ),
      );
      return graph;
    }

    function square(sq, orientation) {
      const f = sq.charCodeAt(0) - 97;
      const r = 8 - Number(sq[1]);
      return orientation === 'white' ? [f, r] : [7 - f, 7 - r];
    }

    function arrow(uci, color, orientation) {
      const [fx, fy] = square(uci.slice(0, 2), orientation);
      const [tx, ty] = square(uci.slice(2, 4), orientation);
      const x1 = fx + 0.5;
      const y1 = fy + 0.5;
      const dx = tx - fx;
      const dy = ty - fy;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const x2 = tx + 0.5 - ux * 0.12;
      const y2 = ty + 0.5 - uy * 0.12;
      const head = 0.42;
      const hw = 0.27;
      const sw = 0.1;
      const bx = x2 - ux * head;
      const by = y2 - uy * head;
      const nx = -uy;
      const ny = ux;
      const p = [
        [x1 + nx * sw, y1 + ny * sw],
        [bx + nx * sw, by + ny * sw],
        [bx + nx * hw, by + ny * hw],
        [x2, y2],
        [bx - nx * hw, by - ny * hw],
        [bx - nx * sw, by - ny * sw],
        [x1 - nx * sw, y1 - ny * sw],
      ];
      return `<polygon points="${p.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ')}" fill="${color}" opacity="0.85"/>`;
    }

    function miniBoard(fen, orientation, arrows) {
      let out = '';
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) out += `<rect x="${x}" y="${y}" width="1" height="1" fill="${(x + y) % 2 ? '#739552' : '#ebecd0'}"/>`;
      }
      fen
        .split(' ')[0]
        .split('/')
        .forEach((row, r) => {
          let f = 0;
          for (const ch of row) {
            if (/\d/.test(ch)) {
              f += Number(ch);
              continue;
            }
            const code = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
            const x = orientation === 'white' ? f : 7 - f;
            const y = orientation === 'white' ? r : 7 - r;
            out += `<image href="${PIECES_URL}${code}.svg" x="${x}" y="${y}" width="1" height="1"/>`;
            f++;
          }
        });
      for (let i = 0; i < 8; i++) {
        const file = orientation === 'white' ? 'abcdefgh'[i] : 'hgfedcba'[i];
        const rank = orientation === 'white' ? 8 - i : i + 1;
        out += `<text x="${i + 0.94}" y="7.95" text-anchor="end" class="coord ${(i + 7) % 2 ? 'on-dark' : 'on-light'}">${file}</text>`;
        out += `<text x="0.05" y="${i + 0.24}" class="coord ${i % 2 ? 'on-dark' : 'on-light'}">${rank}</text>`;
      }
      for (const a of arrows) if (a?.uci) out += arrow(a.uci, a.color, orientation);
      return h('div', { class: 'board', html: `<svg viewBox="0 0 8 8">${out}</svg>` });
    }

    function renderDetail(r, m) {
      const c = CLASS[m.cls];
      const lineMoves = m.best?.line ?? [];
      return h(
        'div',
        { class: 'detail' },
        miniBoard(m.fenBefore, r.myColor, [m.best && { uci: m.best.uci, color: BEST_COLOR }, { uci: m.uci, color: c.color }]),
        h(
          'div',
          { class: 'detail-text' },
          h('div', null, `${t('detail.played')} `, h('b', { style: { color: c.color } }, `${moveLabel(m.moveNumber, m.color, m.san)}${c.sym}`), ` (${fmtEval(m.evalAfter)})`),
          m.best?.san &&
            h('div', null, `${t('detail.best')} `, h('b', { style: { color: BEST_COLOR } }, moveLabel(m.moveNumber, m.color, m.best.san)), ` (${fmtEval(m.evalBefore)})`),
          lineMoves.length > 1 && h('div', { class: 'line' }, lineLabel(m, lineMoves)),
          h('div', { class: 'muted' }, t('detail.lost', { phase: phaseLabel(m.phase), loss: pct(m.loss.toLocaleString(settings.language)) })),
        ),
      );
    }

    function select(m) {
      st.selected = st.selected === m.ply ? null : m.ply;
      render();
      if (st.selected !== null) {
        syncChesscomBoard(m);
        wrap.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
      }
    }

    function renderList(r) {
      const errors = visibleErrors(r);
      const list = h('div', { class: 'list' });
      list.append(
        h(
          'div',
          { class: 'list-head' },
          h('span', null, st.filter ? t('list.titleIn', { in: phaseIn(st.filter) }) : t('list.title')),
          h(
            'label',
            { class: 'toggle' },
            h('input', {
              type: 'checkbox',
              checked: settings.showInaccuracies,
              onchange: (e) => {
                settings.showInaccuracies = e.target.checked;
                saveSetting({ showInaccuracies: e.target.checked });
                render();
              },
            }),
            t('list.inacc'),
          ),
        ),
      );
      if (!errors.length) {
        list.append(h('div', { class: 'empty' }, st.filter ? t('list.emptyIn', { in: phaseIn(st.filter) }) : t('list.empty')));
        return list;
      }
      for (const m of errors) {
        const c = CLASS[m.cls];
        list.append(
          h(
            'button',
            { class: `row${st.selected === m.ply ? ' sel' : ''}`, onclick: () => select(m) },
            h('span', { class: 'sym', style: { color: c.color } }, c.sym),
            h('span', { class: 'mv' }, moveLabel(m.moveNumber, m.color, m.san)),
            h('span', { class: `tag tag-${m.phase}` }, phaseLabel(m.phase)),
            h('span', { class: 'ev' }, `${fmtEval(m.evalBefore)} → ${fmtEval(m.evalAfter)}`),
          ),
        );
        if (st.selected === m.ply) list.append(renderDetail(r, m));
      }
      return list;
    }

    function resultText(r) {
      const me = r.myColor;
      let res = 'draw';
      if (r.result === '1-0') res = me === 'white' ? 'win' : 'loss';
      else if (r.result === '0-1') res = me === 'black' ? 'win' : 'loss';
      else if (!r.result || r.result === '*') res = 'game';
      const oppElo = me === 'white' ? r.blackElo : r.whiteElo;
      return { res, against: t('result.vs', { name: `${r.opponent}${oppElo ? ` (${oppElo})` : ''}` }) };
    }

    function renderReport(r) {
      const { res, against } = resultText(r);
      const theirs = r.theirs;
      const oppBlunders = PHASES.reduce((s, ph) => s + theirs[ph].blunder, 0);
      const oppMistakes = PHASES.reduce((s, ph) => s + theirs[ph].mistake, 0);
      const tc = r.timeClass ? t(`tc.${r.timeClass}`) : '';
      const opening = r.opening ? openingName(r.opening.name) : null;
      const oppList = [oppBlunders && countOf('blunder', oppBlunders), oppMistakes && countOf('mistake', oppMistakes)].filter(Boolean);
      const secs = ((r.durationMs ?? 0) / 1000).toLocaleString(settings.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      return h(
        'div',
        { class: 'report' },
        h(
          'div',
          { class: 'game-line' },
          h('b', { class: `res res-${res === 'game' ? 'draw' : res}` }, t(`result.${res}`)),
          ` ${against}`,
          tc && h('span', { class: 'muted' }, ` · ${tc}`),
          r.mine.accuracy != null && h('span', { class: 'acc', style: { color: accuracyColor(r.mine.accuracy) } }, pct(r.mine.accuracy)),
        ),
        opening && h('div', { class: 'opening', title: `${r.opening.eco} · ${opening}` }, h('span', { class: 'eco' }, r.opening.eco), opening),
        renderAlert(r),
        renderPhases(r),
        renderGraph(r),
        renderList(r),
        h(
          'div',
          { class: 'foot' },
          h(
            'div',
            null,
            t('foot.opponent', { list: oppList.length ? oppList.join(', ') : t('foot.oppNone') }),
            theirs.accuracy != null ? t('foot.accuracy', { acc: pct(theirs.accuracy) }) : '',
          ),
          h(
            'div',
            { class: 'muted' },
            t('foot.meta', { depth: r.depth, engines: t('engines', { n: r.engines ?? 0 }), secs }),
            h('a', { href: `https://www.chess.com/analysis/game/${r.gameType || 'live'}/${r.gameId}?tab=analysis`, target: '_blank', rel: 'noopener' }, t('foot.link')),
          ),
        ),
      );
    }

    // ---------------------------------------------------------- public API

    function forGame(gameId) {
      if (st.gameId !== gameId) {
        st.gameId = gameId;
        st.dismissed = false;
        st.filter = null;
        st.selected = null;
        st.report = null;
        st.keepCollapsed = false;
      }
    }

    return {
      isOpen: () => !!st.view && st.open && !st.dismissed,
      reset(gameId) {
        forGame(gameId);
        st.view = null;
        st.open = false;
        render();
      },
      offer(gameId, onAction) {
        forGame(gameId);
        Object.assign(st, { view: 'offer', open: false, onAction });
        render();
      },
      progress(gameId, done, total, open) {
        const inPlace = st.gameId === gameId && st.view === 'progress' && (open === undefined || open === st.open);
        forGame(gameId);
        Object.assign(st, { view: 'progress', done, total });
        if (open !== undefined) st.open = open;
        if (inPlace && !st.dismissed && updateProgress()) return;
        render();
      },
      report(gameId, report, open, onRefresh) {
        forGame(gameId);
        Object.assign(st, { view: 'report', report, open: open && !st.keepCollapsed, onAction: onRefresh, selected: null });
        render();
      },
      error(gameId, message, onRetry) {
        forGame(gameId);
        Object.assign(st, { view: 'error', error: message, open: true, onAction: onRetry });
        render();
      },
      collapse() {
        st.open = false;
        st.keepCollapsed = true;
        render();
      },
      rerender: () => st.view && render(),
      destroy() {
        host?.remove();
        host = null;
      },
    };
  })();

  // ================================================================ panel styles

  const PANEL_CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #fff; -webkit-font-smoothing: antialiased;
    }
    button { font: inherit; color: inherit; }
    a { color: #8bc34a; }
    .muted { color: #9e9c9a; }
    .logo { display: inline-flex; width: 18px; height: 18px; color: #81b64c; }
    .logo svg { width: 100%; height: 100%; }

    .pill { display: flex; align-items: center; background: #262421; border: 1px solid #3c3a37; border-radius: 999px;
      box-shadow: 0 6px 20px rgba(0,0,0,.45); padding: 2px 4px 2px 2px; cursor: grab; }
    .grip { padding: 0 2px 0 10px; box-sizing: content-box; cursor: grab; }
    .pill-main { display: flex; align-items: center; gap: 8px; border: 0; background: none; cursor: pointer;
      padding: 7px 10px 7px 8px; font-weight: 600; border-radius: 999px; }
    .pill-main:hover { background: #312e2b; }
    .dot { width: 9px; height: 9px; border-radius: 50%; }

    .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
      border: 0; background: none; color: #9e9c9a; border-radius: 6px; cursor: pointer; padding: 5px; }
    .icon-btn:hover { background: #3c3a37; color: #fff; }
    .icon-btn svg { width: 100%; height: 100%; }

    .panel { width: 372px; max-width: calc(100vw - 32px); max-height: var(--max-h, 80vh); display: flex; flex-direction: column;
      background: #262421; border: 1px solid #3c3a37; border-radius: 10px; box-shadow: 0 14px 40px rgba(0,0,0,.55); overflow: hidden; }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 8px 8px 8px 12px;
      background: #1f1e1c; cursor: grab; user-select: none; }
    .title { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; }
    .actions { display: flex; gap: 2px; }
    .body { overflow-y: auto; padding: 12px; scrollbar-width: thin; scrollbar-color: #4b4847 transparent; }

    .center { text-align: center; padding: 6px 4px; }
    .center p { margin: 0 0 12px; color: #d4d3d2; }
    .error { color: #fa8072 !important; }
    .btn { border: 0; border-radius: 6px; background: #81b64c; color: #fff; font-weight: 700; padding: 9px 16px; cursor: pointer;
      box-shadow: 0 3px 0 #45753c; }
    .btn:hover { background: #a3d160; }
    .bar { height: 8px; background: #3c3a37; border-radius: 4px; overflow: hidden; }
    .bar div { height: 100%; background: #81b64c; transition: width .15s; }

    .game-line { display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; color: #d4d3d2; }
    .res-win { color: #81b64c; } .res-loss { color: #fa412d; } .res-draw { color: #bababa; }
    .acc { margin-left: auto; font-weight: 700; font-size: 15px; }
    .opening { margin: -6px 0 10px; color: #d4d3d2; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .eco { display: inline-block; font-size: 11px; font-weight: 700; color: #9e9c9a; background: #3c3a37; border-radius: 4px;
      padding: 0 5px; margin-right: 6px; }

    .alert { border-radius: 8px; padding: 9px 11px; margin-bottom: 10px; border-left: 4px solid; }
    .alert.bad { background: rgba(250,65,45,.12); border-color: #fa412d; }
    .alert.good { background: rgba(129,182,76,.12); border-color: #81b64c; }
    .alert-title { font-weight: 700; font-size: 14px; margin-bottom: 2px; }

    .phases { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 10px; }
    .phase { text-align: left; background: #312e2b; border: 1px solid transparent; border-radius: 8px; padding: 7px 8px; cursor: pointer; }
    .phase:hover:not(:disabled) { background: #3a3734; }
    .phase.weak { border-color: rgba(250,65,45,.7); }
    .phase.active { border-color: #fff; }
    .phase.empty { opacity: .45; cursor: default; }
    .ph-name { font-weight: 700; font-size: 12.5px; }
    .ph-range { font-size: 11px; color: #9e9c9a; margin-bottom: 3px; }
    .ph-acc { font-size: 17px; font-weight: 800; margin-bottom: 3px; }
    .ph-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { font-size: 11.5px; color: #d4d3d2; }
    .chip b { color: var(--c); }
    .chip.zero { opacity: .4; }

    .graph { margin-bottom: 10px; }
    .graph-plot { position: relative; height: 64px; border-radius: 6px; overflow: hidden; }
    .graph-plot svg { display: block; width: 100%; height: 100%; }
    .black-area { fill: #403d39; }
    .white-area { fill: #e8e6e3; }
    .mid { stroke: #8b8987; stroke-width: 1; stroke-dasharray: 3 3; }
    .sep { stroke: #81b64c; stroke-width: 1.5; opacity: .9; }
    .marker { position: absolute; width: 11px; height: 11px; margin: -5.5px 0 0 -5.5px; border-radius: 50%;
      border: 2px solid #262421; padding: 0; cursor: pointer; }
    .marker.sel { outline: 2px solid #fff; }
    .graph-labels { display: flex; font-size: 10.5px; color: #9e9c9a; margin-top: 3px; }
    .graph-labels span { text-align: center; overflow: hidden; white-space: nowrap; }

    .list-head { display: flex; justify-content: space-between; align-items: center; font-weight: 700; margin-bottom: 4px; }
    .toggle { display: flex; align-items: center; gap: 5px; font-weight: 400; font-size: 12px; color: #9e9c9a; cursor: pointer; }
    .toggle input { accent-color: #81b64c; margin: 0; }
    .empty { color: #9e9c9a; padding: 6px 0 2px; }
    .row { display: grid; grid-template-columns: 22px 1fr auto auto; align-items: center; gap: 8px; width: 100%;
      text-align: left; background: none; border: 0; border-radius: 6px; padding: 6px 6px; cursor: pointer; }
    .row:hover { background: #312e2b; }
    .row.sel { background: #3a3734; }
    .sym { font-weight: 800; }
    .mv { font-weight: 600; white-space: nowrap; }
    .tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #3c3a37; color: #d4d3d2; white-space: nowrap; }
    .tag-opening { background: rgba(115,149,82,.35); }
    .tag-middlegame { background: rgba(100,140,200,.3); }
    .tag-endgame { background: rgba(200,120,60,.35); }
    .ev { font-size: 12px; color: #9e9c9a; white-space: nowrap; font-variant-numeric: tabular-nums; }

    .detail { display: flex; gap: 10px; padding: 8px 6px 10px; border-bottom: 1px solid #3c3a37; margin-bottom: 4px; }
    .board { flex: none; width: 150px; height: 150px; border-radius: 4px; overflow: hidden; }
    .board svg { display: block; width: 100%; height: 100%; }
    .coord { font-size: .22px; font-weight: 700; font-family: inherit; }
    .coord.on-light { fill: #739552; } .coord.on-dark { fill: #ebecd0; }
    .detail-text { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; min-width: 0; }
    .line { color: #d4d3d2; font-size: 12px; }

    .foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid #3c3a37; font-size: 12px; display: flex; flex-direction: column; gap: 3px; color: #d4d3d2; }
  `;

  // ================================================================ boot

  chrome.runtime.onMessage.addListener((msg) => {
    if (!game || String(msg?.gameId) !== game.id) return;
    if (msg.type === 'cce:progress' && game.status === 'analyzing') {
      Panel.progress(game.id, msg.done, msg.total);
    } else if (msg.type === 'cce:done' && game.status !== 'done') {
      // The extension's service worker restarted during the analysis: the result comes on its own.
      const g = game;
      if (msg.ok) {
        g.status = 'done';
        Panel.report(g.id, msg.report, true, () => analyze(g, true));
      } else {
        g.status = 'finished';
        Panel.error(g.id, errorText(msg.error), () => analyze(g, false));
      }
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings?.newValue) return;
    const prev = settings;
    settings = { ...settings, ...changes.settings.newValue };
    if (prev.username !== settings.username || prev.showRatings !== settings.showRatings || prev.language !== settings.language || prev.showPeak !== settings.showPeak) {
      document.querySelectorAll('.cce-ratings').forEach((b) => b.remove());
    }
    Panel.rerender();
    tick();
  });

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      tick();
    }, 250);
  };

  send({ type: 'cce:settings' })
    .then((s) => {
      settings = { ...settings, ...s };
    })
    .catch((e) => debug('settings', e))
    .finally(() => {
      if (!alive) return;
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      ticker = setInterval(tick, 1000);
      tick();
    });
})();
