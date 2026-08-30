# Captures d'écran

Les fichiers `.svg` de ce dossier sont des **placeholders illustratifs**
(générés, pas de vraies captures) qui tiennent la place dans le README et
`docs/features.md` en attendant de vraies images. Chacun porte un filigrane
explicite "Aperçu illustratif" pour ne tromper personne entre-temps.

## À remplacer

| Fichier actuel     | À remplacer par    | Vue à capturer                                                                       |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------ |
| `dashboard.svg`    | `dashboard.png`    | Écran d'accueil : liste des process, statuts, CPU/mémoire                            |
| `live-logs.svg`    | `live-logs.png`    | Vue "Logs en direct" avec au moins un process actif et quelques lignes stdout/stderr |
| `log-explorer.svg` | `log-explorer.png` | Log Explorer avec un filtre actif (ex. `level:error`) et des résultats               |

## Comment capturer

1. Lance le monitor en local avec au moins 2-3 process PM2 réels qui
   tournent (idéalement un avec un peu d'activité de logs, un autre en
   `restarting` pour montrer un statut non-trivial).
2. Ouvre le dashboard dans Chrome/Firefox, fenêtre à **1280×800** environ
   (évite le zoom navigateur à autre chose que 100%).
3. Capture chaque vue :
   - macOS : `Cmd+Shift+4` puis barre d'espace pour capturer une fenêtre.
   - Windows : `Win+Shift+S`.
   - Linux : `gnome-screenshot -w` ou l'outil de capture de ton DE.
4. Recadre pour ne garder que la fenêtre du navigateur (pas la barre des
   tâches / le bureau).
5. Exporte en PNG, compresse-le (ex. `npx sharp-cli --input dashboard.png
--output dashboard.png -- resize 1280` ou simplement TinyPNG) pour rester
   sous ~300 Ko par image.
6. Remplace le fichier `.svg` correspondant par le `.png`, puis mets à jour
   les deux références dans :
   - `README.md` (tout en haut, section captures)
   - `docs/features.md` (bandeau en tête de fichier)

   (recherche `docs/screenshots/` dans les deux fichiers pour trouver les
   balises `<img>` à ajuster — juste changer l'extension `.svg` → `.png`
   suffit si tu gardes les mêmes noms de fichiers.)

Un GIF court (5-10s, captation avec [Kap](https://getkap.co/) sur macOS ou
[peek](https://github.com/phw/peek) sur Linux) pour les logs en direct est
un bon complément optionnel — les logs qui défilent en temps réel se
montrent mieux en mouvement qu'en image fixe.
