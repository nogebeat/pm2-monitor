# Architecture

Ce document explique les choix techniques structurants du projet, phase par
phase.

- **Phase 1 — Fondations** (ci-dessous) : migrations DB versionnées,
  squelette `lib/services/`, harness de tests, file d'attente persistante.
- **Phase 2 — Alertes** : voir [Décisions phase 2](#décisions-phase-2--alertes)
  plus bas, et le détail fonctionnel dans
  [`docs/alerts/README.md`](alerts/README.md).
- **Phase 3 — Historique par process** : voir
  [Décisions phase 3](#décisions-phase-3--historique-par-process) plus bas.

## Fondations (Phase 1)

## 1. Migrations DB versionnées

### Avant

Les tables (`users`, `permissions`) étaient créées directement via
`CREATE TABLE IF NOT EXISTS` au démarrage, dans chaque driver
(`lib/db/sqlite-driver.js`, `lib/db/mysql-driver.js`). Fonctionnel, mais pas
versionné : impossible de savoir "où en est" une base donnée, pas de
mécanisme pour faire évoluer le schéma proprement (ajout de colonne,
nouvelle table…) sans réécrire le bloc SQL en dur.

### Après

- `lib/db/migrations/*.js` : une migration = un fichier `{ version, description, up(db), down(db) }`.
  - `001_initial_schema` : reprend exactement l'ancien schéma (users +
    permissions), avec les mêmes `CREATE TABLE IF NOT EXISTS`.
  - `002_job_queue` : ajoute la table `jobs` (voir section File d'attente).
- `lib/db/migrator.js` : charge les migrations du dossier, tient à jour une
  table `schema_migrations (version, applied_at)`, expose `up()`, `down()`,
  `status()`.
- `bin/migrate.js` : CLI (`node bin/migrate.js up|down|status`), branché
  aussi sur `./deploy.sh migrate <up|down|status>`.
- `server.js` exécute `migrator.up()` automatiquement au démarrage, juste
  après la connexion DB et avant la création du compte admin par défaut —
  une installation existante qui se met à jour n'a donc **rien à faire
  manuellement** ; la migration s'applique au premier redémarrage du
  service.

### Pourquoi ce découpage (et pas un ORM avec migrations intégrées) ?

Le projet n'utilise aucun ORM (accès SQL direct via l'abstraction
`lib/db`), et en ajouter un uniquement pour ses migrations aurait été
disproportionné et aurait dupliqué la couche d'accès aux données déjà en
place. Le système ci-dessus reste au plus près de l'existant : les
migrations utilisent la même interface `db.run/get/all` que le reste du
code (`user-store.js`, etc.), avec juste l'ajout de `beginTransaction()` /
`commit()` / `rollback()`.

### Compatibilité avec une installation existante

`001_initial_schema` utilise `CREATE TABLE IF NOT EXISTS` : sur une base
déjà créée par une version antérieure du projet, ces instructions ne font
rien (les tables existent déjà, avec leurs données), et la migration est
simplement enregistrée comme "appliquée" dans `schema_migrations`. Aucune
perte de données. Testé explicitement (voir section Tests).

### Transactions

- **SQLite** : `BEGIN`/`COMMIT`/`ROLLBACK` couvrent aussi le DDL
  (`CREATE TABLE` inclus) — une migration qui échoue en cours de route est
  intégralement annulée, y compris les tables déjà créées dans la même
  migration.
- **MySQL** : InnoDB effectue un **COMMIT implicite à chaque instruction
  DDL**. Une transaction MySQL ne peut donc pas annuler un `CREATE TABLE`
  déjà exécuté (limitation de MySQL, pas de notre système). C'est
  précisément pour ça que chaque migration est écrite de façon idempotente
  (`IF NOT EXISTS` / `IF EXISTS`) : en cas d'échec partiel sous MySQL, on
  peut toujours relancer `migrate up` sans risque de doublon ni d'erreur.
  Les instructions DML (INSERT/UPDATE/DELETE — utilisées par exemple pour
  écrire dans `schema_migrations`) restent, elles, pleinement
  transactionnelles sous MySQL.

## 2. `lib/services/`

Nouveau dossier pour les futurs services métier (alertes, notifications,
métriques, etc.), séparés de `server.js` (qui reste la couche HTTP/WebSocket
uniquement — cf. règle "ne mets pas toute la logique dans server.js").

Seul `lib/services/queue/` est implémenté dans cette phase : c'est la seule
brique dont l'infrastructure a explicitement besoin maintenant. Les autres
dossiers prévus (`alerts/`, `notifications/`, `metrics/`, `events/`,
`health/`, `healing/`, `audit/`) sont documentés dans
`lib/services/README.md` mais **pas créés** tant qu'une phase n'en a pas
réellement besoin, pour éviter le code mort.

## 3. Harness de tests : `node:test` (pas Vitest)

| Critère                | `node:test`                          | Vitest                              |
|-------------------------|---------------------------------------|--------------------------------------|
| Dépendance ajoutée       | Aucune (module natif Node ≥ 18)       | Nouvelle dépendance (+ config)       |
| Stack existante          | Déjà 100% CommonJS, aucun bundler     | Pensé pour Vite/ESM (le projet a un Vite… mais côté frontend Vue, pas backend) |
| Mocks                    | `node:test` + `node:assert` suffisent pour les besoins actuels (pas de mocking DB complexe : tests contre de vraies bases SQLite temporaires) | Mocking plus riche, pas nécessaire ici |
| Tests async               | Support natif (`async` test functions, `t.beforeEach`/`t.afterEach`) | Support natif aussi |
| Tests API (CLI/process)   | `child_process.execFile` natif, aucune dépendance | Idem, mais via une couche en plus |
| Maintenance               | Zéro dépendance à mettre à jour       | Dépendance à suivre (versions, breaking changes) |
| CI                         | `node --test` fonctionne tel quel dans n'importe quelle image Node | Nécessite d'installer Vitest dans l'image CI |

Le projet est un backend Express/Socket.IO pur CommonJS sans bundler
côté serveur ; `node:test` couvre tous les besoins de cette phase
(tests unitaires sur DB temporaire, tests d'intégration via sous-process
CLI). Ajouter Vitest n'aurait apporté aucun bénéfice concret ici, seulement
une dépendance supplémentaire à maintenir — d'où le choix de **ne pas
l'ajouter**, conformément à la règle "ne rajoute pas Vitest si `node:test`
suffit".

Structure :

```
test/
├── unit/          # DB temporaire en mémoire de test, dans le même process
│   ├── migrator.test.js
│   └── persistent-queue.test.js
├── integration/    # sous-process réels (bin/migrate.js, redémarrage simulé)
│   ├── migrate-cli.test.js
│   └── queue-restart.test.js
└── helpers/
    └── tmp-db.js   # fichier SQLite temporaire isolé par test
```

Commandes : `npm test`, `npm run test:unit`, `npm run test:integration`
(voir README pour le détail).

## 4. File d'attente persistante

### Évaluation de `better-queue` / `bee-queue`

- **`bee-queue`** impose Redis comme backend. Ça casse directement la
  contrainte du projet "aucune dépendance SaaS/infra obligatoire" pour une
  installation self-hosted simple (`./deploy.sh install` sur un serveur nu).
- **`better-queue`** peut persister sur disque, mais via un store séparé
  (fichier JSON, ou SQLite dédié via un store tiers) — ça créerait un
  **second système de stockage** en parallèle de `lib/db` (déjà abstrait
  sqlite/mysql, déjà migré). Les règles du projet interdisent explicitement
  de dupliquer un système déjà présent.

### Solution retenue

Une file d'attente persistante minimale, `lib/services/queue/`, adossée à
`lib/db` (donc au même SQLite ou MySQL déjà configuré par l'utilisateur) via
une nouvelle table `jobs` (migration `002_job_queue`). Aucune dépendance
ajoutée, aucun second système de stockage, fonctionne aussi bien en SQLite
qu'en MySQL puisqu'elle passe par l'abstraction existante.

Fonctionnement :

- `add(payload, { delayMs, maxAttempts })` insère un job `pending`.
- Un `PersistentQueue` polle (`setInterval`, configurable) et réserve
  atomiquement le prochain job éligible (`UPDATE ... WHERE status='pending'`,
  ne procède que si la ligne a bien été affectée — évite un double
  traitement si jamais plusieurs pollers tournaient en parallèle).
- Succès → le job est supprimé (`DELETE`). Échec → réessai avec backoff
  jusqu'à `max_attempts`, puis passage en `failed` (conservé pour
  inspection/debug, jamais silencieusement perdu).
- `recoverStaleActiveJobs()` : à appeler au démarrage, avant `start()`.
  Un job resté `active` après un arrêt brutal du process est remis
  `pending` — sans ça, il resterait bloqué indéfiniment puisque personne ne
  le reconsidérerait comme du travail à faire.

**Persistance vérifiée par les tests** : un job créé, puis la connexion DB
fermée (simulation d'arrêt du process) et rouverte sur le même fichier
(simulation de redémarrage), existe toujours et est traité normalement —
voir `test/unit/persistent-queue.test.js` et, avec de vrais sous-process
Node distincts, `test/integration/queue-restart.test.js`.

Cette file ne contient aucune logique métier : elle sera consommée par les
futurs services (`alerts/`, `notifications/`) dans une phase ultérieure.

## Décisions phase 2 — Alertes

- **Machine à états en 4 états** (`trigger` → `active` → `resolved`,
  `active` → `acknowledged` → `resolved`) plutôt que 2 (`ok`/`alert`) : l'état
  `trigger` isole la période "condition vraie mais `duration_seconds` pas
  encore écoulée" sans jamais créer de bruit si la condition retombe avant
  l'échéance (la ligne est alors simplement supprimée, pas de "fausse
  alerte" dans l'historique). Détail complet dans
  [`lib/services/alerts/engine.js`](../lib/services/alerts/engine.js) (voir
  le diagramme en tête de fichier) et [`docs/alerts/README.md`](alerts/README.md).
- **Déduplication par clé `rule:targetType:targetValue:metric`** : une seule
  occurrence "ouverte" par combinaison règle/cible/métrique à la fois — une
  condition qui reste vraie met à jour (`touch`) l'occurrence existante au
  lieu d'en créer une nouvelle (anti-spam), indépendamment du cooldown (qui,
  lui, ne s'applique qu'*après* une résolution, pour bloquer un
  redéclenchement immédiat).
- **Permissions séparées par action** (`alerts_read/create/update/delete/
  acknowledge`) plutôt qu'une permission unique `alerts` : cohérent avec le
  découpage fin déjà en place pour les actions PM2 par app
  (`lib/permissions.js`), permet par exemple un rôle "peut acquitter sans
  pouvoir modifier les règles".
- **Aucun provider de notification dans cette phase** (choix du prompt de
  phase) : le moteur est utilisable et testable de bout en bout (règles →
  alertes actives → historique → ACK) sans dépendance à un canal externe,
  ce qui garde le projet 100% self-hosted à ce stade.

## Décisions phase 3 — Historique par process

- **Un seul poller PM2** : la collecte (`ProcessHistoryService.record()`)
  et l'évaluation des règles d'alerte "process" partagent le même
  `setInterval(() => pm2.list(...))` dans `lib/polling.js`, plutôt que deux
  boucles indépendantes — évite un second appel `pm2.list()` par tick (coût
  et charge PM2 inutiles) pour un besoin déjà couvert par la boucle
  existante. Le rollup/purge, lui, tourne sur son propre intervalle
  (`PROCESS_HISTORY_MAINTENANCE_INTERVAL_MS`), indépendant de la collecte.
- **Deux tables** (`process_metrics_raw`, `process_metrics_rollup`) plutôt
  que trois (une par résolution) : `process_metrics_rollup` porte une
  colonne `resolution` (`medium`/`long`) pour éviter de dupliquer un schéma
  quasi identique — voir migration `004_process_metrics.js`.
- **`process_name` comme identifiant de cible** (pas le `pm_id` PM2, qui
  change à chaque suppression/recréation du process) — même choix que la
  table `alert_rules` (phase 2), pour rester cohérent dans tout le projet.
- **Résolution auto côté API** : si `resolution` n'est pas fourni sur
  `GET /processes/:id/metrics`, elle est déduite de la plage demandée
  (`rawMaxSpanMs`/`mediumMaxSpanMs`), pour éviter qu'un client demandant "30
  jours" reçoive par erreur des millions de points bruts.
