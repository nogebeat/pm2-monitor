# PM2 Monitor

Interface graphique complète pour surveiller tes apps PM2 : liste des process,
statut, CPU/mémoire, redémarrages, et **logs en direct** (stdout/stderr) via WebSocket.

Ce n'est pas une page web statique : c'est un petit serveur Node.js à faire
tourner **sur la machine où PM2 gère déjà tes apps** (il se branche sur l'API
programmatique de PM2, comme le ferait `pm2 monit` en ligne de commande), avec
un frontend **Vue 3 + Vite** qui consomme cette API en REST + WebSocket.

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
├── server.js              # serveur Express + API REST + WebSocket + bus PM2
├── lib/
│   ├── db/                 # abstraction base de données (sqlite-driver.js, mysql-driver.js)
│   │   ├── migrations/       # migrations versionnées :
│   │   │   ├── 001_initial_schema.js    # users, permissions
│   │   │   ├── 002_job_queue.js         # jobs (file d'attente persistante)
│   │   │   ├── 003_alert_engine.js      # alert_rules, alerts
│   │   │   ├── 004_process_metrics.js   # process_metrics_raw, process_metrics_rollup
│   │   │   ├── 005_process_events.js    # process_events (timeline)
│   │   │   └── 006_notifications.js     # notification_providers, notification_routes, notification_history
│   │   └── migrator.js        # exécution des migrations (up/down/status)
│   ├── services/
│   │   ├── queue/             # file d'attente persistante générique (voir README dédié)
│   │   ├── alerts/            # moteur d'alertes (seuils, cooldown, dédup)
│   │   ├── process-history/   # historique CPU/RAM/restarts par process, multi-résolution
│   │   ├── events/            # timeline d'événements/crashs PM2
│   │   └── notifications/     # providers Email/Discord/Telegram/Slack/Webhook, secrets chiffrés
│   ├── routes/                # routes REST par domaine (alerts.js, events.js, process-history.js…)
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
│   └── notifications/
│       ├── README.md            # architecture, registry, secrets, API, permissions
│       └── providers/            # un .md par provider (config, sécurité, test, erreurs)
├── frontend/                # source du frontend Vue 3 + Vite
│   ├── src/
│   │   ├── components/        # TopBar, ProcessSidebar, LogsPanel, SystemView, EventsView,
│   │   │                       # LoginScreen, modales…
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
- installe Node.js et PM2 s'ils sont absents (ne touche à rien s'ils sont déjà là)
- installe les dépendances du serveur **et** celles du frontend
- **compile le frontend Vue 3 / Vite** (`frontend/` → `public/`)
- génère un `.env` avec un mot de passe sécurisé si tu n'en fournis pas
- démarre l'app sous PM2 et configure le redémarrage automatique au reboot
- (optionnel) configure nginx en reverse proxy + HTTPS via Let's Encrypt si tu donnes un domaine
- (optionnel) ouvre les bons ports dans le pare-feu (`ufw`) si présent
- relançable sans risque : il détecte ce qui est déjà en place et **rebuild le frontend à chaque `update`**

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
REST, permissions, DB réelle) ; `test/integration/process-history-api.test.js`
et `process-history-volume.test.js` (collecte → requête, purge/rollup sous
volume réaliste, taille disque et temps de requête bornés) ;
`test/integration/events-service.test.js` et `events-api.test.js`
(normalisation des packets PM2, filtres, pagination, permissions).

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
  multi-résolution avec purge automatique — voir
  [Historique par process](#historique-par-process).
- `lib/services/events/` : timeline d'événements/crashs PM2 (start, stop,
  restart, crash, statut) — voir [Timeline d'événements](#timeline-dévénements)
  et [`docs/events/README.md`](docs/events/README.md).
- `lib/services/notifications/` : système de notifications (Email/Discord/
  Telegram/Slack/Webhook générique) — providers opérationnels
  (`validateConfig`/`test`/`send`), voir [Notifications](#notifications) et
  [`docs/notifications/README.md`](docs/notifications/README.md). Le routing
  par règles, la file d'attente d'envoi et l'intégration avec le moteur
  d'alertes ne sont pas encore branchés.

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
cooldown anti-spam et déduplication. Fonctionne indépendamment des
notifications : les providers (Email/Discord/Telegram/Slack/Webhook, voir
[Notifications](#notifications)) sont opérationnels au niveau du code, mais
ne sont pas encore branchés au moteur d'alertes (routing par règles,
déclenchement automatique — prévu dans une phase suivante).

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

Système de notifications multi-providers, en construction par phases —
architecture, modèles de données, cinq providers opérationnels
(Email/SMTP, Discord, Telegram, Slack, Webhook générique) et désormais une
interface d'administration complète (Settings → Notifications →
Providers). Pas encore de routing automatique depuis les alertes (règles,
templates — Phase 5D) ni de mise en file d'attente/retry (Phase 5E) : voir
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
- **UI (Phase 5C)** : `Settings → Notifications → Providers` — liste des
  configurations (statut 🟢/⚪), `+ Add notification provider` avec
  formulaire dynamique selon le type choisi, `Edit`/`Test`/`Enable`/
  `Disable`/`Delete` par configuration. Un mot de passe/webhook/token déjà
  enregistré s'affiche masqué (`••••••••`) ; le laisser tel quel lors d'une
  modification conserve la valeur existante ("Keep existing credential").
  `Test` appelle réellement le provider et affiche `🟢 Notification sent
  successfully` ou une erreur sûre (`🔴 …`, jamais de secret).
- **Endpoints** : `GET /api/notifications/provider-types`,
  `GET/POST /api/notifications/providers`, `GET/PATCH/PUT/DELETE
  /api/notifications/providers/:id`, `POST
  /api/notifications/providers/:id/test`. Permissions : `notifications_read`,
  `notifications_create`, `notifications_update`, `notifications_delete`,
  `notifications_test`. Le routing par règles et les templates arrivent en
  Phase 5D.

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
  `alerts_delete` / `alerts_acknowledge` (moteur d'alertes) et `events_read`
  (timeline d'événements) — ces dernières ne sont pas décomposées par app
  dans cette phase.

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
  