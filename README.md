# Better Chess.com Free

Extension Chrome pour chess.com : elo des deux joueurs en partie et analyse Stockfish de fin de partie par phase de jeu.

Sources : https://github.com/germaincasse/Better-Chess.com · Soutien : https://ko-fi.com/germaincasse

## Fonctionnalités

- **Elo des joueurs en partie** : à côté de ton pseudo et de celui de l'adversaire, les elo rapide, blitz et bullet, avec le pic de chaque cadence entre parenthèses. Le survol d'un elo donne la date du pic et le nombre de parties. Données de l'API publique chess.com, en cache 15 minutes.
- **Analyse Stockfish de fin de partie** : dès qu'une de tes parties se termine, Stockfish 19 analyse chaque position (plusieurs moteurs en parallèle, environ 5 à 10 secondes en profondeur 14), puis un panneau s'ouvre avec :
  - le point faible de la partie (ouverture, milieu de jeu ou finale) et le détail des gaffes et erreurs par phase ;
  - une carte par phase : coups concernés, précision, gaffes (??), erreurs (?) et imprécisions (?!) ; un clic filtre la liste ;
  - la courbe d'évaluation découpée par phase, avec tes erreurs pointées dessus ;
  - la liste de tes erreurs : un clic affiche la position avec le coup joué (rouge/orange) et le meilleur coup (vert), la suite proposée, et place l'échiquier chess.com sur ce coup.
- **Bilan dans le popup** : sur les 10, 20 ou 50 dernières parties analysées, nombre de gaffes et d'erreurs par phase, précision moyenne, fréquence des erreurs graves et phase la plus faible.
- **Ouverture jouée** : nom et code ECO de l'ouverture la plus profonde atteinte (base Lichess, 3 177 noms), dans le rapport et dans la liste des parties du popup.
- **Mise à jour des elo** : quand ta partie se termine, les elo des deux joueurs sont relus (3 s puis 20 s après la fin). Le pic entre parenthèses peut être masqué dans les réglages.
- **Soutien** : bouton Ko-fi en bas du popup.
- **Six langues** : anglais (par défaut), français, allemand, russe, espagnol et italien, au choix dans le popup (onglet Settings / Réglages). L'interface et les noms d'ouvertures sont traduits.

Une partie déjà terminée ouverte plus tard (historique, lien) affiche une pastille "Analyser la partie" au lieu de lancer l'analyse toute seule. L'extension n'analyse jamais une partie en cours : elle demande à chess.com si la partie est terminée avant de lancer Stockfish.

## Phases de jeu

| Phase | Règle (réglable dans le popup) |
| --- | --- |
| Ouverture | coups 1 à 8 |
| Finale | après l'ouverture, au plus 6 cavaliers, fous, tours et dames sur l'échiquier (les deux camps, hors rois et pions) |
| Milieu de jeu | le reste |

Classement d'un coup selon la perte de chances de gain (modèle Lichess) : imprécision à partir de 5 points, erreur à partir de 10, gaffe à partir de 15.

## Installation

1. Ouvrir `chrome://extensions`.
2. Activer le **Mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée** et choisir ce dossier.
4. Recharger les onglets chess.com déjà ouverts.

Après une modification des fichiers : bouton de rechargement de l'extension dans `chrome://extensions`, puis recharger l'onglet chess.com.

Le pseudo chess.com est détecté depuis la page quand tu es connecté. Sinon, le renseigner dans le popup (onglet Réglages).

## Fonctionnement

| Fichier | Rôle |
| --- | --- |
| `content/content.js` | Sur chess.com : badges d'elo, détection de fin de partie, panneau d'analyse (Shadow DOM) |
| `content/page-user.js` | Lit le pseudo connecté (`window.context.user`) dans le contexte de la page |
| `background.js` | Service worker : API chess.com (stats), cache, historique, pilotage du moteur |
| `offscreen.html`, `offscreen.js` | Document offscreen qui héberge les workers Stockfish (un service worker ne peut pas en créer) |
| `lib/analysis.js` | Décodage des coups chess.com, phases, évaluation, classement des coups |
| `lib/engine-pool.js` | Pool de workers Stockfish (UCI) |
| `lib/i18n.js` | Textes de l'interface dans les six langues (pluriels via `Intl.PluralRules`) |
| `lib/openings.js` | Détection de l'ouverture et traduction de son nom |
| `openings/openings.json` | Positions nommées (base Lichess chess-openings) |
| `openings/i18n/<langue>.json` | Traduction de chaque segment de nom ("Sicilian Defense", "Najdorf Variation"...) |
| `_locales/` | Nom et description de l'extension dans `chrome://extensions` |
| `popup/` | Bilan par phase et réglages |
| `engine/` | Stockfish 19 lite, WebAssembly mono-thread |

Les coups viennent de `https://www.chess.com/callback/{live|daily}/game/{id}` (même endpoint que la page de partie), les elo de `https://api.chess.com/pub/player/{pseudo}/stats`. Rien n'est envoyé ailleurs ; historique et réglages restent dans `chrome.storage.local`.

Le moteur offscreen se ferme 5 minutes après la dernière analyse.

## Dépannage

- Journal du content script : dans la console de la page chess.com, `localStorage.setItem('chessCoachDebug', '1')` puis recharger.
- Journal du moteur : `chrome://extensions`, lien "service worker" ou "offscreen.html" de l'extension.
- Les badges d'elo s'appuient sur le DOM de chess.com (`[data-test-element="user-tagline-username"]`, `.player-component`). Si chess.com change sa mise en page, c'est le premier endroit à vérifier.

## Licences

- [stockfish.js](https://github.com/nmrugg/stockfish.js) : GPL-3.0
- [chess.js](https://github.com/jhlywa/chess.js) : BSD-2-Clause (`lib/chess.js.LICENSE`)
- Noms d'ouvertures : [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0)

L'ensemble est sous GPL-3.0 (voir [LICENSE](LICENSE)).
