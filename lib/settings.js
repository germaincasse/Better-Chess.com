export const DEFAULT_SETTINGS = {
  /** UI language: en, fr, de, ru, es, it. */
  language: 'en',
  /** chess.com username; empty: detected from the page. */
  username: '',
  showRatings: true,
  /** Peak rating in parentheses after each rating. */
  showPeak: true,
  autoAnalyze: true,
  depth: 14,
  /** 0: automatic. */
  engines: 0,
  /** Moves 1..N count as the opening. */
  openingMoves: 8,
  /** Endgame once knights + bishops + rooks + queens (both sides) are at most N. */
  endgamePieces: 6,
  showInaccuracies: false,
  /** Clicking a mistake in the report also moves the chess.com board to it. */
  syncBoard: true,
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}
