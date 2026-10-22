# Chrome Web Store: listing content

Copy each block into the matching field of the Developer Dashboard (https://chrome.google.com/webstore/devconsole).

## Package

- File: `store/better-chess-com-free-1.0.0.zip` (built from the extension folder, `store/` excluded)
- Category: **Tools** (or "Fun", Chess has no dedicated category)
- Language: English (localized name and short description come from `_locales/`)

## Store listing

### Title
Better Chess.com Free

### Short description (from the manifest, 124 characters)
Both players' rapid, blitz and bullet ratings with peaks, and a Stockfish review of your errors by game phase for chess.com.

### Detailed description (English)

Better Chess.com Free adds two things to chess.com.

RATINGS OF BOTH PLAYERS, IN GAME
Next to each player's name: their rapid, blitz and bullet ratings, with each all-time peak in parentheses (can be hidden). Hover a rating for the peak date and number of games. Ratings refresh by themselves when your game ends.

A STOCKFISH REVIEW OF YOUR ERRORS, BY GAME PHASE
When one of your games ends, Stockfish 19 runs in your browser (several engines in parallel, a few seconds) and a panel shows:
- your weak spot of the game: opening, middlegame or endgame
- for each phase: accuracy, blunders, mistakes and inaccuracies
- the evaluation graph split by phase, with your errors marked on it
- every error with the position, the move you played and the best move, and the best line; one click moves the chess.com board to that move
- the opening you played, with its ECO code

YOUR WEAK PHASE, GAME AFTER GAME
The toolbar popup sums up your last 10, 20 or 50 analyzed games: errors per phase, accuracy, and the phase where you make the most serious errors.

FAIR PLAY
The analysis only starts once chess.com reports the game as finished. Better Chess.com Free never analyzes a game in progress.

SIX LANGUAGES
English, French, German, Russian, Spanish and Italian, including the opening names.

PRIVACY
No account, no tracking, no server of its own. Your history and settings stay in your browser. The only network requests go to chess.com (the game you just played, public player statistics).

SUPPORT
Better Chess.com Free is free. If it helps you, you can support its development on Ko-fi: https://ko-fi.com/germaincasse

Better Chess.com Free is an independent project, not affiliated with or endorsed by Chess.com.
Stockfish (GPL-3.0), chess.js (BSD-2-Clause), opening names from lichess-org/chess-openings (CC0), cburnett pieces (GPLv2+).

### Graphic assets
- Icon 128x128: `icons/icon128.png`
- Screenshots 1280x800: `store/screenshot-1-analysis.png`, `store/screenshot-2-ratings.png`, `store/screenshot-3-overview.png`
- Small promo tile 440x280: `store/promo-small-440x280.png`

## Privacy practices tab

### Single purpose
Help chess.com players review their own games: show both players' ratings during a game and analyze the user's finished games with Stockfish, by game phase.

### Permission justifications
- **storage**: saves the user's settings, the history of analyzed games and the analysis reports locally.
- **offscreen**: Stockfish runs in Web Workers, which a Manifest V3 service worker cannot create; an offscreen document hosts them during an analysis and is closed when idle.
- **alarms**: closes the offscreen engine document 5 minutes after the last analysis to free memory.
- **Host permission https://www.chess.com/\***: the content script shows ratings next to the players' names and the analysis panel on game pages, and reads the moves of the finished game from chess.com.
- **Host permission https://api.chess.com/\***: reads the public statistics (ratings and peaks) of the two players from the official chess.com public API.

### Remote code
No, I am not using remote code. (Stockfish is bundled as WebAssembly in the package.)

### Data usage
- Collected data: none of the listed categories is sent to the developer. The extension reads chess.com usernames and game moves to work, processes them locally and does not transmit them anywhere except to chess.com itself.
- Check the three certifications (no selling, no unrelated use, no creditworthiness use).

### Privacy policy URL
https://github.com/germaincasse/Better-Chess.com/blob/main/store/privacy-policy.md

### Homepage / support URL
https://github.com/germaincasse/Better-Chess.com
