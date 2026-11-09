# Changelog

Toutes les modifications notables de ce projet seront documentées ici.

Le format suit les principes de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et ce projet adhère au [Semantic Versioning](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté

- **Mises à jour (Phase 23, étape 1 — lecture seule)** : bouton « ⬆ Mises à
  jour » dans la barre du haut (permission `updates_read`, admin par défaut)
  qui affiche la version installée, les releases GitHub plus récentes avec leurs
  notes (tags stables `vX.Y.Z` uniquement, jusqu'à 5 versions typées
  correctif / mineure / majeure), un diagnostic de l'installation et la
  commande `deploy.sh update` à lancer soi-même. **Aucune mise à jour n'est
  exécutée depuis l'interface.** Un seul appel `GET` vers l'API GitHub toutes
  les 6 h, sans donnée de l'installation, avec cache disque et ETag ;
  désactivable (`UPDATE_CHECK_ENABLED=0`). Nouvelles routes
  `GET /api/updates/status`, `POST /api/updates/check`,
  `GET /api/updates/diagnostics`. Voir `docs/updates/README.md`.

## [4.1.2] - 2026-11-08

### Ajouté

- **Docker Monitoring (Phase 22)** — monitoring en lecture seule des
  conteneurs Docker (état, CPU, RAM, réseau, I/O, PIDs, logs stdout/stderr
  en direct) dans un nouvel onglet « Docker », via le socket Docker local,
  sans nouvelle dépendance npm. Permissions `docker_read` / `docker_logs`,
  métriques Prometheus `pm2_monitor_docker_*`, variables
  `DOCKER_MONITORING_ENABLED`, `DOCKER_SOCKET_PATH`, `DOCKER_POLL_INTERVAL_MS`.
  Voir `docs/docker/README.md` (dont la section sécurité sur l'accès au
  socket Docker).
- `LogStore#tail()` : lecture des N **dernières** lignes (stdout + stderr,
  horodatées, dans leur ordre réel) d'une instance de process. Sert
  l'historique affiché à la sélection d'un process.
- Vue Process sur mobile (≤ 820 px) : un seul volet à la fois — liste des
  process **ou** logs en plein écran, avec un bouton « ← Processus ».
- Logs Docker : l'abonnement `docker:subscribe-logs` accepte `since` et
  l'événement `docker:log-error` porte `ended` (flux interrompu par un
  arrêt/redémarrage du conteneur).

### Modifié

- `GET /api/processes/:id/logs/tail` : l'historique est lu depuis le
  LogStore (ordre réel stdout/stderr, une heure par ligne) et complété par
  les fichiers natifs PM2 uniquement pour ce qui est plus ancien, sans
  doublon. La réponse gagne `source` (`store` | `native`) et `at` par ligne.
  Sans données du LogStore, repli sur les fichiers natifs (chronologique si
  PM2 écrit les horodatages, sinon stdout puis stderr, séparés par un
  libellé).
- Bouton « Vider » de la console de logs : il appelle désormais
  `POST /api/processes/:id/flush` (après confirmation) et supprime les
  fichiers de log PM2 **et** l'historique du Log Explorer pour ce process.
  Sans la permission `flush`, il vide l'affichage seul et le signale. Côté
  Docker (lecture seule), il vide l'affichage et retient l'instant du
  vidage pour ne plus recharger l'historique antérieur.
- Interface responsive : barre du haut refondue (onglets sur leur propre
  ligne, actions réduites à leur icône sous 1700 px, défilement horizontal
  sur petit écran), menu PM2 ancré sous son bouton, `100dvh`, grille de la
  vue Process à largeur souple, barres d'outils de logs défilantes sur
  mobile.
- README mis à jour : arborescence complète du dépôt (22 migrations, tous les
  services, routes, composants), nouvelle référence des variables
  d'environnement, section Tests, logs (historique, « Vider »), Docker et
  responsive ; liens vers des fichiers supprimés retirés, ajout d'un index
  de la documentation par fonctionnalité.

### Corrigé

- Console de logs : l'historique plaçait tout stderr après tout stdout, si
  bien que la fin de liste (où l'auto-scroll se positionne) n'était que des
  erreurs, parfois très anciennes — impression de ne voir que les erreurs.
- Console de logs (PM2 et Docker) : l'auto-scroll se figeait une fois le
  plafond de 4000 lignes atteint (il surveillait `logs.length`, constante à
  partir de là) ; il suit désormais le compteur de lignes.
- Bouton « Vider » : il ne vidait que la liste en mémoire du navigateur ;
  les lignes revenaient à la re-sélection du process.
- Logs Docker : le flux ne reprenait pas après un redémarrage du conteneur,
  et des lignes pouvaient être perdues entre la lecture de l'historique et
  l'ouverture du flux.
- File d'attente de pause des logs non bornée (croissance mémoire du
  navigateur sur une app bavarde laissée en pause) ; plafonnée comme
  l'affichage.
- Interface : la page débordait horizontalement (jusqu'à ~1580 px de large)
  à toutes les largeurs d'écran à cause de la barre du haut ; plus aucun
  débordement sur les vues testées (390, 820 et 1280 px).

## [4.0.0] - 2026-08-30

### Ajouté

- `deploy.sh` : vérification post-démarrage que l'application répond
  réellement (`wait_for_health`) avant de considérer un `install`/`update`
  réussi — auparavant le script se fiait uniquement au code de retour de
  `pm2 start`, qui réussit même si le process crash-loop juste après.
- `deploy.sh update` : **rollback automatique** vers le commit git
  précédent si la nouvelle version ne passe pas la vérification
  post-démarrage.
- `deploy.sh` : verrou de concurrence (`flock`) empêchant deux exécutions
  simultanées d'`install`/`update`/`uninstall`.
- `deploy.sh` : journalisation de chaque `install`/`update`/`uninstall`
  dans `logs/deploy-<date>-<commande>.log`.
- `deploy.sh` : validation explicite de `--port` (entier entre 1 et 65535)
  avant de s'en servir dans le `.env`, nginx et ufw.
- `deploy.sh --env-file` : sauvegarde automatique de l'ancien `.env`
  (`*.env.bak.<date>`) avant remplacement.
- Nouvelles variables d'environnement `DEPLOY_SKIP_HEALTHCHECK` et
  `HEALTH_TIMEOUT` pour `deploy.sh` (voir README).
- Suite de tests `bats` pour les fonctions pures de `deploy.sh`
  (`test/deploy/deploy_functions.bats`, `npm run test:deploy`).
- CI : job `deploy-script` (shellcheck + `bash -n` + tests bats) pour
  `deploy.sh`.
- 🌐 Internationalisation (i18n) complète de l'interface avec support
  **français / anglais** via `vue-i18n`, sélecteur de langue dans la barre
  du haut, détection automatique de la langue du navigateur, préférence
  persistée en local.
- Fichiers de gouvernance open source : `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE` (MIT).
- Templates GitHub : rapport de bug, demande de fonctionnalité, template de
  Pull Request.
- Workflow CI (GitHub Actions) : tests unitaires + intégration sur Node 20
  et 22, build du frontend, vérification de parité des clés de traduction.
- Script `scripts/check-i18n.js` (`npm run check:i18n`) pour vérifier que
  les fichiers `fr.json` et `en.json` restent synchronisés.
- Outillage qualité : ESLint (backend + frontend), Prettier, EditorConfig,
  `.gitattributes`, `.nvmrc`.
- Hygiène Git : hooks Husky (`pre-commit` → lint-staged, `commit-msg` →
  commitlint / Conventional Commits), `.github/CODEOWNERS`.
- CI étendue avec un job `lint` dédié (ESLint + Prettier + parité i18n) en
  plus des tests et du build.

### Corrigé

- `deploy.sh` : le script acceptait Node.js ≥16 alors que le projet exige
  ≥20 (`engines.node` dans `package.json`) — la version minimale requise
  est désormais lue dynamiquement depuis `package.json` au lieu d'être
  dupliquée en dur et désynchronisée.
- **Node.js >= 22 requis** (au lieu de >= 20) : le frontend dépend de
  `vue-i18n`/`@intlify` ≥11.4, qui exigent réellement Node ≥22
  (`npm warn EBADENGINE` sur un serveur en Node 20). `engines.node`,
  `.nvmrc`, le badge du README et la matrice CI sont alignés sur v22.
- `deploy.sh` : les modules natifs (`better-sqlite3`...) restaient compilés
  pour l'ancienne version de Node après un passage à une version plus
  récente (ex: 20 → 22 via `ensure_nodejs`), provoquant un crash au
  démarrage (`ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch) —
  `npm install` seul ne les recompile pas quand ni `package.json` ni le
  lockfile n'ont changé. Le script détecte désormais un changement de
  version de Node depuis la dernière installation et force `npm rebuild`
  dans ce cas (install, update, et rollback).
- `npm install`/`npm ci` en production (`--omit=dev`, utilisés par
  `deploy.sh`) plantaient systématiquement sur un serveur neuf : le script
  `prepare` (`husky`) s'exécute même sans devDependencies installées, et
  échouait avec `husky: not found` (exit 127), bloquant toute installation.
  `prepare` ignore désormais cet échec (`husky || true`) — sans danger,
  husky sert uniquement aux hooks Git en développement local.
- `package.json` : le champ `version` n'était pas un semver valide
  (`3.5.f`) — corrigé en `3.5.0`.
- `npm run test:unit` / `test:integration` utilisaient un pattern de glob
  non supporté par le test runner de Node et plantaient immédiatement
  (`Cannot find module 'test/unit'`) — corrigé.
- Suite de tests validée à 576/576 (unitaires + intégration, exécutés
  ensemble comme en CI) après réinstallation propre des dépendances.
- `npm test` / `test:unit` / `test:integration` s'appuyaient sur le
  support du glob `**` ou du chemin de répertoire nu par
  `node --test`, tous deux non fiables selon la version de Node et l'OS
  (confirmé en échec sur GitHub Actions avec Node 22.23.2 avec l'un et
  l'autre). Remplacé par `scripts/run-tests.js`, qui énumère les fichiers
  `*.test.js` à la main en JS pur avant de les passer explicitement à
  `node --test` — comportement documenté et stable.

## Format des entrées futures

Chaque nouvelle version doit lister ses changements sous les catégories :
`Ajouté`, `Modifié`, `Déprécié`, `Supprimé`, `Corrigé`, `Sécurité`.

[Non publié]: https://github.com/nogebeat/pm2-monitor/compare/v4.1.2...HEAD
[4.1.2]: https://github.com/nogebeat/pm2-monitor/compare/v4.0.0...v4.1.2
[4.0.0]: https://github.com/nogebeat/pm2-monitor/releases/tag/v4.0.0

