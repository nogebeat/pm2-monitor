# Dashboard global (Phase 8)

Vue d'ensemble unique de l'état du serveur et des applications. Ce module ne
crée **aucune** nouvelle source de données ni nouveau canal temps réel : il
compose ce qui existe déjà (metrics système, process PM2, moteur d'alertes,
health checks, timeline d'événements, auto-healing).

## Composants

- `lib/services/dashboard/global-status.js` — `calculateGlobalStatus()` /
  `calculateGlobalStatusDetailed()` : fonctions **pures** (aucun accès
  DB/réseau/horloge) qui calculent l'état de santé global à partir de
  données déjà chargées. Testées en isolation dans
  `test/unit/global-status.test.js`.
- `lib/services/dashboard/process-overview.js` — `calculateProcessOverview()` :
  fonction pure qui compte les process par statut (total / online / stopped /
  errored / crashed / restarting).
- `lib/services/dashboard/index.js` — `buildSnapshot()` : assemble un
  instantané complet en appelant les services déjà utilisés ailleurs dans
  l'application (liste des process, `system-stats.js#snapshot()`, alertes
  actives, health checks, timeline d'événements, audit auto-healing) et les
  passe aux fonctions pures ci-dessus.
- `lib/routes/dashboard.js` — `GET /api/dashboard` : un seul endpoint REST,
  qui retourne l'instantané complet pour l'utilisateur courant.
- `frontend/src/components/DashboardView.vue` — onglet "Dashboard" : affiche
  l'instantané et se met à jour via le Socket.IO existant.

## Calcul du statut global

`calculateGlobalStatus(input)` retourne `"HEALTHY"`, `"WARNING"` ou
`"CRITICAL"`. C'est le pire des trois (`CRITICAL` > `WARNING` > `HEALTHY`)
parmi toutes les conditions ci-dessous. Dès qu'une condition **CRITICAL**
est vraie, `CRITICAL` prime toujours sur `WARNING`, quel que soit le reste.

### CRITICAL si au moins une des conditions suivantes :

- une alerte active de sévérité `critical` existe (état `active` ou
  `acknowledged` — un accusé de réception marque "vu", pas "résolu" : il ne
  change donc pas le statut global) ;
- au moins un health check est `DOWN` ;
- au moins un process est `errored`/`crashed` (au sens PM2 : un process qui
  a épuisé ses tentatives de redémarrage automatique — voir
  `process-overview.js`, `crashed` est un alias d'`errored`, pas une
  catégorie disjointe) ;
- CPU système ≥ 90 %, RAM ≥ 90 %, Disque ≥ 90 %, ou température CPU ≥ 85 °C
  (seuils par défaut, voir `DEFAULT_THRESHOLDS`, surchargeables via
  `input.thresholds`).

### WARNING (si aucune condition CRITICAL) si au moins une des conditions suivantes :

- une alerte active de sévérité `warning` existe ;
- au moins un health check est `DEGRADED` (répond, mais lentement / hors
  seuil) ou `UNKNOWN` (jamais encore vérifié avec succès) ;
- au moins un process est en cours de redémarrage (`restarting`, l'état
  transitoire PM2 `launching`, y compris pendant une action de
  l'auto-healing) ;
- CPU ≥ 70 %, RAM ≥ 75 %, Disque ≥ 80 %, ou température ≥ 70 °C.

### HEALTHY sinon.

### Données manquantes

Un signal sans donnée disponible (ex : metrics système non lisibles sur la
plateforme, tableau d'alertes/health checks `null` par absence de
permission) est traité comme **neutre** pour ce signal précis — il n'élève
jamais le statut à lui seul, plutôt que d'être traité comme une anomalie.

> Ces règles sont dupliquées, à dessein, en commentaire dans
> `lib/services/dashboard/global-status.js` (source de vérité pour
> l'implémentation). Garder les deux synchronisés si l'une change.

## Permissions

- Accès à `GET /api/dashboard` : permission globale `system` (même
  permission que l'onglet Système existant — le dashboard en est une
  extension, pas un nouveau périmètre).
- **Process** : filtrés par la visibilité existante (permission `view` par
  application), jamais l'ensemble en clair pour tout le monde.
- **Alertes** / **Health checks** : inclus seulement si l'utilisateur a
  respectivement `alerts_read` / `health_checks_read` ; sinon la section
  correspondante vaut `null` côté API plutôt que d'exposer des données sans
  droit de les voir. Le frontend affiche alors un message plutôt que la
  section vide.
- **Timeline récente** : les événements/alertes/auto-healing qui la
  composent ne sont inclus que si l'utilisateur a respectivement
  `events_read` / `alerts_read` / `authealing_read`.
- **Onglet par défaut à la connexion** (`frontend/src/store.js#bootstrap()`) :
  "Dashboard" si l'utilisateur a la permission `system`, sinon "Process"
  (l'onglet Dashboard, masqué dans `TopBar.vue` sans cette permission, ne
  lui serait de toute façon pas accessible).

## Temps réel

Le dashboard **ne crée aucun second système temps réel**. Il se met à jour
en réagissant aux événements déjà émis (par `lib/polling.js`,
`lib/realtime/process-socket.js`, `lib/realtime/pm2-bus.js` et
`lib/alert-dispatch.js`) sur le même Socket.IO que le reste de
l'application :

- `metrics.updated`
- `process.updated`
- `alert.triggered`
- `alert.resolved`
- `health.updated`
- `event.created`

Côté frontend (`frontend/src/store.js`), chacun de ces événements déclenche
un simple `GET /api/dashboard` (avec un léger debounce de 500 ms), et
seulement si l'onglet Dashboard est actuellement affiché — pour éviter de
dupliquer côté client le calcul de `calculateGlobalStatus()`, qui pourrait
diverger de celui du serveur. Un polling de secours (15 s) prend le relais
en cas d'événement manqué (ex. après une reconnexion Socket.IO).

## Tests

- `test/unit/global-status.test.js` : `calculateGlobalStatus()` en
  isolation (tout sain, warning, critical, conditions multiples, priorité
  CRITICAL > WARNING, données manquantes).
- `test/unit/dashboard-snapshot.test.js` : `calculateProcessOverview()` et
  la composition de `buildSnapshot()`.
- `test/integration/dashboard-api.test.js` : `GET /api/dashboard` de bout en
  bout (permissions, contenu de la réponse).
