import { getSettings, saveSettings } from '../lib/settings.js';
import { translateOpening } from '../lib/openings.js';

const PHASES = ['opening', 'middlegame', 'endgame'];
const { LANGUAGES } = globalThis.CCE_I18N;

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

const settings = await getSettings();
const t = (key, params) => globalThis.CCE_I18N.t(settings.language, key, params);
const pct = (n) => t('fmt.pct', { n });
const countOf = (cls, n) => t(`cls.${cls}`, { n });

// Fills every [data-i18n] (text), [data-i18n-title] and [data-i18n-placeholder] in the page.
function applyI18n() {
  document.documentElement.lang = settings.language;
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const n = node.dataset.i18nN;
    node.textContent = t(node.dataset.i18n, n ? { n: Number(n) } : undefined);
  }
  // Column tooltips use the singular word: "blunder", "gaffe", "зевок"...
  for (const node of document.querySelectorAll('[data-i18n-title]')) {
    node.title = t(node.dataset.i18nTitle, { n: 1 }).replace(/^1\s+/, '');
  }
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
}

// ---------------------------------------------------------------- tabs

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
    for (const pane of document.querySelectorAll('.pane')) pane.hidden = pane.id !== tab.dataset.tab;
  });
}

// ---------------------------------------------------------------- settings

const language = $('language');
language.append(...Object.entries(LANGUAGES).map(([code, name]) => el('option', { value: code }, name)));
language.value = settings.language in LANGUAGES ? settings.language : 'en';
language.addEventListener('change', async () => {
  settings.language = language.value;
  await saveSettings({ language: language.value });
  applyI18n();
  renderStats();
});

for (const id of ['showRatings', 'showPeak', 'autoAnalyze', 'showInaccuracies', 'syncBoard']) {
  $(id).checked = !!settings[id];
  $(id).addEventListener('change', () => saveSettings({ [id]: $(id).checked }));
}

for (const id of ['depth', 'engines']) {
  $(id).value = String(settings[id]);
  $(id).addEventListener('change', () => saveSettings({ [id]: Number($(id).value) }));
}

for (const id of ['openingMoves', 'endgamePieces']) {
  const input = $(id);
  input.value = String(settings[id]);
  input.addEventListener('change', () => {
    const v = Math.round(Number(input.value));
    const min = Number(input.min);
    const max = Number(input.max);
    if (!Number.isFinite(v)) {
      input.value = String(settings[id]);
      return;
    }
    const clamped = Math.max(min, Math.min(max, v));
    input.value = String(clamped);
    saveSettings({ [id]: clamped });
  });
}

$('username').value = settings.username;
$('username').addEventListener('change', () => saveSettings({ username: $('username').value.trim() }));

// ---------------------------------------------------------------- stats

const RANGE_KEY = 'chessCoachRange';
try {
  const saved = localStorage.getItem(RANGE_KEY);
  if (saved) $('range').value = saved;
} catch {}

$('range').addEventListener('change', () => {
  try {
    localStorage.setItem(RANGE_KEY, $('range').value);
  } catch {}
  renderStats();
});

function aggregate(games) {
  const out = {};
  for (const key of PHASES) {
    const a = { blunder: 0, mistake: 0, inaccuracy: 0, moves: 0, games: 0, accWeighted: 0 };
    for (const g of games) {
      const p = g.phases?.[key];
      if (!p?.moves) continue;
      a.games++;
      a.moves += p.moves;
      a.blunder += p.blunder;
      a.mistake += p.mistake;
      a.inaccuracy += p.inaccuracy;
      a.accWeighted += (p.accuracy ?? 0) * p.moves;
    }
    a.accuracy = a.moves ? Math.round(a.accWeighted / a.moves) : null;
    a.serious = a.blunder + a.mistake;
    // Serious errors per move, comparable between phases of different lengths; the verdict
    // ranks and words phases with this same rate.
    a.rate = a.moves ? a.serious / a.moves : 0;
    out[key] = a;
  }
  return out;
}

function renderVerdict(agg) {
  const box = $('verdict');
  const ranked = PHASES.filter((p) => agg[p].moves >= 10 && agg[p].serious > 0).sort(
    (a, b) => agg[b].rate - agg[a].rate || agg[b].blunder - agg[a].blunder,
  );
  box.replaceChildren();
  if (!ranked.length) {
    box.className = 'verdict good';
    box.append(el('b', {}, t('popup.verdict.noneTitle')), t('popup.verdict.noneText'));
    return null;
  }
  const weak = ranked[0];
  const a = agg[weak];
  box.className = 'verdict';
  const every = Math.max(1, Math.round(a.moves / a.serious));
  const others = PHASES.filter((p) => p !== weak && agg[p].moves && agg[p].serious)
    .map((p) => t('popup.verdict.item', { n: Math.round(agg[p].moves / agg[p].serious), in: t(`phaseIn.${p}`) }))
    .join(', ');
  box.append(
    el('b', {}, t('popup.verdict.weakTitle', { phase: t(`phaseThe.${weak}`) })),
    `${t('popup.verdict.weakText', { n: every, in: t(`phaseIn.${weak}`) })}${others ? t('popup.verdict.vs', { list: others }) : ''}.`,
  );
  return weak;
}

function renderPhaseRows(agg, weak) {
  const rows = PHASES.map((p) => {
    const a = agg[p];
    const num = (cls, n) => el('td', { class: `${cls}${n ? '' : ' zero'}` }, String(n));
    return el(
      'tr',
      { class: p === weak ? 'weak' : null },
      el('td', {}, t(`phase.${p}`), el('span', { class: 'sub' }, t('popup.games', { n: a.games }))),
      num('b', a.blunder),
      num('m', a.mistake),
      num('i', a.inaccuracy),
      el('td', {}, a.serious ? t('popup.moves', { n: Math.round(a.moves / a.serious) }) : '-'),
      el('td', {}, a.accuracy != null ? pct(a.accuracy) : '-'),
    );
  });
  $('phase-rows').replaceChildren(...rows);
}

function renderGames(games) {
  const items = games.slice(0, 12).map((g) => {
    const date = new Date(g.date).toLocaleDateString(settings.language, { day: '2-digit', month: '2-digit' });
    const ph = el(
      'span',
      { class: 'ph' },
      ...PHASES.map((p) => {
        const s = g.phases?.[p];
        const label = t(`phase.${p}`);
        const short = t(`phaseShort.${p}`);
        if (!s?.moves) return el('span', { class: 'none', title: t('popup.notReached', { phase: label }) }, `${short} -`);
        const n = s.blunder + s.mistake;
        const title = t('popup.phaseTitle', {
          phase: label,
          b: countOf('blunder', s.blunder),
          m: countOf('mistake', s.mistake),
          i: countOf('inaccuracy', s.inaccuracy),
        });
        return el('span', { class: n ? 'bad' : null, title }, `${short} ${n}`);
      }),
    );
    const resLabel = t(`result.${g.result ?? 'draw'}`);
    const opening = g.opening ? el('div', { class: 'opening' }, el('span', { class: 'eco' }, g.opening.eco), g.opening.name) : null;
    if (opening) {
      translateOpening(g.opening.name, settings.language).then((name) => {
        opening.lastChild.textContent = name;
        opening.title = `${g.opening.eco} · ${name}`;
      });
    }
    return el(
      'li',
      {},
      el('span', { class: `res ${g.result ?? 'draw'}`, title: resLabel }),
      el(
        'div',
        { class: 'main' },
        el('a', { href: g.url, target: '_blank', title: `${resLabel} · ${t('popup.vs', { name: g.opponent })}` }, t('popup.vs', { name: g.opponent }), el('span', { class: 'date' }, date)),
        opening,
      ),
      ph,
    );
  });
  $('games').replaceChildren(...items);
}

async function renderStats() {
  const { history = [] } = await chrome.storage.local.get('history');
  const games = history.slice(0, Number($('range').value));
  $('empty').hidden = games.length > 0;
  $('summary').hidden = games.length === 0;
  if (!games.length) return;
  const agg = aggregate(games);
  const weak = renderVerdict(agg);
  renderPhaseRows(agg, weak);
  renderGames(games);
}

$('clear').addEventListener('click', async () => {
  if (!confirm(t('popup.clearConfirm'))) return;
  await chrome.runtime.sendMessage({ type: 'cce:clearHistory' });
  renderStats();
});

applyI18n();
renderStats();
