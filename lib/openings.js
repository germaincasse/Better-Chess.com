// Opening names: Lichess chess-openings dataset (CC0) in English, with per-language dictionaries
// translating each name segment ("Sicilian Defense", "Najdorf Variation"...).

let dbPromise = null;
const dicts = new Map();

/** Map from position key (first 4 FEN fields) to [eco, English name]. */
export function loadOpeningDb() {
  dbPromise ??= fetch(chrome.runtime.getURL('openings/openings.json'))
    .then((r) => r.json())
    .catch(() => ({}));
  return dbPromise;
}

const positionKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

/** Deepest named position reached by the game's moves. */
export function detectOpening(plies, db) {
  let found = null;
  for (const p of plies) {
    const entry = db[positionKey(p.fenAfter)];
    if (entry) found = { eco: entry[0], name: entry[1], ply: p.ply };
  }
  return found;
}

async function loadDict(lang) {
  if (!dicts.has(lang)) {
    dicts.set(
      lang,
      fetch(chrome.runtime.getURL(`openings/i18n/${lang}.json`))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    );
  }
  return dicts.get(lang);
}

/** "Sicilian Defense: Najdorf Variation, English Attack" in the given language (English if unknown). */
export async function translateOpening(name, lang) {
  if (!name || !lang || lang === 'en') return name;
  const dict = await loadDict(lang);
  if (!dict) return name;
  return name
    .split(/(: |, )/)
    .map((part, i) => {
      if (i % 2 === 0) return dict[part] ?? part;
      // French typography puts a space before the colon.
      return lang === 'fr' && part === ': ' ? ' : ' : part;
    })
    .join('');
}
