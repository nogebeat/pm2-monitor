# Timeline d'événements

Historique des événements de cycle de vie PM2 (démarrages, arrêts,
redémarrages, crashs) par process, persisté et consultable via l'API et
l'onglet "Timeline" du frontend — indépendant des logs bruts (stdout/stderr,
voir `lib/log-store.js`) : ici, un enregistrement = un changement d'état
d'une app, pas une ligne de sortie.

```
lib/services/events/
├── config.js                # resolveConfig(env) : EVENTS_ENABLED, EVENTS_RETENTION_MS, EVENTS_MAINTENANCE_INTERVAL_MS
├── normalizer.js             # normalizeEvent(packet) : packet brut du bus PM2 -> événement normalisé (fonction pure)
├── event-store.js            # persistance table process_events (create/list/purgeOlderThan)
└── index.js                  # EventsService : recordFromPacket(), list(), start()/stop() (purge périodique)

lib/routes/events.js          # routeur Express (/api/events/…), aucune logique métier dedans
lib/realtime/pm2-bus.js       # bus PM2 (process:event) qui appelle recordFromPacket()
lib/db/migrations/005_process_events.js   # table process_events
frontend/src/components/EventsView.vue    # UI (onglet "Timeline")
```

`EventsService` ne connaît ni Express ni PM2 : il reçoit un packet déjà
émis par le bus PM2 (`recordFromPacket(packet)`), et expose `list()` pour la
lecture paginée. `lib/realtime/pm2-bus.js` reste la seule couche qui parle
au bus PM2 pour cette fonctionnalité — aucun second listener
`bus.on("process:event", …)` créé : c'est le même handler déjà utilisé pour
diffuser l'événement `"event"` en websocket au panneau de logs (voir
[Temps réel](#temps-réel)).

## De l'événement PM2 brut à la timeline

PM2 émet des événements assez bruts (`start`, `online`, `stop`, `restart`,
`exit`, `restart overlimit`, `delete`…), pas directement exploitables comme
timeline lisible. `normalizer.js#normalizeEvent()` est une fonction pure
(aucun accès DB/réseau) qui les traduit en un modèle stable :

| Type PM2 brut          | Type normalisé | Sévérité   |
|--------------------------|------------------|--------------|
| `start`                    | `started`          | `info`         |
| `online`                   | `online`            | `info`         |
| `stop`                     | `stopped`          | `info`         |
| `restart`                  | `restarted`        | `warning`      |
| `exit` (code 0, signal SIGINT/SIGTERM) | *(absorbé, non retenu)* | — |
| `exit` (code ≠ 0, ou signal autre) | `crashed`   | `critical`     |
| `restart overlimit`        | `errored`           | `critical`     |
| `delete`, tout événement inconnu | *(ignoré)*   | —              |

- **Détection de crash** : PM2 émet `exit` à chaque sortie de process, qu'elle
  soit volontaire ou non. Un `exit` est classé `crashed` seulement si le code
  de sortie est non-nul ou si le signal reçu n'est pas un signal d'arrêt
  "propre" (`SIGINT`/`SIGTERM`, ceux que PM2 utilise pour stop/restart) —
  sinon il est absorbé silencieusement, déjà couvert par l'événement
  `stopped`/`restarted` correspondant, pour ne pas dupliquer la timeline.
- **`restart overlimit`** (PM2 abandonne les tentatives après `max_restarts`)
  est normalisé en `errored`, le type le plus proche sémantiquement d'un
  abandon suite à échecs répétés.
- **`delete`** (app retirée du process manager) n'appartient pas au cycle de
  vie "started/stopped/crashed" et n'est pas retenu dans la timeline.
- **`offline`** fait partie du modèle (`EVENT_TYPES`, catalogue API, filtre
  UI) mais n'est **jamais produit** actuellement : le bus `process:event` de
  PM2 n'a pas d'événement brut distinct pour "devient offline" (contrairement
  à `online`) — un arrêt se traduit toujours par `stop` ou par un `exit` non
  planifié. Le type reste valide dans le modèle pour rester compatible avec
  un futur événement PM2 qui l'émettrait réellement, plutôt que d'inventer un
  événement synthétique peu fiable. Voir [Problèmes connus](#problèmes-connus).

`severity` est **dérivée du type**, jamais saisie par l'utilisateur — mêmes
valeurs que `lib/services/alerts/` (`info`/`warning`/`critical`), réutilisées
pour rester cohérent avec le reste du projet plutôt que d'inventer une
nouvelle échelle.

## Modèle d'un événement

| Champ         | Type              | Description                                                        |
|-----------------|---------------------|------------------------------------------------------------------------|
| `id`             | number               | Identifiant auto-incrémenté.                                          |
| `timestamp`      | number (ms epoch)    | Heure de **réception** du packet PM2 (PM2 ne fournit pas d'horodatage exploitable dans le packet lui-même). |
| `type`           | string                | Voir table ci-dessus.                                               |
| `severity`       | `info`\|`warning`\|`critical` | Dérivée du type.                                          |
| `process`        | string \| `null`      | Nom de l'app PM2.                                                    |
| `processId`      | number \| `null`      | `pm_id` PM2.                                                          |
| `server`         | string                | Hostname de la machine (préparation multi-hôte future, voir [Limites connues](#limites-connues)). |
| `status`         | string \| `null`      | Statut PM2 au moment de l'événement.                                |
| `exitCode`       | number \| `null`      | Uniquement renseigné pour un `exit`.                                 |
| `signal`         | string \| `null`      | Signal reçu, si applicable.                                          |
| `metadata`       | object                | `rawEvent` (nom brut PM2), `restartCount`, `lastKnownState`, `execMode` — blob JSON, pas de colonnes dédiées pour ne pas migrer le schéma à chaque nouveau détail. |
| `createdAt`      | number (ms epoch)     | Heure d'insertion en base.                                          |

Aucun contenu de log n'est dupliqué ici : `lib/log-store.js` reste l'unique
source des lignes de log, la timeline ne fait que référencer process +
période via `timestamp`.

## Activation / rétention

- `EVENTS_ENABLED` (défaut `1`) : `0` désactive entièrement la collecte —
  `recordFromPacket()` devient un no-op, `start()` ne lance pas le
  scheduler de purge. Les routes REST restent disponibles mais ne
  retournent que ce qui a déjà été enregistré avant désactivation.
- `EVENTS_RETENTION_MS` (défaut `90j` = `7776000000`) : purge automatique
  des événements plus anciens que cette durée.
- `EVENTS_MAINTENANCE_INTERVAL_MS` (défaut `1h` = `3600000`) : fréquence du
  cycle de purge. `purgeOnce()` est exposé indépendamment de `start()` pour
  les tests et un appel manuel ponctuel.
- La purge est gérée **en application**, pas par une contrainte SQL — même
  approche que `lib/services/process-history/rollup.js` — et ne tourne
  jamais en chevauchement (un cycle en cours ignore le tick suivant).

## API REST

Toutes les routes sont sous `/api/events` et nécessitent la permission
globale `events_read` (pas de décomposition par app, même choix que
`alerts_read` — voir [Permissions](#permissions)).

- **`GET /api/events`** — liste paginée, filtrable :
  - `process` : nom exact de l'app.
  - `type` : un des `EVENT_TYPES` (`started`, `stopped`, `restarted`,
    `online`, `offline`, `crashed`, `errored`) — 400 si invalide.
  - `severity` : `info`\|`warning`\|`critical` — 400 si invalide.
  - `start` / `end` : bornes en ms epoch sur `timestamp`.
  - `limit` (défaut `50`, max `500`) / `offset` : pagination **toujours**
    bornée, jamais d'historique complet renvoyé en une seule requête.
  - Réponse : `{ items, total, limit, offset }`.
- **`GET /api/events/catalog`** — `{ types, severities, severityByType }` :
  construit le filtre côté frontend sans dupliquer la liste des types, même
  schéma que `GET /api/alerts/catalog`.

## Permissions

`events_read` est une permission **globale** (pas par app) : comme
`alerts_read`, la lecture de la timeline n'est pas décomposée par
application dans cette phase — un utilisateur qui a `events_read` voit la
timeline de toutes les apps, il n'existe pas de filtre "cette app
seulement" au niveau des permissions (le filtre `process` côté requête
reste disponible, mais n'importe quel nom peut y être passé).

## Temps réel

Pas de second canal temps réel créé pour la timeline : `lib/realtime/pm2-bus.js`
diffuse déjà l'événement `"event"` (consommé par le panneau de logs) sur
chaque packet `process:event` reçu ; le même handler appelle en plus
`eventsService.recordFromPacket(packet)`, et si l'événement est retenu
(normalisé, non `null`), diffuse :

- `timeline_event` — consommé par l'onglet Timeline (`EventsView.vue`) :
  ajoute l'entrée en tête de liste si la vue est déjà chargée et affichée
  sur sa première page (pas de désynchronisation si l'utilisateur est sur
  une page suivante).
- `event.created` — alias dédié au [Dashboard global](../dashboard/README.md),
  même donnée, pour ne pas coupler le rafraîchissement du dashboard à
  l'événement `timeline_event` propre à l'onglet Timeline.

Aucun filtrage par permission au niveau du socket : le client n'affiche de
toute façon que ce que l'onglet Timeline montre déjà (visible pour
l'utilisateur courant via `can("events_read")` côté frontend) — même choix
que pour `"processes"`/`"log"`.

## Consommateurs de la timeline

En plus de l'UI, deux autres services réutilisent les mêmes événements
`process:event` **sans créer de second listener PM2** :

- **Auto-Healing** (`lib/services/auto-healing/`) : l'événement `exit`
  (via `feedFromPm2Event()`) est l'une de ses trois sources de
  déclenchement — voir [`docs/auto-healing/README.md`](../auto-healing/README.md).
- **Dashboard global** : la timeline récente fusionne événements process,
  transitions d'alerte et tentatives d'auto-healing — voir
  [`docs/dashboard/README.md`](../dashboard/README.md).

## Problèmes connus

- **`offline` jamais produit** : voir [le tableau de normalisation](#de-lévénement-pm2-brut-à-la-timeline)
  ci-dessus — le type reste dans le modèle pour compatibilité future, mais
  aucun packet PM2 actuel ne le déclenche.
- **Mono-hôte** : `server` est renseigné (`os.hostname()`) en préparation
  d'un futur mode multi-serveurs, mais ce moniteur reste mono-hôte — il n'y
  a pas de distinction fonctionnelle entre plusieurs hôtes dans cette phase
  (voir `features.md` à la racine du dépôt, piste "Multi-serveurs").
- **Pas de FK vers une table "apps"** : `process_name` sert d'identifiant de
  cible en texte libre, comme `process_metrics_raw` et `alerts` — le
  monitor ne maintient aucun registre d'apps indépendant de PM2 lui-même. Un
  process renommé ou supprimé puis recréé sous le même nom n'est donc pas
  distingué dans l'historique.
- **Horodatage = heure de réception**, pas heure exacte de l'événement côté
  PM2 (non fournie par le bus) — un léger décalage est possible sous forte
  charge, cohérent avec le traitement des lignes de log (`log:out`/`log:err`)
  qui fait de même.
