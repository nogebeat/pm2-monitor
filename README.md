# PM2 Monitor

[![CI](https://github.com/nogebeat/pm2-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/nogebeat/pm2-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Interface graphique complète pour surveiller tes apps PM2 : liste des process,
statut, CPU/mémoire, redémarrages, et **logs en direct** (stdout/stderr) via WebSocket.

Ce n'est pas une page web statique : c'est un petit serveur Node.js à faire
tourner **sur la machine où PM2 gère déjà tes apps** (il se branche sur l'API
programmatique de PM2, comme le ferait `pm2 monit` en ligne de commande), avec
un frontend **Vue 3 + Vite** qui consomme cette API en REST + WebSocket.

🌐 Interface disponible en **français** et **anglais** (sélecteur de langue
dans la barre du haut). 🤝 Projet open source — contributions bienvenues,
voir [CONTRIBUTING.md](CONTRIBUTING.md).

## Stack technique

- **Backend** : Node.js, Express, `pm2` (API programmatique), Socket.IO,
  `nodemailer` (envoi SMTP pour le provider de notification Email).
- **Frontend** : Vue 3 (`<script setup>`), Vite, Chart.js, Socket.IO client.
  Le frontend est **compilé** (`npm run build`) en fichiers statiques servis
  directement par Express — il n'y a pas de serveur Node séparé à exposer
  en production, un seul port suffit.
- **Comptes / permissions** : base **SQLite** locale par défaut (zéro
  dépendance externe, fichier dans `data/monitor.db`), ou **MySQL/MariaDB**
  en option si tu as déjà un serveur SQL (`DB_DRIVER=mysql`). Voir
  [Multi-utilisateurs & permissions](#multi-utilisateurs--permissions).
- L'historique système et les logs persistés restent en fichiers locaux
  (`data/`), indépendamment de la base choisie ci-dessus.

Structure du dépôt :

```
pm2-monitor/
├── server.js              # orchestration uniquement : config, instanciation des
│                           # services, montage des routers/temps réel, boot (~260 lignes)
├── lib/
│   ├── db/                 # abstraction base de données (sqlite-driver.js, mysql-driver.js)
│   │   ├── migrations/       # migrations versionnées :
│   │   │   ├── 001_initial_schema.js    # users, permissions
│   │   │   ├── 002_job_queue.js         # jobs (file d'attente persistante)
│   │   │   ├── 003_alert_engine.js      # alert_rules, alerts
│   │   │   ├── 004_process_metrics.js   # process_metrics_raw, process_metrics_rollup
│   │   │   ├── 005_process_events.js    # process_events (timeline)
│   │   │   ├── 006_notifications.js     # notification_providers, notification_routes, notification_history
│   │   │   ├── 007_notification_routing_templates.js  # colonnes de template sur notification_routes
│   │   │   ├── 008_health_checks.js     # health_checks (Phase 6)
│   │   │   ├── 009_auto_healing.js      # auto_healing_settings/state/audit (Phase 7)
│   │   │   ├── 010_health_checks_process_name.js
│   │   │   └── 011_audit_log.js         # audit_log append-only (Phase 9)
│   │   └── migrator.js        # exécution des migrations (up/down/status)
│   ├── services/
│   │   ├── queue/             # file d'attente persistante générique (voir README dédié)
│   │   ├── alerts/            # moteur d'alertes (seuils, cooldown, dédup)
│   │   ├── process-history/   # historique CPU/RAM/restarts par process, multi-résolution
│   │   ├── events/            # timeline d'événements/crashs PM2
│   │   ├── notifications/     # providers Email/Discord/Telegram/Slack/Webhook, secrets chiffrés
│   │   ├── health-checks/     # sondes HTTP/TCP/Command indépendantes du statut PM2 (Phase 6)
│   │   ├── auto-healing/      # redémarrage automatique + garde-fous, désactivé par défaut (Phase 7)
│   │   └── audit/             # journal d'audit append-only des actions sensibles (Phase 9)
│   ├── routes/                # routes REST par domaine : alerts.js, events.js, notifications.js,
│   │   │                       # health-checks.js, auto-healing.js, dashboard.js, audit.js,
│   │   │                       # auth.js, users.js, processes.js, pm2-daemon.js, system.js, logs.js,
│   │   │                       # log-explorer.js (recherche globale, Phase 12)
│   ├── realtime/               # branchement Socket.IO/PM2 hors REST :
│   │   │                       # process-socket.js (liste process par client), pm2-bus.js (bus
│   │   │                       # logs/événements PM2 + démarrage du serveur HTTP)
│   ├── polling.js              # les deux boucles setInterval (snapshot système, éval process)
│   ├── alert-dispatch.js       # fan-out d'une transition d'alerte : notifications/websocket/auto-healing
│   ├── process-helpers.js      # helpers partagés par les routers process (fmtProcess,
│   │                           # visibleProcesses, withAppPermission…)
│   ├── bootstrap.js            # loadDotEnv() + création du compte admin par défaut
│   ├── auth.js              # sessions, middlewares requireAuth / requirePermission / requireAdmin
│   ├── user-store.js        # CRUD utilisateurs + permissions
│   ├── permissions.js        # catalogue des actions (par app / globales) + hasPermission()
│   └── …                    # actions PM2, stats système, logs, historique
├── bin/
│   ├── manage-users.js       # CLI de gestion des comptes (create, grant, revoke, promote…)
│   └── migrate.js             # CLI de migrations DB (up, down, status)
├── test/
│   ├── unit/, integration/, helpers/   # voir section Tests
├── docs/
│   ├── ARCHITECTURE.md        # décisions d'architecture (migrations, queue, tests)
│   ├── alerts/README.md       # détail du moteur d'alertes
│   ├── events/README.md       # détail de la timeline d'événements
│   ├── health-checks/README.md  # détail des health checks HTTP/TCP/Command (Phase 6)
│   ├── auto-healing/README.md   # détail Auto-Healing : garde-fous, activation, sécurité (Phase 7)
│   ├── audit/README.md          # détail de l'audit log : événements, sanitization, sécurité, API (Phase 9)
│   ├── multi-server/README.md   # multi-serveurs / agents distants : architecture, sécurité, install (Phase 10)
│   ├── log-explorer/README.md   # recherche globale multi-process/multi-serveur, garde-fous (Phase 12)
│   └── notifications/
│       ├── README.md            # architecture, registry, secrets, API, permissions
│       └── providers/            # un .md par provider (config, sécurité, test, erreurs)
├── frontend/                # source du frontend Vue 3 + Vite
│   ├── src/
│   │   ├── components/        # TopBar, ProcessSidebar, LogsPanel, SystemView, EventsView,
│   │   │                       # ServersView, LogExplorerView, LoginScreen, modales…
│   │   ├── store.js            # état réactif partagé (process, logs, système, auth)
│   │   ├── socket.js, api.js, format.js
│   │   └── style.css
│   └── vite.config.js
├── public/                  # ⚠️ généré par `npm run build` — ne pas éditer à la main
└── deploy.sh
```

## Installation

### Option rapide : script de déploiement automatique

Sur un serveur Linux (Ubuntu/Debian ou CentOS/RHEL/Rocky/AlmaLinux), en root
ou avec sudo :

```bash
cd pm2-monitor
chmod +x deploy.sh
./deploy.sh install
```

Ce script gère **toutes les situations** en une commande :

- installe Node.js (version alignée sur `engines.node` de `package.json`) et PM2 s'ils sont absents (ne touche à rien s'ils sont déjà là)
- installe les dépendances du serveur **et** celles du frontend
- **compile le frontend Vue 3 / Vite** (`frontend/` → `public/`)
- génère un `.env` avec un mot de passe sécurisé si tu n'en fournis pas
- démarre l'app sous PM2, **vérifie qu'elle répond réellement** (pas juste que `pm2 start` a réussi) et configure le redémarrage automatique au reboot
- (optionnel) configure nginx en reverse proxy + HTTPS via Let's Encrypt si tu donnes un domaine
- (optionnel) ouvre les bons ports dans le pare-feu (`ufw`) si présent
- relançable sans risque : il détecte ce qui est déjà en place et **rebuild le frontend à chaque `update`**
- **`update` fait un rollback automatique** (retour au commit git précédent) si la nouvelle version ne démarre pas correctement
- **refuse deux exécutions simultanées** (verrou `flock`) et **journalise** chaque `install`/`update`/`uninstall` dans `logs/deploy-*.log`

**Exemples :**

```bash
# Accès direct par IP:port, sans nginx (SQLite par défaut, zéro-config)
./deploy.sh install --port 4200 --user admin --pass "mon-mot-de-passe"

# Avec nom de domaine + HTTPS automatique
./deploy.sh install --domain pm2.mondomaine.fr --email moi@mondomaine.fr

# Environnement minimal (conteneur, pas de pare-feu ni nginx à toucher)
./deploy.sh install --no-nginx --no-firewall --no-startup --yes

# En centralisant comptes/permissions dans un serveur MySQL existant
./deploy.sh install --db-driver mysql --db-host 127.0.0.1 --db-user pm2_monitor --db-pass "..." --db-name pm2_monitor

# En fournissant un .env déjà prêt (généré ailleurs, secret manager, copié
# d'une autre machine…) plutôt que de reconstruire la config via des flags
./deploy.sh install --env-file /chemin/vers/mon.env --no-nginx --yes
```

`--env-file <chemin>` copie ce fichier tel quel comme `.env` du projet
(permissions restreintes à `600`) et **prend le pas** sur `--port` /
`--user` / `--pass` / `--db-*` s'ils sont fournis en même temps — ces
derniers sont alors ignorés, édite directement le fichier source à la
place. Les options qui ne concernent pas le `.env` (`--domain`, `--email`,
`--no-nginx`, `--no-firewall`, `--no-startup`, `--yes`) continuent, elles,
de s'appliquer normalement.

**Autres commandes :**

```bash
./deploy.sh status      # état du process PM2
./deploy.sh logs        # logs en direct
./deploy.sh restart     # redémarrer
./deploy.sh stop        # arrêter
./deploy.sh update      # git pull (si dépôt git) + npm install + build frontend + restart
./deploy.sh users …     # gérer comptes / permissions en ligne de commande (voir plus bas)
./deploy.sh uninstall           # retire le process PM2
./deploy.sh uninstall --purge   # + supprime .env, node_modules (serveur + frontend), le build public/, config nginx
```

Voir toutes les options : `./deploy.sh --help`

**Variables d'environnement utiles :**

```bash
# Ignore la vérification post-démarrage (déconseillé : c'est ce qui permet
# le rollback automatique de `update` en cas de nouvelle version cassée)
DEPLOY_SKIP_HEALTHCHECK=1 ./deploy.sh update

# Ajuste le délai d'attente de cette vérification (défaut : 30s)
HEALTH_TIMEOUT=60 ./deploy.sh install

# Ignore la suite de tests avant de démarrer/redémarrer (déconseillé)
DEPLOY_SKIP_TESTS=1 ./deploy.sh update
```

Chaque `install`/`update`/`uninstall` écrit son déroulé complet dans
`logs/deploy-<date>-<commande>.log`, utile pour rejouer ce qui s'est passé
après coup (notamment si `update` est déclenché sans surveillance directe,
ex: via cron).

Le script refuse de tourner deux fois en parallèle (verrou dans
`.deploy.lock`) : si une exécution précédente a planté sans nettoyer ce
fichier, supprime-le avant de relancer.

**Tests du script lui-même :** les fonctions pures de `deploy.sh`
(validation du port, parsing du `.env`, génération de mot de passe...) ont
leur propre suite `bats`, indépendante des tests Node de l'application :

```bash
npm run test:deploy
# équivalent : bats test/deploy/deploy_functions.bats
```

### Option manuelle

```bash
cd pm2-monitor
npm install        # installe les deps serveur + déclenche l'install des deps frontend (postinstall)
npm run build       # compile le frontend Vue 3 / Vite dans public/
```

## Lancer le monitor

### Production (frontend compilé, un seul port)

```bash
npm run build   # si pas déjà fait
npm start
```

Puis ouvre **http://localhost:4200** (ou l'IP du serveur si tu y accèdes à distance).

Le port par défaut est `4200`, modifiable :

```bash
PORT=8080 npm start
```

### Développement (hot-reload frontend)

```bash
npm run dev
```

Ceci lance **en parallèle** le serveur Express (port `4200`, API + WebSocket)
et le serveur de dev Vite (port `5173`, hot-reload instantané des composants
Vue). Ouvre **http://localhost:5173** pendant que tu développes — Vite
proxifie automatiquement `/api` et `/socket.io` vers le port `4200`
(configuré dans `frontend/vite.config.js`).

Tu peux aussi lancer les deux séparément si tu préfères deux terminaux :

```bash
npm run dev:server   # terminal 1 — Express sur :4200
npm run dev:client   # terminal 2 — Vite sur :5173
```

> `public/` est un dossier **généré** par `npm run build` : ne modifie pas son
> contenu directement, tes changements seraient écrasés au prochain build.
> Tout le code source du frontend vit dans `frontend/`.

## Base de données : migrations

Le schéma (tables `users`, `permissions`, `jobs`…) est géré par un système de
migrations versionnées, plutôt que créé "en dur" au démarrage.

```bash
node bin/migrate.js status   # migrations appliquées / en attente
node bin/migrate.js up       # applique les migrations en attente
node bin/migrate.js down     # annule la dernière migration appliquée
node bin/migrate.js down --steps 2   # annule les 2 dernières
```

Équivalent via `deploy.sh` (utilise le même `.env`) :

```bash
./deploy.sh migrate status
./deploy.sh migrate up
```

**Tu n'as normalement rien à faire manuellement** : `server.js` applique les
migrations en attente automatiquement à chaque démarrage (avant de créer le
compte admin par défaut s'il n'existe pas encore), et `./deploy.sh install`
/ `./deploy.sh update` le font aussi explicitement avant de (re)démarrer le
process PM2. `migrate up` est idempotent : le relancer sur une base déjà à
jour ne fait rien.

Si tu mets à jour depuis une installation existante (base créée par une
version antérieure du projet, sans système de migrations), c'est sans
risque : les migrations réutilisent le même schéma et n'écrasent aucune
donnée existante.

Les fichiers de migration vivent dans `lib/db/migrations/` (un fichier par
migration, `{ version, up(db), down(db) }`). Le détail des choix
d'architecture (transactions, limites connues sous MySQL…) est documenté
dans [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tests

```bash
npm test               # tous les tests (unitaires + intégration)
npm run test:unit       # tests unitaires seulement
npm run test:integration  # tests d'intégration seulement (sous-process réels)
```

Basé sur `node:test` (natif, aucune dépendance ajoutée — voir
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) pour la justification face à
Vitest). Chaque test utilise un fichier SQLite temporaire isolé (créé et
détruit automatiquement), aucun test ne touche à une base de données réelle.

Couverture notable : `test/unit/alert-engine.test.js` (seuils, durée,
cooldown, déduplication, machine à états, acquittement — moteur d'alertes
testé isolément, sans DB) ; `test/integration/alerts-api.test.js` (routes
REST, permissions, DB réelle) ; `test/integration/process-history-api.test.js`,
`process-history-volume.test.js` (collecte → requête, purge/rollup sous
volume réaliste, taille disque et temps de requête bornés) et
`process-history-analytics.test.js` (Phase 11 — stats de période,
comparaison à la période précédente, disponibilité, crashes, périodes sans
données, resolution invalide) et `test/unit/migration-014-server-key.test.js`
(reconstruction de `process_metrics_rollup` sans perte de données, unicité
par serveur — correctif multi-serveur) ;
`test/integration/events-service.test.js` et `events-api.test.js`
(normalisation des packets PM2, filtres, pagination, permissions) ;
`test/unit/health-checks-runner.test.js` et `health-checks-engine.test.js`
(sondes HTTP/TCP/Command mockées — aucun accès réseau réel, transitions de
statut, feed vers l'Alert Engine) ; `test/integration/health-checks-api.test.js`
(routes REST, permissions, DB réelle) ; `test/unit/audit-sanitize.test.js`
et `audit-store.test.js` (`sanitizeAuditMetadata()`, pagination/filtres du
store) ; `test/integration/audit-api.test.js` (routes REST, permissions,
actions enregistrées `success`/`failed`/`denied`, et le test de sécurité
obligatoire — injection de secrets, vérification qu'ils n'apparaissent
jamais en base ni dans les réponses API, voir
[`docs/audit/README.md`](docs/audit/README.md)) ; `test/unit/audit-retention.test.js`
(purge par rétention, désactivée par défaut, opt-in via `AUDIT_RETENTION_MS`).

`./deploy.sh install`/`update` exécutent `npm test` avant de démarrer/
redémarrer l'application (`run_tests` dans `deploy.sh`) : un test qui échoue
bloque le déploiement (contournable via `DEPLOY_SKIP_TESTS=1`, déconseillé).

## Architecture des services (`lib/services/`)

Les futures fonctionnalités métier (alertes, notifications, métriques…)
vivent dans `lib/services/`, séparées de `server.js` (qui reste la couche
HTTP/WebSocket). Voir [`lib/services/README.md`](lib/services/README.md)
pour le détail de ce qui existe et ce qui est prévu.

- `lib/services/queue/` : file d'attente persistante générique (jobs stockés
  dans la table `jobs`, survivent à un redémarrage du process), sans
  dépendance externe (pas de Redis requis) — voir
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) pour la justification du
  choix face à `better-queue`/`bee-queue`.
- `lib/services/alerts/` : moteur d'alertes (règles CPU/RAM/disque/
  température/restarts/statut) — voir [Alertes](#alertes) et
  [`docs/alerts/README.md`](docs/alerts/README.md).
- `lib/services/process-history/` : historique CPU/RAM/restarts par process,
  multi-résolution avec purge automatique, et analytics (stats de période +
  comparaison, Phase 11) — voir
  [Historique par process](#historique-par-process).
- `lib/services/events/` : timeline d'événements/crashs PM2 (start, stop,
  restart, crash, statut) — voir [Timeline d'événements](#timeline-dévénements)
  et [`docs/events/README.md`](docs/events/README.md).
- `lib/services/notifications/` : système de notifications (Email/Discord/
  Telegram/Slack/Webhook générique) — providers opérationnels
  (`validateConfig`/`test`/`send`), routing par règles, file d'attente
  d'envoi (retry/backoff/rate limiting/dédup) et intégration de bout en
  bout avec le moteur d'alertes (voir `lib/alert-dispatch.js`), tous
  branchés. Voir [Notifications](#notifications) et
  [`docs/notifications/README.md`](docs/notifications/README.md).
- `lib/services/health-checks/` : sondes HTTP/TCP/Command indépendantes du
  statut PM2, alimentent le moteur d'alertes existant — voir
  [Health Checks](#health-checks) et
  [`docs/health-checks/README.md`](docs/health-checks/README.md).
- `lib/services/dashboard/` : vue globale (`GET /api/dashboard`) qui compose
  les services déjà existants (metrics système, process, alertes, health
  checks, timeline, auto-healing) en un instantané unique, et calcule l'état
  de santé global du serveur — voir [Dashboard global](#dashboard-global-onglet-dashboard)
  et [`docs/dashboard/README.md`](docs/dashboard/README.md).
- `lib/services/servers/` : registre des serveurs surveillés (hôte local +
  agents distants), tokens d'agent, scoping optionnel par utilisateur — voir
  [Multi-server / Remote PM2](#multi-server--remote-pm2-onglet-serveurs) et
  [`docs/multi-server/README.md`](docs/multi-server/README.md).
- `lib/services/process-organization/` : catalogues tags/environnements/
  groupes et leurs associations aux process, consommés par le routing des
  notifications — voir
  [Organisation des process](#organisation-des-process--tags-environnements-groupes-phase-13)
  et [`docs/process-organization/README.md`](docs/process-organization/README.md).
- `lib/services/incidents/` : corrélation déterministe des alertes en
  incidents (timeline fusionnée, sans duplication) et silences de
  notification, au-dessus du moteur d'alertes existant — voir
  [Incidents & Silences](#incidents--silences-phase-14) et
  [`docs/incidents/README.md`](docs/incidents/README.md).
- `lib/services/metrics/` : export Prometheus (`GET /metrics`) qui met en
  forme les métriques déjà collectées ailleurs (process, système, alertes,
  health checks, registre de serveurs) — aucune nouvelle collecte, Prometheus
  reste optionnel — voir [Export Prometheus](#export-prometheus-metrics-phase-15)
  et [`docs/metrics/README.md`](docs/metrics/README.md).
- `lib/services/anomaly-detection/` : détection statistique locale
  (moyenne mobile/écart-type/z-score, aucune API IA externe) sur les
  historiques déjà collectés, alimente le moteur d'alertes existant comme
  un nouveau type de signal — voir
  [Détection d'anomalies](#détection-danomalies-phase-16) et
  [`docs/anomaly-detection/README.md`](docs/anomaly-detection/README.md).

## Fonctionnalités

### Process

- **Liste des apps** : statut (online / stopped / errored…), CPU, mémoire,
  nombre de redémarrages, uptime, mode (fork/cluster), mini-graphique d'activité CPU.
- **Badge d'erreurs** : un compteur rouge apparaît sur les cartes des apps qui
  écrivent des erreurs pendant que tu regardes une autre app.
- **Actions rapides** : start / restart / reload / stop directement depuis chaque carte.
- **Actions étendues** (bouton "⋯ Plus" sur chaque carte) :
  - Scale (nombre d'instances, mode cluster)
  - Watch ON/OFF
  - Modifier les variables d'environnement (appliqué au redémarrage)
  - Modifier le script / les arguments / le mode fork↔cluster
  - Flush des logs de cette app
  - Réinitialiser le compteur de restarts
  - Supprimer le process
- **Actions globales PM2** (menu "PM2 ⋯" en haut à droite) :
  Sauvegarder (`pm2 save`), Resurrect, Flush tous les logs, Update PM2,
  Kill daemon PM2 (confirmation demandée).

### Dashboard global (onglet "Dashboard")

Vue d'ensemble unique de l'état du serveur et des applications, pensée pour
un coup d'œil : aucune nouvelle source de données ni nouveau canal temps
réel — uniquement une composition de ce qui existe déjà (metrics système,
process, moteur d'alertes, health checks, timeline, auto-healing).

- **Statut global** (`HEALTHY` / `WARNING` / `CRITICAL`), calculé par une
  fonction pure `calculateGlobalStatus()` (voir
  [`docs/dashboard/README.md`](docs/dashboard/README.md#calcul-du-statut-global)
  pour les règles complètes et documentées).
- **Système** : CPU, RAM, disque, réseau, température — mêmes composants
  visuels que l'onglet [Système](#vue-système-onglet-système).
- **Processus** : total / online / stopped / errored / crashed / restarting.
- **Alertes** : actives / critiques / warning / acquittées (nécessite la
  permission `alerts_read`).
- **Tableau des process** : application, statut, CPU, RAM, restarts, uptime,
  health check associé — cliquer sur une ligne ouvre le process dans
  l'onglet Process existant.
- **Timeline récente** : fusion des événements process, alertes (déclenchées
  et résolues) et tentatives d'auto-healing, triée par date décroissante.
- **Temps réel** : mis à jour via le même Socket.IO que le reste de
  l'application (`metrics.updated`, `process.updated`, `alert.triggered`,
  `alert.resolved`, `health.updated`, `event.created`) — pas de polling
  dédié, pas de second système temps réel.
- Visible avec la même permission que l'onglet Système (`system`).

### Vue Système (onglet "Système")

- Charge machine (load average 1/5/15 min), RAM, swap, disque, bande passante
  réseau (↓/↑ en temps réel), température CPU (Linux), nombre de processus système.
- **Historique CPU/RAM** avec sélecteur 1h / 6h / 24h (graphiques Chart.js),
  échantillonné toutes les 5s et persisté sur disque (survit aux redémarrages).
- Graphique d'historique réseau (Ko/s montant/descendant).
- Sur un OS non-Linux ou en environnement conteneurisé, certaines métriques
  (température, swap) peuvent être indisponibles (`n/d`) — c'est normal, pas
  tous les OS les exposent.

### Alertes

Moteur d'alertes configurable (CPU/RAM/disque/température/restarts/statut,
par process ou pour le système), avec seuils, durée avant déclenchement,
cooldown anti-spam et déduplication. Chaque transition (déclenchement ou
résolution) passe par `lib/alert-dispatch.js`, qui la diffuse en une seule
fois vers le routing des notifications (voir [Notifications](#notifications)),
le dashboard temps réel (websocket) et l'Auto-Healing.

- **Activable/désactivable** : `ALERTS_ENABLED=0` dans `.env` coupe tout le
  moteur (évaluation + routes REST inchangées mais inertes).
- `ALERTS_EVAL_INTERVAL_MS` (défaut `15000`) : fréquence d'évaluation des
  règles "process" (règles "system" évaluées à chaque échantillon système).
- **Endpoints** : `GET/POST /api/alerts/rules`, `GET/PUT/PATCH/DELETE
/api/alerts/rules/:id`, `GET /api/alerts/catalog`, `GET /api/alerts/active`,
  `GET /api/alerts/history`, `POST /api/alerts/:id/acknowledge`.
- **Permissions** : `alerts_read`, `alerts_create`, `alerts_update`,
  `alerts_delete`, `alerts_acknowledge` (voir
  [Multi-utilisateurs & permissions](#multi-utilisateurs--permissions)).
- Détail complet (modèle de données, machine à états, cooldown, dédup) :
  [`docs/alerts/README.md`](docs/alerts/README.md).

### Historique par process

En plus de l'historique système existant, chaque process a son propre
historique CPU / mémoire / restarts / instances / statut, avec trois
résolutions (`raw` court terme, `medium` horaire, `long` journalier) et purge
automatique — pensé pour tourner sur un petit VPS sans exploser le disque.

- **Activable/désactivable** : `PROCESS_HISTORY_ENABLED=0` dans `.env`.
- Variables de configuration (toutes optionnelles, valeurs par défaut dans
  `.env.example`) : `PROCESS_HISTORY_COLLECT_INTERVAL_MS`,
  `PROCESS_HISTORY_MAINTENANCE_INTERVAL_MS`,
  `PROCESS_HISTORY_SHORT_RETENTION_MS` (raw), `PROCESS_HISTORY_MEDIUM_RETENTION_MS`,
  `PROCESS_HISTORY_LONG_RETENTION_MS`, `PROCESS_HISTORY_MEDIUM_BUCKET_MS`,
  `PROCESS_HISTORY_LONG_BUCKET_MS`, `PROCESS_HISTORY_RAW_MAX_SPAN_MS`,
  `PROCESS_HISTORY_MEDIUM_MAX_SPAN_MS` (choix auto de la résolution selon la
  plage demandée), `PROCESS_HISTORY_MAX_POINTS` (borne le nombre de points
  renvoyés par l'API, downsampling au-delà).
- **Endpoint** : `GET /api/processes/:id/metrics?start=&end=&resolution=&metrics=`
  (permission `view` sur l'app, comme la vue du process). `resolution` :
  `raw`/`medium`/`long`, choisie automatiquement selon la plage si omise.
  `metrics` : sous-ensemble `cpu,memory,restarts,instances,status`.
- **UI** : onglet "Metrics" sur chaque carte de process (Chart.js),
  sélecteur de période 1h / 6h / 24h / 7d / 30d.
- Collecte réutilisant le même `pm2.list()` que le moteur d'alertes (aucun
  second poller PM2), rollup + purge sur un intervalle de maintenance séparé.

#### Analytics (Phase 11)

Sous le graphique de l'onglet "Metrics", un panneau "Analytics" affiche des
statistiques agrégées sur la même période (avg/min/max, restarts + fréquence
par heure, crashes, disponibilité) avec comparaison à la période précédente
de même durée. Détails complets : [`docs/process-history/README.md`](docs/process-history/README.md).

- **Endpoint** : `GET /api/processes/:id/analytics?start=&end=&resolution=&compare=`
  (même permission `view` que `/metrics`). `compare=0`/`false` désactive la
  comparaison à la période précédente (activée par défaut).
- **Métriques toujours disponibles** (déjà couvertes ci-dessus) : cpu,
  memory (RSS), instances, restarts.
- **Best-effort, jamais inventées** : heap used/total (octets) et event loop
  lag (ms), lus depuis `pm2_env.axm_monitor` quand le process monitoré est
  une app Node instrumentée (`@pm2/io`/pmx) — `null` sinon, sans jamais être
  approximées. Le panneau UI masque ces deux cartes quand elles sont
  toujours `null` sur la période.
- **Disponibilité** : % d'échantillons `status === "online"` sur la
  période — calculable jusqu'à 30j grâce à un compteur dédié conservé dans
  les rollups (`online_count`, migration `013_process_metrics_analytics.js`).
- **Crashes** : réutilise `lib/services/events/` (Phase 4, pas de second
  compteur) plutôt que d'inventer une détection de crash côté historique.

#### Multi-serveur (correctif)

Jusqu'à ce correctif, l'historique/Analytics ne fonctionnait que pour
l'hôte local du hub : `lib/realtime/agent-hub.js` (Phase 10) ne branchait
jamais les heartbeats des agents distants sur `ProcessHistoryService`, et
les tables `process_metrics_raw`/`process_metrics_rollup` (Phase 4, avant le
multi-serveur) n'avaient de toute façon aucune notion de serveur —
deux serveurs avec un process du même nom auraient fusionné leur historique.

- Migration `014_process_metrics_server_key.js` : ajoute `server_key` aux
  deux tables (`"local"` par défaut, rétrocompatible).
- `onSnapshot` (agent-hub, `server.js`) appelle désormais
  `processHistory.record(processes, now, serverKey)` à chaque heartbeat —
  un agent alimente son propre historique dès sa première connexion.
- **Endpoints dédiés** (les routes `/api/processes/:id/*` résolvent `:id`
  via `pm2.describe()`, donc strictement locales, incapables de voir un
  process distant) : `GET /api/servers/:key/processes/:processName/metrics`
  et `GET /api/servers/:key/processes/:processName/analytics`, mêmes
  paramètres que leurs équivalents locaux, permission `view` sur l'app +
  accès au serveur (`auth.requireServerAccess`).
- **UI** : bouton "Metrics" sur chaque process distant dans l'onglet
  "Serveurs" (`ServersView.vue`), panneau identique à celui d'une carte de
  process local.
- **Limite connue** : les crashes (`lib/services/events/`) n'ont pas
  (encore) de `server_key` — un crash "api" sur un serveur distant et un
  crash "api" local se comptent ensemble si les deux process partagent ce
  nom. Corriger `events/` est hors périmètre de ce correctif (nécessiterait
  sa propre migration).

### Timeline d'événements

Journal chronologique des événements de cycle de vie PM2 par process :
démarrage, arrêt, redémarrage, passage online/offline, crash, erreur —
alimenté par le même bus PM2 que le reste du monitor (aucun second listener
créé pour cette fonctionnalité).

- **Activable/désactivable** : `EVENTS_ENABLED=0` dans `.env`.
- Variables de configuration (optionnelles) : `EVENTS_RETENTION_MS` (durée de
  conservation avant purge automatique, 90 jours par défaut),
  `EVENTS_MAINTENANCE_INTERVAL_MS` (fréquence du cycle de purge, 1h par défaut).
- **Types** : `started`, `stopped`, `restarted`, `online`, `offline`,
  `crashed`, `errored`, avec une sévérité dérivée automatiquement
  (`info` / `warning` / `critical`) — mêmes niveaux que le moteur d'alertes.
- **Endpoints** : `GET /api/events` (filtres `process`, `type`, `severity`,
  `start`/`end`, `limit`/`offset` — pagination bornée, jamais tout
  l'historique en une requête), `GET /api/events/catalog` (types/sévérités
  valides, pour construire les filtres côté frontend sans les dupliquer).
- **Permissions** : `events_read`, permission **globale** (pas décomposée par
  app dans cette phase, comme `alerts_read`).
- **UI** : onglet "Events" avec filtre par type et code couleur par sévérité.

### Notifications

Système de notifications multi-providers — architecture, modèles de
données, cinq providers opérationnels (Email/SMTP, Discord, Telegram,
Slack, Webhook générique), une interface d'administration complète
(Settings → Notifications → Providers), le routing par règles depuis
l'Alert Engine (conditions + templates), une file d'attente fiable
(retry + backoff, rate limiting, déduplication), et désormais
l'intégration de bout en bout Alert Engine → Routing → Templates →
Queue → Provider → Historique, auditée (sécurité, permissions,
anti-spam, scénarios de panne). Voir
[`docs/notifications/README.md`](docs/notifications/README.md) pour
l'état exact et [`docs/notifications/providers/`](docs/notifications/providers/)
pour la configuration détaillée de chaque provider.

- **Providers** : `email` (SMTP, host/port/security/identifiants),
  `discord` (webhook), `telegram` (bot token + chat id), `slack` (webhook),
  `webhook` (générique — URL/méthode/headers/payload configurables, pour
  connecter n'importe quel système externe).
- Chaque provider implémente `validateConfig()`, `test()` et `send()`,
  avec un résultat normalisé (`success`/`provider`/`messageId`/
  `responseTime`, ou `success: false`/`errorCode`/`safeMessage`) — jamais
  de secret (mot de passe SMTP, token de webhook, bot token…) exposé dans
  un log ou une erreur.
- Secrets chiffrés au repos (AES-256-GCM) via `NOTIFICATIONS_ENCRYPTION_KEY`
  (voir [Notes importantes](#notes-importantes)).
- **UI (Phase 5C)** : `Settings → Notifications` — onglet `Providers` —
  configurations (statut 🟢/⚪), `+ Add notification provider` avec
  formulaire dynamique selon le type choisi, `Edit`/`Test`/`Enable`/
  `Disable`/`Delete` par configuration. Un mot de passe/webhook/token déjà
  enregistré s'affiche masqué (`••••••••`) ; le laisser tel quel lors d'une
  modification conserve la valeur existante ("Keep existing credential").
  `Test` appelle réellement le provider et affiche `🟢 Notification sent
successfully` ou une erreur sûre (`🔴 …`, jamais de secret).
- **Endpoints providers** : `GET /api/notifications/provider-types`,
  `GET/POST /api/notifications/providers`, `GET/PATCH/PUT/DELETE
/api/notifications/providers/:id`, `POST
/api/notifications/providers/:id/test`. Permissions : `notifications_read`,
  `notifications_create`, `notifications_update`, `notifications_delete`,
  `notifications_test`.
- **Routing par règles (Phase 5D)** : une règle (`notification_routes`)
  matche une alerte sur `severity`/`alertType`/`process`/`server`/`tag`
  (tableaux, vide/absent = toutes valeurs), cible une ou plusieurs
  configurations de provider, et peut personnaliser le titre/message
  envoyé via un template `{{placeholder}}` (`{{ruleName}}`,
  `{{severity}}`, `{{metric}}`, `{{value}}`, `{{targetValue}}`…). Une
  règle notifie toujours au déclenchement d'une alerte qui matche, et en
  plus à la résolution si `notifyOnResolve` est activé. Branché
  directement sur `lib/services/alerts/` via `lib/alert-dispatch.js` : dès
  qu'une occurrence d'alerte passe active ou résolue (process, système ou
  health check), les règles concernées envoient et chaque tentative est
  journalisée (`notification_history`, `GET /api/notifications/history`).
  **UI** : `Settings → Notifications` — onglet `Routing` — liste des
  règles (statut 🟢/⚪, résumé des conditions, providers ciblés),
  `+ Add routing rule` avec sélection des conditions (chips
  severity/providers), champs texte pour alertType/process/server,
  templates de titre/message, case "notifier aussi à la résolution",
  `Edit`/`Enable`/`Disable`/`Delete` par règle.
  **Endpoints** : `GET/POST /api/notifications/routes`,
  `GET/PATCH/PUT/DELETE /api/notifications/routes/:id`
  (`notifications_manage` en écriture), `GET /api/notifications/history`
  (`notifications_history`). Voir
  [`docs/notifications/README.md`](docs/notifications/README.md#routing-phase-5d)
  pour la sémantique exacte des conditions et des templates.
- **File d'attente & fiabilité de livraison (Phase 5E)** : l'envoi
  effectif est délégué à `lib/services/notifications/dispatch-queue.js`,
  adossé à la file d'attente persistante existante
  (`lib/services/queue/`, Phase 1) — retry avec backoff exponentiel,
  rate limiting configurable par provider, déduplication (même
  provider/alerte/transition dans une fenêtre de 5 min par défaut). Un
  provider en panne (SMTP down, webhook injoignable…) ne bloque jamais le
  monitoring PM2 : l'échec est tracé dans `notification_history`
  (`pending` → `retrying` → `success`/`failed`) et retenté automatiquement
  jusqu'à épuisement des tentatives. Worker démarré/arrêté avec le process
  principal (`server.js`), reprend les jobs interrompus par un arrêt
  brutal au redémarrage. Voir
  [`docs/notifications/README.md`](docs/notifications/README.md#notification-queue-phase-5e).
- **Intégration finale & sécurité (Phase 5F)** : le système est maintenant
  entièrement branché de bout en bout — Alert Engine → Routing → Templates
  → Queue → Provider → Historique — et audité. Audit de sécurité complet
  (aucun secret dans les réponses API, l'historique, les jobs de la queue,
  la base ou les logs — voir
  [`docs/notifications/README.md#audit-de-sécurité-phase-5f`](docs/notifications/README.md#audit-de-sécurité-phase-5f)),
  audit de permissions exhaustif (chaque endpoint testé contre chacune des
  7 permissions `notifications_*`, aucun contournement possible), tests
  anti-spam (une transition d'état réelle = une notification, jamais un
  envoi par tick d'évaluation) et scénarios de panne (SMTP/Discord/
  Telegram/Slack/Webhook indisponibles, redémarrage de la queue, base
  indisponible — le monitoring PM2 continue de fonctionner dans tous les
  cas). Voir
  [`docs/notifications/README.md`](docs/notifications/README.md#intégration--sécurité-phase-5f)
  pour l'architecture finale complète et les limitations connues.

### Health Checks

Système de vérification de disponibilité **indépendant du statut PM2** :
un process `online` chez PM2 ne veut pas dire "l'application répond
correctement" (ex: port HTTP mort, base de données injoignable, alors que
le process n'a pas crashé). Trois types de sonde : **HTTP** (URL, méthode,
statut/contenu attendu), **TCP** (host/port), **Command** (exécution
sécurisée via `execFile`, jamais de shell — voir mise en garde ci-dessous).

- **Statuts** : `UP`/`DOWN`/`DEGRADED`/`UNKNOWN`, recalculés à chaque
  exécution (pas de lissage). `DEGRADED` s'applique quand la sonde réussit
  mais dépasse un seuil de temps de réponse configurable
  (`degradedThresholdMs`).
- **Command traité comme sensible** : commande et arguments toujours passés
  séparément à `execFile` (jamais de concaténation de chaîne interprétée
  par un shell), donc aucune injection possible via les métacaractères
  shell. Voir
  [`docs/health-checks/README.md#command`](docs/health-checks/README.md#command)
  pour le détail.
- **Alimente le moteur d'alertes existant** (pas un deuxième système
  d'alerte) : un health check est simplement une nouvelle cible
  (`targetType: "health_check"`) pour les règles `alert_rules` déjà en
  place — voir [Alertes](#alertes) et
  [`docs/health-checks/README.md#intégration-avec-lalert-engine`](docs/health-checks/README.md#intégration-avec-lalert-engine).
- **Activable/désactivable** : `HEALTH_CHECKS_ENABLED=0` dans `.env` coupe
  le scheduler (l'API de gestion reste disponible). `HEALTH_CHECKS_SCHEDULER_INTERVAL_MS`
  (défaut `5000`) contrôle la fréquence à laquelle le scheduler regarde
  quels checks sont dus (chaque check garde son propre `intervalSeconds`).
- **Endpoints** : `GET/POST /api/health-checks`, `GET/PUT/PATCH/DELETE
/api/health-checks/:id`, `GET /api/health-checks/catalog`, `GET
/api/health-checks/status/summary`, `POST /api/health-checks/:id/enable`,
  `POST /api/health-checks/:id/disable`, `POST /api/health-checks/:id/test`
  (exécution immédiate, persiste le résultat).
- **Permissions** : `health_checks_read`, `health_checks_create`,
  `health_checks_update`, `health_checks_delete`, `health_checks_test`
  (voir [Multi-utilisateurs & permissions](#multi-utilisateurs--permissions)).
- **UI** : `Settings → ❤ Health Checks` — liste avec statut, dernier check,
  temps de réponse, dernière panne ; création/édition par type ;
  enable/disable ; "Run test" à la demande.
- Documentation complète (types de sonde, sécurité de `command`,
  intervalles/timeouts, intégration Alert Engine) :
  [`docs/health-checks/README.md`](docs/health-checks/README.md).

### Auto-Healing

> ⚠️ **Auto-Healing peut automatiquement redémarrer des processus. Il est
> désactivé par défaut.** Fonctionnalité **CRITIQUE/DANGEREUSE** : lisez
> [`docs/auto-healing/README.md`](docs/auto-healing/README.md) avant de
> l'activer en production.

Redémarrage automatique (`pm2.restart`, aucune autre action) d'un process
sur détection d'un crash, d'un health check `DOWN`, ou de toute alerte
`active` ciblant un process — trois sources (Alert Engine, Health Checks,
événements PM2), un seul point de décision.

- **Désactivé par défaut** : nécessite une activation explicite
  (`PUT /api/auto-healing/settings { "enabled": true }`, permission
  `authealing_manage`), jamais une variable d'environnement ni un effet de
  bord d'une autre configuration.
- **Garde-fous obligatoires** : nombre maximum de tentatives configurable
  (défaut `3`), cooldown/backoff exponentiel entre chaque tentative (défaut
  `60s / 300s / 900s`), puis **blocage définitif** (`AUTO-HEALING BLOCKED`)
  au-delà — un process bloqué ne redémarre plus jamais automatiquement,
  seul un déblocage manuel explicite le réactive.
- **Audit complet** : chaque tentative (réussie, échouée, bloquée) est
  journalisée (`GET /api/auto-healing/audit`), sans exception.
- **Endpoints** : `GET/PUT /api/auto-healing/settings`, `GET
/api/auto-healing/state`, `GET /api/auto-healing/state/:process`, `POST
/api/auto-healing/state/:process/unblock`, `GET /api/auto-healing/audit`.
- **Permissions** : `authealing_read`, `authealing_manage` (voir
  [Multi-utilisateurs & permissions](#multi-utilisateurs--permissions)).
- **Sécurité** : action limitée à l'API PM2 déjà utilisée par le reste de
  l'application (`pm2.restart`) — jamais de commande shell.
- Documentation complète (garde-fous, activation, configuration, sécurité) :
  [`docs/auto-healing/README.md`](docs/auto-healing/README.md).

### Audit Log

Journal d'audit **append-only** des actions sensibles : connexions,
actions process (start/stop/restart/reload/delete), changements
d'environnement/configuration, actions PM2 (save/resurrect/kill),
alertes (création/modification/suppression/acquittement), configuration
des notifications (providers + règles de routing), health checks, et
actions Auto-Healing (administratives). Les actions de lecture ne sont
volontairement **pas** journalisées.

- **Chaque entrée** contient (quand disponible) : `timestamp`, `user`,
  `action`, `target`/`targetType`, `server`, `status`
  (`success`/`failed`/`denied`), `IP`, `metadata`.
- **Sécurité — contrainte absolue** : aucun secret (mot de passe, JWT, clé
  API, mot de passe SMTP, webhook Discord/Slack, token Telegram, clé
  privée, header `Authorization`…) n'est **jamais** enregistré, y compris
  dans `metadata`. `sanitizeAuditMetadata()`
  ([`lib/services/audit/sanitize.js`](lib/services/audit/sanitize.js)) est
  l'unique point de passage obligatoire de toute `metadata` avant stockage
  (denylist de clés + détection de forme JWT/PEM/Bearer/webhook, en plus de
  la discipline des routes qui ne journalisent que des **noms** de champs
  modifiés, jamais leurs valeurs — voir `lib/routes/notifications.js`).
- **Endpoints** : `GET /api/audit` (pagination, filtres : date range,
  utilisateur, action, statut, cible), `GET /api/audit/:id`, `GET
/api/audit/catalog`.
- **Permission** : `audit_read` (lecture seule — l'audit log n'est jamais
  modifiable via l'API).
- **UI** : `Settings → 🧾 Audit Log` — liste filtrable/paginée, clic sur une
  entrée pour voir le détail (metadata déjà sanitisée).
- **Rétention** : purge automatique optionnelle, désactivée par défaut
  (`AUDIT_RETENTION_MS=0` dans `.env` — rien n'est supprimé tant qu'elle
  n'est pas définie explicitement).
- Documentation complète (événements, sanitization, rétention, sécurité,
  API) : [`docs/audit/README.md`](docs/audit/README.md).

### Multi-server / Remote PM2 (onglet "Serveurs")

Une instance centrale de PM2 Monitor (le « hub ») peut surveiller
**plusieurs hôtes** PM2, chacun équipé d'un agent léger
(`bin/agent.js`), en plus de l'hôte local. **Rétrocompatible sans
configuration** : le serveur local est enregistré automatiquement au
démarrage et reste la seule source de vérité pour ses propres process.

- **Enregistrement d'un agent** : depuis l'onglet Serveurs, génère un
  token d'agent (affiché une seule fois), à utiliser pour configurer
  `PM2_MONITOR_HUB_URL` / `PM2_MONITOR_SERVER_KEY` / `PM2_MONITOR_AGENT_TOKEN`
  côté agent (`node bin/agent.js` ou `npm run agent`).
- **Temps réel** : statut ONLINE/OFFLINE/PENDING, métriques CPU/RAM/disque/
  température, liste de process, via le namespace Socket.IO dédié
  `/agent` (authentification par token, jamais par cookie de session).
- **Actions distantes** : start/stop/restart/reload sur un process d'un
  serveur distant, relayées à l'agent avec accusé de réception, soumises
  aux mêmes permissions par app/action que le serveur local.
- **Permissions** : deux actions globales dédiées (`servers_read`,
  `servers_manage`) + un **scoping optionnel par serveur** (un
  utilisateur peut être restreint à un sous-ensemble de serveurs, filtre
  orthogonal aux permissions existantes — pas un second système RBAC).
- **Sécurité** : token jamais stocké en clair (bcrypt), liste blanche
  d'actions distantes appliquée des deux côtés (hub et agent), audit log
  systématique des actions sensibles.
- Documentation complète (architecture, communication, installation
  d'un agent, sécurité, troubleshooting) :
  [`docs/multi-server/README.md`](docs/multi-server/README.md).

### Logs

- **Flux en direct** : filtre "Tout / stdout / stderr", filtre par niveau
  (info/warn/error/debug, détecté par heuristique sur le texte), recherche
  texte **ou regex**, coloration **ANSI**, numéros de ligne, auto-scroll,
  bouton **copier** par ligne, **pause du flux** (les lignes manquées sont
  comptées et rejouées à la reprise).
- **Recherche plein texte** dans l'historique complet du fichier (pas
  seulement ce qui a défilé à l'écran), avec filtre regex/niveau.
- **Aller à une date** : retrouve les lignes autour d'un horodatage précis.
- **Export** : logs bruts PM2 complets, ou **export d'une période précise**
  (date de début/fin) grâce à l'horodatage que le monitor ajoute à chaque ligne.
- **Persistance et compression automatique** : chaque ligne de log est
  enregistrée côté serveur (`data/logs/`) avec son timestamp ; les fichiers
  sont **rotés automatiquement au-delà de 5 Mo** puis **compressés en gzip**
  (réglable via `LOG_ROTATE_SIZE_MB` dans `.env`).

### Log Explorer (onglet "Logs", Phase 12)

Recherche **globale**, à travers plusieurs process et plusieurs serveurs
(Multi-server, Phase 10) à la fois — distincte du flux en direct/de la
recherche plein texte ci-dessus, qui restent limités à UN process sélectionné.

- **Sélection multi-process / multi-serveur** : filtre par process, par
  serveur, par flux (stdout/stderr), par niveau, par période, texte ou
  **regex**, tri chronologique croissant/décroissant.
- **Contexte** : affiche jusqu'à 20 lignes avant/après chaque ligne trouvée,
  sans requête supplémentaire.
- **Pagination**, **copier** une ligne, **exporter** les résultats (fichier
  texte téléchargeable, filtres actuels), **ouvrir le process** (hôte local
  uniquement) et **suivre en direct** (les nouvelles lignes correspondantes
  s'ajoutent en tête pendant que le direct est actif).
- **Sécurité intégrée** : regex trop longue ou "catastrophique" (groupes
  quantifiés imbriqués, motif classique de ReDoS) refusée avant toute
  évaluation ; toute recherche est bornée (nombre de lignes scannées, de
  résultats conservés, de lignes exportées) — jamais de requête non bornée,
  même sur un très gros volume de logs.
- **Permissions** : chaque process/serveur demandé est revalidé
  individuellement (`logs` par app + accès serveur), exactement comme les
  autres routes multi-serveur — un utilisateur ne voit jamais que ce à quoi
  il a déjà droit, même dans une recherche agrégée.
- Documentation complète (API, garde-fous, limites connues) :
  [`docs/log-explorer/README.md`](docs/log-explorer/README.md).

### Organisation des process : tags, environnements, groupes (Phase 13)

Une organisation logique des process **gérée entièrement par PM2
Monitor**, sans jamais modifier la configuration PM2 elle-même :

- **Tags** : étiquettes libres (`production`, `backend`, `payments`,
  `critical`, `worker`…), plusieurs par process.
- **Environnements** : `production` / `staging` / `development` (créés par
  défaut) ou personnalisés — un seul par process.
- **Groupes** : regroupements logiques (`E-commerce` → `frontend`, `api`,
  `worker`, `cron`…) — un process peut appartenir à plusieurs groupes.
- **UI** : `Settings → 🏷 Organisation` (CRUD des trois catalogues +
  assignation à un process), filtres par tag/environnement et **vue
  groupe** dans la liste des process.
- **Alertes & notifications** : le routing des notifications
  (`conditions.tag`/`environment`/`group`) matche désormais correctement
  contre l'organisation du process ciblé par l'alerte — un filtre `tag`
  qui ne matchait jamais rien avant cette phase.
- Documentation complète (modèle de données, API, intégration Alert
  Engine, limites connues) :
  [`docs/process-organization/README.md`](docs/process-organization/README.md).

### Incidents & Silences (Phase 14)

Un système d'incidents **au-dessus** du moteur d'alertes existant (ne le
remplace pas) : regroupe des alertes liées en un seul incident suivi, avec
sa propre timeline et la possibilité de mettre certaines notifications en
silence sans jamais supprimer l'alerte ni l'événement qui l'a déclenchée.

- **Corrélation déterministe** (aucune IA) : une nouvelle alerte rejoint un
  incident déjà ouvert si elle porte sur le même process et le même type de
  problème (dans une fenêtre de temps configurable), ou sur un process du
  même groupe ([Organisation des process](#organisation-des-process--tags-environnements-groupes-phase-13))
  — sinon un nouvel incident est ouvert.
- **États** : `OPEN → ACKNOWLEDGED → INVESTIGATING → MITIGATED → RESOLVED`
  (machine à états validée côté serveur, `RESOLVED` est terminal).
- **Timeline fusionnée, sans duplication** : alerte déclenchée/résolue,
  événement PM2, notification envoyée, tentative d'Auto-Healing et actions
  propres à l'incident (acquittement, silence) apparaissent dans un seul
  flux chronologique, résolu à la lecture depuis les données déjà
  existantes plutôt que recopié.
- **Silences** : temporaire (durée) ou jusqu'à une date, par règle,
  process, tag, environnement ou groupe — empêche l'envoi des
  notifications correspondantes (visible dans l'historique de
  notification avec le statut `silenced`) sans jamais toucher à l'alerte
  ou à l'événement sous-jacent.
- **UI** : onglet `Incidents` — liste filtrable par état, détail avec
  timeline et actions (acquitter/enquêter/atténuer/résoudre/silence),
  gestion des silences actifs.
- Toutes les actions sensibles (transition d'incident, création/annulation
  d'un silence) sont auditées ([Audit Log](#audit-log)).
- Documentation complète (modèle de données, algorithme de corrélation,
  API, permissions) : [`docs/incidents/README.md`](docs/incidents/README.md).

### Export Prometheus / metrics (Phase 15)

Un endpoint `GET /metrics` au format d'exposition Prometheus, pour qui
préfère brancher son propre Prometheus/Grafana plutôt que d'utiliser
uniquement le dashboard intégré. **Prometheus n'est jamais obligatoire** :
l'endpoint peut être désactivé (`METRICS_ENABLED=0`), et rien d'autre dans
l'application n'en dépend.

- **Aucune nouvelle collecte** : les métriques exposées sont mises en forme
  à partir de ce qui est déjà calculé ailleurs (process PM2, système,
  moteur d'alertes, health checks, registre de serveurs) — pas de second
  système de monitoring en parallèle.
- **Métriques** : CPU/mémoire/uptime/redémarrages/statut par process, CPU/
  mémoire/disque système, statut des health checks, nombre d'alertes
  actives par sévérité, statut des serveurs suivis ([Multi-server](#multi-server--remote-pm2-onglet-serveurs)) —
  liste complète dans [`docs/metrics/README.md`](docs/metrics/README.md#métriques-disponibles).
- **Labels raisonnables** : `process`, `server`, `environment` — jamais de
  PID ou d'identifiant volatil, cardinalité proportionnelle au nombre réel
  de process/serveurs/checks.
- **Sécurité** : endpoint distinct du système d'auth par session (un
  scraper Prometheus n'a pas de cookie) — protégé par jeton
  (`METRICS_TOKEN`) et/ou restriction IP (`METRICS_ALLOWED_IPS`) ;
  accès à l'hôte local uniquement par défaut si aucun des deux n'est
  configuré. Aucun secret (variables d'environnement de process, tokens
  d'agent…) n'est jamais exposé.
- Documentation complète (scrape configuration, sécurité, liste des
  métriques) : [`docs/metrics/README.md`](docs/metrics/README.md).

### Détection d'anomalies (Phase 16)

Une détection **statistique locale** (moyenne mobile, écart-type, z-score)
basée sur l'historique déjà collecté par le monitor — **aucune API IA
externe, pas de modèle ML**. Repère un comportement inhabituel (CPU/mémoire
anormale, restart inhabituel, crash inhabituel, taux d'événements
inhabituel) *avant* qu'un seuil fixe classique ne soit franchi, en se
basant sur ce qui est normal pour **cette** app plutôt que sur une valeur
absolue choisie a priori.

- **Aucune nouvelle collecte** : réutilise les historiques déjà alimentés
  par `lib/history-store.js`, `lib/services/process-history/` et
  `lib/services/events/`.
- **Une anomalie alimente le moteur d'alertes existant** comme un nouveau
  type de signal (via `AlertEngine.evaluate()`, la même méthode que pour
  une règle d'alerte classique) — **il n'existe pas de deuxième moteur
  d'alertes** : trigger/active/resolved, déduplication, cooldown,
  notifications, websocket dashboard et corrélation d'incidents
  fonctionnent donc automatiquement.
- **Toujours expliqué** : chaque anomalie détectée est accompagnée de la
  métrique, la valeur observée, la baseline, l'écart-type, le niveau de
  confiance statistique et une explication en langage naturel — jamais une
  alerte "boîte noire".
- **Jamais de déclenchement sur une absence de données** : en-dessous d'un
  nombre minimum d'échantillons dans la fenêtre historique, aucune décision
  n'est prise.
- **Sévérité escaladée dynamiquement** (jamais rétrogradée) si le z-score
  continue de s'aggraver pendant qu'une anomalie reste ouverte.
- Interface dédiée : `Settings → 📊 Anomalies` (règles + historique des
  détections avec explication).
- Documentation complète (méthode, configuration, API, permissions) :
  [`docs/anomaly-detection/README.md`](docs/anomaly-detection/README.md).

### Général

- **Interface Vue 3** entièrement componentisée (réactive, sans manipulation
  manuelle du DOM), polices `Space Grotesk` / `JetBrains Mono` auto-hébergées
  (aucune dépendance à un CDN de polices en production).
- **Thème clair / sombre** : bouton ◐ en haut à droite, préférence mémorisée.
- **Multi-utilisateurs avec permissions par app et par action** : chaque
  compte se connecte par identifiant/mot de passe (session, plus de mot de
  passe partagé) et ne voit / ne peut agir que sur ce qui lui a été accordé
  — voir [Multi-utilisateurs & permissions](#multi-utilisateurs--permissions).
- **Stats globales** : nombre total d'apps, en ligne, arrêtées, état de la connexion.

### Limites connues

- La modification de **script / arguments / mode d'exécution** supprime puis
  relance le process (équivalent à `pm2 delete` + `pm2 start`) : c'est la
  seule façon fiable de le faire via l'API programmatique de PM2 (pas de
  "hot edit" natif pour ces champs).
- Le filtre par **niveau de log** (info/warn/error/debug) est une heuristique
  basée sur des mots-clés dans le texte (`error`, `warn`, `exception`…), pas
  une vraie extraction de niveau structuré — utile en pratique, mais pas
  garanti à 100 % selon le format de logs de ton app.
- Les sessions de connexion sont gardées **en mémoire du process** (pas de
  store externe type Redis) : elles ne survivent pas à un redémarrage du
  serveur (`./deploy.sh restart`, déploiement…), et ne sont pas partagées si
  tu fais tourner plusieurs instances derrière un load-balancer. Suffisant
  pour l'usage visé (un monitor par serveur), pas conçu pour du multi-instance.
- **Multi-server** : la sidebar de process et le panneau de logs principal
  restent centrés sur l'hôte local ; les process distants se consultent et
  se pilotent depuis l'onglet Serveurs (liste dépliable par serveur), pas
  encore intégrés à la sidebar/au panneau de logs principal — voir
  [Limites connues de `docs/multi-server/README.md`](docs/multi-server/README.md#limites-connues).
- **Log Explorer** : les logs d'un serveur distant ne sont persistés (donc
  cherchables) qu'à partir du moment où cette phase a été déployée — un log
  émis par un agent avant la mise à jour n'a jamais existé sur disque, il n'y
  a rien à retrouver. Détails et raisonnement complets :
  [Limites connues de `docs/log-explorer/README.md`](docs/log-explorer/README.md#limites-connues).

## Multi-utilisateurs & permissions

Depuis la v3, le monitor gère **plusieurs comptes**, chacun avec ses propres
droits, plutôt qu'un unique identifiant/mot de passe partagé (Basic Auth).

### Comment ça marche

- Connexion par **session** (cookie), via un vrai écran de login — plus de
  popup navigateur.
- Les comptes et leurs permissions sont stockés dans une **base de
  données** : **SQLite** par défaut (fichier local `data/monitor.db`, aucune
  dépendance externe — recommandé pour la plupart des installations), ou
  **MySQL/MariaDB** en option si tu préfères centraliser ça dans un serveur
  SQL existant (`DB_DRIVER=mysql` dans `.env`).
- Un compte **admin** a tous les droits, sur toutes les apps.
- Un compte **non-admin** ne voit et ne peut agir que sur ce qui lui a été
  explicitement accordé, avec deux niveaux de granularité :
  - **par app** : `nom-de-l-app` (une app précise) ou `*` (toutes les apps)
  - **par action** : `restart`, `stop`, `logs`, `env`, `config`, `scale`,
    `watch`, `flush`, `reset`, `delete`, `start`, `reload`, `view`
    (visibilité dans la liste), ou `*` (toutes les actions sur cette app)

  Exemple : accorder `demo-app` / `restart` permet **seulement** de
  redémarrer `demo-app` — l'utilisateur ne verra même pas les autres apps
  dans l'interface.

  Il existe aussi des **actions globales**, non liées à une app précise :
  `system` (vue Système), `pm2_save`, `pm2_resurrect`, `pm2_flush_all`,
  `pm2_update`, `pm2_kill`, `manage_users` (gestion des comptes, admin
  uniquement), ainsi que `alerts_read` / `alerts_create` / `alerts_update` /
  `alerts_delete` / `alerts_acknowledge` (moteur d'alertes), `events_read`
  (timeline d'événements), `incidents_read` / `incidents_manage`
  (incidents corrélés + silences, voir
  [Incidents & Silences](#incidents--silences-phase-14)) et `anomaly_read` /
  `anomaly_create` / `anomaly_update` / `anomaly_delete` (détection
  d'anomalies, voir [Détection d'anomalies](#détection-danomalies-phase-16))
  — ces dernières ne sont pas décomposées par app dans cette phase.

- L'API et le WebSocket **revalident chaque requête** côté serveur : les
  boutons masqués côté interface ne sont qu'un confort visuel, la sécurité
  réelle est appliquée sur chaque route.

### Premier démarrage

Au tout premier démarrage (aucun utilisateur en base), un compte **admin**
est créé automatiquement à partir de `PM2_MONITOR_USER` / `PM2_MONITOR_PASS`
dans `.env` (ou `admin` + mot de passe généré si absents — affiché une seule
fois dans les logs du serveur). Ces deux variables ne servent qu'à cette
création initiale ; elles peuvent être retirées du `.env` ensuite.

```bash
cp .env.example .env
```

```
PM2_MONITOR_USER=admin
PM2_MONITOR_PASS=un-mot-de-passe-solide
SESSION_SECRET=une-chaine-aleatoire-longue   # à définir en production (voir plus bas)

DB_DRIVER=sqlite    # ou "mysql" — voir .env.example pour la config MySQL complète
```

> Tu peux aussi préparer ce fichier ailleurs (poste de travail, secret
> manager…) et le charger directement à l'installation avec
> `./deploy.sh install --env-file /chemin/vers/mon.env` plutôt que de le
> copier manuellement sur le serveur — voir [Installation](#installation).

### Gérer les comptes

**Depuis l'interface** (admin uniquement) : bouton **"👤 Utilisateurs"** en
haut de l'écran → créer un compte, cocher ses permissions par app/action
dans un tableau, changer un mot de passe, promouvoir/rétrograder admin,
supprimer un compte.

**En ligne de commande** (pratique en SSH, ou pour scripter le provisioning) :

```bash
./deploy.sh users list
./deploy.sh users create operateur "mot-de-passe-au-moins-8-car" [--admin]
./deploy.sh users grant  operateur demo-app restart
./deploy.sh users grant  operateur demo-app view
./deploy.sh users revoke operateur demo-app restart
./deploy.sh users promote operateur     # devient admin
./deploy.sh users demote  operateur     # n'est plus admin
./deploy.sh users passwd  operateur "nouveau-mot-de-passe"
./deploy.sh users delete  operateur
```

(équivalent direct : `node bin/manage-users.js …` si tu n'utilises pas `deploy.sh`)

### Désactiver l'auth (déconseillé)

Pour un usage strictement local / de test : `PM2_MONITOR_DISABLE_AUTH=1`
dans `.env` — toutes les vérifications de session et de permission sont
alors désactivées, tout le monde a un accès admin complet.

### Migration depuis une installation existante (v2 → v3)

Rien à faire de spécial : au premier démarrage après mise à jour, si aucun
utilisateur n'existe encore en base, l'ancien `PM2_MONITOR_USER` /
`PM2_MONITOR_PASS` du `.env` est automatiquement repris pour créer le
premier compte admin. Lance ensuite `./deploy.sh update` (qui fait tourner
`npm install` et rebuild le frontend) puis crée d'autres comptes si besoin.

## Pour aller plus loin

Backlog non engagé d'idées de fonctionnalités (avec effort estimé et point
de départ dans le code) : [`docs/features.md`](docs/features.md).

## Notes importantes

- Le serveur doit tourner **là où PM2 est installé et gère les process**
  (même machine, même utilisateur). Il ne se connecte pas à un PM2 distant.
- Les sessions sont protégées par `SESSION_SECRET` : défini-le explicitement
  en production (sinon un secret aléatoire est généré à chaque redémarrage
  du process, ce qui déconnecte tout le monde à chaque restart).
- Les secrets de providers de notification (mot de passe SMTP, webhook
  Discord/Slack, bot token Telegram) sont chiffrés au repos via
  `NOTIFICATIONS_ENCRYPTION_KEY` : même logique que `SESSION_SECRET`, mais
  un redémarrage sans clé explicite rend les secrets déjà stockés
  **définitivement** indéchiffrables (voir
  [`docs/notifications/README.md#secrets`](docs/notifications/README.md#secrets)).
- Le trafic n'est **pas chiffré** en HTTP simple : si tu exposes le
  dashboard au-delà de `localhost`, mets-le derrière un reverse proxy HTTPS
  (nginx + certificat, voir `./deploy.sh install --domain …`) ou un VPN, et
  pense à `SESSION_COOKIE_SECURE=1` une fois en HTTPS.
- Pour le faire tourner en continu, tu peux même le gérer... par PM2 :
  ```bash
  pm2 start server.js --name pm2-monitor
  ```

## Traductions / Internationalisation (i18n)

L'interface Vue supporte le **français** et l'**anglais** via `vue-i18n`.
Le sélecteur de langue est dans la barre du haut (🇫🇷/🇬🇧) ; la langue
choisie est mémorisée localement, avec détection automatique de la langue
du navigateur au premier chargement.

Les fichiers de traduction se trouvent dans
`frontend/src/i18n/locales/{fr,en}.json`. Pour vérifier qu'ils restent
synchronisés (mêmes clés dans les deux langues) :

```bash
npm run check:i18n
```

Ajouter une nouvelle langue est bienvenu — voir
[CONTRIBUTING.md#traductions--i18n](CONTRIBUTING.md#traductions--i18n).

## Contribution

Les contributions sont les bienvenues, qu'il s'agisse de correctifs, de
nouvelles fonctionnalités, de traductions ou simplement de rapports de bug.

- 📖 Guide complet : [CONTRIBUTING.md](CONTRIBUTING.md)
- 🤝 Code de conduite : [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 🔒 Signaler une vulnérabilité : [SECURITY.md](SECURITY.md)
- 📝 Historique des changements : [CHANGELOG.md](CHANGELOG.md)
- ⚖️ Licence : [MIT](LICENSE)

Pour démarrer rapidement :

```bash
git clone https://github.com/<ton-fork>/pm2-monitor.git
cd pm2-monitor
npm install
cp .env.example .env
npm run dev
```

Puis ouvre une [issue](../../issues) ou une
[pull request](../../pulls) — en français ou en anglais, comme tu préfères.
