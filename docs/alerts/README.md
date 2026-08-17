# Moteur d'alertes

Phase 2 du projet : un moteur d'évaluation de règles (CPU/RAM/disque/
température/restarts/statut process) qui déclenche, dédoublonne et fait
vivre des occurrences d'alerte jusqu'à leur résolution.

**Aucun envoi de notification dans cette phase** (pas d'email/webhook/Slack).
Les alertes sont consultables uniquement via l'API REST décrite ci-dessous ;
le branchement de providers de notification (probablement consommateurs de
`lib/services/queue/`, déjà présente) est prévu pour une phase ultérieure —
voir `lib/services/README.md`.

Le moteur fonctionne même si aucune règle n'est configurée (aucune
évaluation ne produit alors d'alerte) et même en environnement 100%
self-hosted sans dépendance externe : tout repose sur la base de données déjà
utilisée par le reste du projet (SQLite ou MySQL selon `DB_DRIVER`).

## Sommaire

- [Architecture](#architecture)
- [Modèle de règle (alert rule)](#modèle-de-règle-alert-rule)
- [Conditions et opérateurs](#conditions-et-opérateurs)
- [Durée (anti bruit de mesure)](#durée-anti-bruit-de-mesure)
- [Cooldown (anti-flapping)](#cooldown-anti-flapping)
- [Déduplication](#déduplication)
- [États d'une alerte](#états-dune-alerte)
- [Évaluation périodique](#évaluation-périodique)
- [API REST](#api-rest)
- [Permissions](#permissions)
- [Configuration (.env)](#configuration-env)
- [Migration](#migration)
- [Limites connues](#limites-connues)

## Architecture

```
lib/services/alerts/
├── alert-rules-store.js   # CRUD + validation de la table alert_rules
├── alert-store.js         # CRUD de la table alerts (occurrences) + requêtes actives/historique
├── collector.js           # extraction pure d'une valeur de métrique (snapshot système / process PM2)
├── engine.js               # AlertEngine : evaluate/trigger/resolve/acknowledge/deduplicate/cooldown
└── index.js                 # singleton AlertEngine partagé (routeur REST + scheduler)

lib/routes/alerts.js        # routeur Express (/api/alerts/…), aucune logique métier dedans
lib/db/migrations/003_alert_engine.js   # tables alert_rules, alerts
```

`AlertEngine` ne connaît ni Express ni PM2 : il reçoit une règle et une
valeur déjà mesurée (`engine.evaluate(rule, target, value)`), ou une liste de
règles à évaluer contre un relevé déjà collecté
(`evaluateSystemReading(snapshot)` / `evaluateProcessReadings(processList)`).
`lib/polling.js` est la seule couche qui parle à PM2/Socket.IO pour ces deux
boucles ; il se contente d'appeler ces deux méthodes depuis les boucles de
polling déjà existantes (voir [Évaluation périodique](#évaluation-périodique)).

## Modèle de règle (alert rule)

| Champ              | Type                      | Description                                                                 |
|---------------------|----------------------------|-------------------------------------------------------------------------------|
| `name`               | string (requis)             | Nom lisible.                                                                  |
| `description`        | string                       | Optionnelle.                                                                  |
| `enabled`             | bool (défaut `true`)         | Une règle désactivée n'est jamais évaluée.                                    |
| `targetType`          | `"process"` \| `"system"`    | Cible une app PM2 précise, ou une métrique machine globale.                   |
| `targetValue`         | string \| `"*"` \| `null`     | Nom de l'app PM2 (ou `"*"` = toutes les apps) si `targetType="process"`. Ignoré (mis à `null`) si `targetType="system"`. |
| `metric`              | string (voir ci-dessous)     | Métrique surveillée.                                                          |
| `operator`            | `>` `>=` `<` `<=` `==` `!=` | Opérateur de comparaison.                                                     |
| `threshold`           | number \| string             | Seuil. Numérique pour la plupart des métriques ; chaîne pour `status` (ex: `"stopped"`). |
| `durationSeconds`     | number (défaut `0`)          | La condition doit rester vraie sans interruption pendant cette durée avant de déclencher réellement l'alerte. |
| `severity`            | `info` \| `warning` \| `critical` (défaut `warning`) | Utilisée pour trier/filtrer, pas de logique de routage dans cette phase.      |
| `cooldownSeconds`     | number (défaut `0`)          | Délai minimum après résolution avant qu'une nouvelle occurrence puisse se déclencher pour la même règle+cible+métrique. |

Métriques valides par `targetType` :

| `targetType`  | Métriques                                            |
|----------------|--------------------------------------------------------|
| `process`       | `cpu` (%), `memory` (Mo, absolu — un process n'a pas de "total" de référence), `restart_count`, `status` |
| `system`         | `cpu` (%), `memory` (% RAM utilisée), `disk` (% utilisé sur `/`), `temperature` (°C, Linux uniquement) |

Si une métrique n'est pas disponible sur la plateforme (ex : température hors
Linux, disque non lisible) la lecture renvoie `null` et la règle est
simplement ignorée à ce tick — elle n'est ni "vraie" ni "fausse", elle
n'est pas évaluée.

## Conditions et opérateurs

`value <operator> threshold`, ex. `CPU > 80` (avec `threshold = 80`).
Comparaison **numérique** si `value` et `threshold` sont tous deux des
nombres valides ; sinon comparaison de **chaînes** (cas de `status`, ex.
`status == "stopped"`).

## Durée (anti bruit de mesure)

Une règle avec `durationSeconds = 300` (5 min) ne déclenche **pas**
immédiatement dès que la condition devient vraie : le moteur enregistre le
moment où la condition est devenue vraie (`condition_met_at`) et ne fait
passer l'alerte à l'état `active` que si la condition est restée vraie sans
interruption pendant au moins `durationSeconds`. Si la condition redevient
fausse avant l'échéance, rien ne se produit : le pic bref n'a jamais généré
d'alerte (voir [États](#états-dune-alerte), état `trigger`).

## Cooldown (anti-flapping)

À la résolution d'une alerte (`active`/`acknowledged` → `resolved`), le
moteur pose `cooldown_until = resolved_at + cooldownSeconds * 1000`. Si la
même condition redevient vraie avant cette échéance, **aucune** nouvelle
occurrence n'est créée pour cette règle+cible+métrique tant que le cooldown
n'est pas passé — évite qu'une valeur qui oscille juste autour du seuil
génère une rafale d'alertes coup sur coup.

## Déduplication

Clé de déduplication = `ruleId + targetType + targetValue + metric` (ex :
`"3:process:api-prod:cpu"`). Tant qu'une occurrence "ouverte" existe pour
cette clé (état `trigger`, `active` ou `acknowledged`), toute nouvelle
lecture qui confirme la même condition **met à jour** cette occurrence
(valeur observée, horodatage `last_seen_at`) au lieu d'en créer une
nouvelle. Une seule alerte "vivante" par règle+cible+métrique à la fois.

## États d'une alerte

```
 (aucune ligne)
        │  condition vraie
        ▼
     trigger  ──── condition redevient fausse avant la durée requise ────►  (supprimée, jamais "réellement" déclenchée)
        │  durée requise atteinte, condition toujours vraie
        ▼
      active  ──── condition devient fausse ────►  resolved  (pose le cooldown)
        │
        │  acknowledge()
        ▼
 acknowledged  ──── condition devient fausse ────►  resolved  (pose le cooldown)
```

- **`trigger`** : condition vraie, en attente que `durationSeconds` s'écoule.
  Ligne purement transitoire : si la condition retombe avant l'échéance,
  elle est supprimée (pas de trace dans l'historique — ce n'était pas une
  vraie alerte).
- **`active`** : alerte réellement déclenchée. C'est l'état qu'un futur
  provider de notification consommerait.
- **`acknowledged`** : un utilisateur a accusé réception (`POST
  /api/alerts/:id/acknowledge`). L'alerte continue d'être suivie (la valeur
  observée est mise à jour à chaque lecture) mais ne génère plus de bruit ;
  elle se résout normalement dès que la condition redevient fausse.
- **`resolved`** : condition redevenue fausse. Ligne conservée pour
  l'historique (`GET /api/alerts/history`), jamais supprimée automatiquement.

Transitions **non** autorisées (et donc rejetées) : on ne peut acquitter
qu'une alerte `active` (acquitter une alerte déjà `acknowledged` est
idempotent — retourne l'alerte telle quelle ; acquitter une alerte `trigger`
ou `resolved` lève une erreur).

## Évaluation périodique

Deux points d'entrée, appelés depuis `lib/polling.js` (`startPolling()`,
lancé une fois au boot par `server.js`), chacun réutilisant une boucle de
polling déjà existante (pas de second poller PM2, pas de second bus) :

- `engine.evaluateSystemReading(snapshot)` : appelé à chaque tick de la
  boucle d'échantillonnage système déjà en place (`SAMPLE_INTERVAL_MS`,
  celle qui alimente aussi `HistoryStore` et l'évènement Socket.IO
  `"system"`). Évalue toutes les règles `targetType="system"` activées.
- `engine.evaluateProcessReadings(processList)` : appelé par une boucle
  dédiée (`setInterval`, fréquence `ALERTS_EVAL_INTERVAL_MS`), indépendante
  du polling par socket existant (`lib/realtime/process-socket.js`) —
  celui-ci ne tourne que si un client est connecté, alors que les alertes
  doivent continuer à s'évaluer même sans personne devant le dashboard.
  Réutilise `pm2.list()` + le même `fmtProcess()` que le reste de l'appli
  (`lib/process-helpers.js`). Évalue toutes les règles `targetType="process"`
  activées, sur chaque process ciblé (nom précis ou `"*"` = toutes les apps
  actuellement listées par PM2).

Toute cette logique de scheduling (deux boucles) reste dans `lib/polling.js`
(la couche transport), mais **aucun calcul métier n'y est fait** : il ne
fait qu'appeler `alertEngine.evaluateXxxReading(...)`. La désactiver
entièrement se fait via `ALERTS_ENABLED=0`.

## API REST

Toutes les routes sont sous `/api/alerts` et nécessitent une permission
`alerts_*` (voir [Permissions](#permissions)). Comme le reste de l'API, elles
répondent en JSON et renvoient `{ "error": "…" }` avec un code HTTP ≥ 400 en
cas d'échec.

### Règles

| Méthode | Route                    | Permission        | Description                                  |
|----------|----------------------------|---------------------|------------------------------------------------|
| GET      | `/api/alerts/rules`         | `alerts_read`        | Liste les règles. `?enabled=1` filtre les activées seulement. |
| GET      | `/api/alerts/rules/:id`     | `alerts_read`        | Détail d'une règle. `404` si absente.          |
| POST     | `/api/alerts/rules`          | `alerts_create`      | Crée une règle (voir [modèle](#modèle-de-règle-alert-rule)). `400` si invalide. |
| PUT/PATCH | `/api/alerts/rules/:id`     | `alerts_update`      | Met à jour (partiel pour `PATCH` comme pour `PUT` dans cette implémentation — seuls les champs fournis sont validés). |
| DELETE   | `/api/alerts/rules/:id`      | `alerts_delete`      | Supprime la règle. Les alertes déjà émises pour cette règle restent dans l'historique (`rule_id` passe à `NULL`, `rule_name` déjà dupliqué dans chaque alerte). |
| GET      | `/api/alerts/catalog`         | `alerts_read`        | Catalogue des `targetTypes`/métriques par cible/opérateurs/sévérités valides — pratique pour construire un formulaire. |

### Alertes (occurrences)

| Méthode | Route                              | Permission            | Description |
|----------|---------------------------------------|--------------------------|---------------|
| GET      | `/api/alerts/active`                    | `alerts_read`             | Alertes actuellement vivantes (`active`/`acknowledged` par défaut). `?includePending=1` inclut aussi celles en état `trigger` (en attente de durée). Triées par sévérité (critical d'abord) puis date de déclenchement. |
| GET      | `/api/alerts/history`                    | `alerts_read`             | Historique paginé, toutes occurrences confondues (y compris actives). Filtres : `?state=`, `?severity=`, `?ruleId=`, `?limit=` (défaut 100, max 1000), `?offset=`. |
| POST     | `/api/alerts/:id/acknowledge`             | `alerts_acknowledge`      | Acquitte une alerte `active`. `400` si l'alerte n'est pas dans un état acquittable, `404` si elle n'existe pas. |

### Exemple : créer une règle "CPU > 80% pendant 5 min"

```bash
curl -X POST http://localhost:4200/api/alerts/rules \
  -H "Content-Type: application/json" -b cookies.txt \
  -d '{
    "name": "CPU élevé — api-prod",
    "targetType": "process",
    "targetValue": "api-prod",
    "metric": "cpu",
    "operator": ">",
    "threshold": 80,
    "durationSeconds": 300,
    "cooldownSeconds": 1800,
    "severity": "critical"
  }'
```

## Permissions

Réutilise le système existant (`lib/permissions.js`, `hasPermission()`),
sans nouveau mécanisme. Cinq actions **globales** (pas liées à une app
précise, contrairement à `restart`/`logs`/etc. — gérer les règles d'alerte
est une action de configuration du monitor lui-même) :

| Action                | Description                                    |
|-------------------------|---------------------------------------------------|
| `alerts_read`             | Voir les règles, les alertes actives et l'historique. |
| `alerts_create`           | Créer une règle.                                    |
| `alerts_update`           | Modifier une règle.                                 |
| `alerts_delete`           | Supprimer une règle.                                |
| `alerts_acknowledge`       | Acquitter une alerte active.                        |

Accordables via l'UI existante (menu utilisateurs, admin) ou en CLI :

```bash
node bin/manage-users.js grant <username> "*" alerts_read
node bin/manage-users.js grant <username> "*" alerts_acknowledge
```

(`APP_ACTIONS`/`GLOBAL_ACTIONS` étant lus dynamiquement par
`bin/manage-users.js`, aucune modification de ce script n'a été nécessaire.)

## Configuration (.env)

```bash
# Passe à 0 pour désactiver l'évaluation périodique (l'API de gestion des
# règles/alertes reste disponible, rien ne se déclenche automatiquement).
ALERTS_ENABLED=1

# Fréquence (ms) d'évaluation des règles "process". Les règles "system" sont
# évaluées au rythme de l'échantillonnage système existant, indépendamment.
ALERTS_EVAL_INTERVAL_MS=15000
```

Voir `.env.example` à la racine du projet pour le fichier complet (copier en
`.env` et adapter). Aucune de ces variables n'est requise : les valeurs par
défaut ci-dessus s'appliquent si elles sont absentes.

## Migration

```text
version : 003_alert_engine
up      : crée les tables alert_rules et alerts (+ index dédiés)
down    : DROP TABLE alerts puis alert_rules (aucune donnée d'aucune autre
          table n'est affectée — users/permissions/jobs restent intacts)
rollback : node bin/migrate.js down            # annule 003_alert_engine seule
           node bin/migrate.js down --steps 3  # annule aussi 002 et 001
```

Comme les migrations précédentes, `up` est idempotent (`CREATE TABLE IF NOT
EXISTS`) : relancer `node bin/migrate.js up` sur une base déjà à jour ne fait
rien. `down` est destructif (perte des règles et de l'historique des
alertes) — à réserver au développement/tests, jamais recommandé en
production sans sauvegarde préalable.

## Limites connues

- `created_by` (sur une règle) et `acknowledged_by` (sur une alerte) sont de
  simples entiers **sans contrainte de clé étrangère** vers `users(id)` :
  en mode `PM2_MONITOR_DISABLE_AUTH=1`, l'utilisateur "virtuel" a l'id `0`,
  qui n'existe jamais réellement dans `users` — une FK y ferait échouer
  chaque création de règle ou acquittement dans ce mode pourtant supporté
  par le reste du projet. Ces colonnes sont donc purement informatives
  (elles ne bloquent jamais une opération), et peuvent pointer vers un
  utilisateur depuis supprimé.
- Le seuil `threshold` est stocké en texte (`VARCHAR`/`TEXT`) pour pouvoir
  porter aussi bien un nombre (`"80"`) qu'une chaîne (`"stopped"` pour la
  métrique `status`) : la validation de format se fait côté application
  (`alert-rules-store.js`), pas côté base de données.
- Aucun provider de notification n'existe encore : une alerte qui passe à
  `active` ne déclenche pour l'instant aucun envoi externe, uniquement une
  ligne visible via `GET /api/alerts/active`.
  