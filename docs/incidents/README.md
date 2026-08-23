# Incident Management & Alert Silencing

Phase 14 du projet : un système d'incidents construit **au-dessus** du
moteur d'alertes existant (`lib/services/alerts/`), sans le remplacer ni le
modifier. Une ou plusieurs occurrences d'alerte liées par une corrélation
déterministe forment un incident, suivi à travers un cycle de vie explicite
et une timeline qui réutilise les données déjà enregistrées ailleurs
(alertes, événements PM2, notifications, Auto-Healing) plutôt que de les
dupliquer.

## Sommaire

- [Concepts](#concepts)
- [Architecture](#architecture)
- [Modèle de données](#modèle-de-données)
- [Corrélation](#corrélation)
- [Timeline](#timeline)
- [Silencing](#silencing)
- [API REST](#api-rest)
- [Permissions](#permissions)
- [Interface](#interface)
- [Migration](#migration)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Concepts

- **Incident** : regroupement d'une ou plusieurs alertes considérées comme
  la même situation en cours (voir [Corrélation](#corrélation)). Traverse un
  cycle de vie explicite : `OPEN → ACKNOWLEDGED → INVESTIGATING → MITIGATED
→ RESOLVED`.
- **Timeline** : vue chronologique unifiée d'un incident — alerte
  déclenchée, événement PM2, notification envoyée, tentative
  d'Auto-Healing, acquittement, résolution — sans copier ces données dans
  une nouvelle table (voir [Timeline](#timeline)).
- **Silence** : règle qui empêche l'envoi de notifications pour les
  alertes correspondant à un critère donné (règle, process, tag,
  environnement, groupe), pendant une durée ou jusqu'à une date. Un silence
  **n'affecte jamais** l'alerte ni l'événement sous-jacent : seul le
  routing des notifications en tient compte.

## Architecture

```
lib/services/incidents/
├── incident-store.js   # CRUD incidents + machine à états + liaison aux alertes
├── timeline-store.js   # entrées natives (état/ack/silence) + fusion en lecture
├── correlation.js      # IncidentCorrelator — corrélation déterministe (pas d'IA)
├── silence-store.js    # CRUD silences + isSilenced()
├── config.js           # fenêtre de corrélation (INCIDENTS_CORRELATION_WINDOW_MS)
└── index.js            # assemble le tout, expose handleAlertTransition()

lib/routes/incidents.js                 # routeur Express (/api/incidents/…)
lib/db/migrations/016_incidents.js      # tables (voir Modèle de données)
frontend/src/components/IncidentsView.vue  # UI (onglet "Incidents")
```

Le point d'entrée unique est `handleAlertTransition(alert)`
(`lib/services/incidents/index.js`), appelé depuis
`lib/alert-dispatch.js#createDispatchAlertTransition` — le même hook déjà
utilisé pour les notifications et l'Auto-Healing. Chaque transition
d'alerte (process, système, ou health check) y passe, que l'alerte vienne
du polling principal ou des health checks ; ce module n'a donc aucune
dépendance directe sur `server.js`.

Le silencing s'intègre côté notifications, dans
`lib/services/notifications/routing/engine.js#dispatch` :
`silenceStore.isSilenced()` y est appelé après le matching des routes et
avant tout envoi — voir [Silencing](#silencing).

## Modèle de données

Quatre tables (migration `016_incidents`) :

| Table               | Rôle                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incidents`         | L'incident : titre, statut, sévérité agrégée, cible corrélée (`target_type`/`target_value`/`metric`), clé de corrélation, horodatages de cycle de vie.         |
| `incident_alerts`   | Association alerte → incident (`UNIQUE(alert_id)` : une alerte n'appartient qu'à un seul incident à la fois).                                                  |
| `incident_timeline` | Entrées **natives**, propres à l'incident (changement d'état, acquittement, silence créé) — jamais les événements déjà stockés ailleurs.                       |
| `alert_silences`    | Règles de silence : `scope_type` (`rule`/`process`/`tag`/`environment`/`group`), `scope_value`, `expires_at`, `reason`, `cancelled_at` (annulation anticipée). |

La sévérité d'un incident est la plus haute sévérité parmi ses alertes
liées (`critical` > `warning` > `info`) — elle ne redescend jamais
automatiquement, même si l'alerte la plus sévère se résout (reflète
qu'un incident a _été_ critique, y compris après mitigation).

## Corrélation

Déterministe, **sans IA** (`lib/services/incidents/correlation.js`).
Quand une alerte passe à l'état `active` :

1. Cherche un incident déjà **ouvert** (statut ≠ `RESOLVED`), mis à jour
   dans la fenêtre de corrélation (`INCIDENTS_CORRELATION_WINDOW_MS`,
   défaut 15 minutes), portant sur le **même process et le même type de
   problème** (métrique) — cas le plus fréquent (une alerte qui re-déclenche
   sur le même process avant que l'incident précédent ne soit résolu).
2. Sinon, cherche un incident ouvert dans la fenêtre sur la **même
   métrique**, dont le process partage au moins un **groupe**
   (`lib/services/process-organization/`) avec le process de la nouvelle
   alerte — capture le cas "plusieurs process du même groupe tombent en
   même temps" (ex: tous les workers d'une queue). Sans
   `processOrgStore` injecté, ce critère ne s'applique jamais (repli sûr).
3. Sinon, ouvre un nouvel incident.

"Même serveur" (un des critères demandés) est vérifié implicitement :
l'Alert Engine reste mono-hôte (voir
`lib/services/notifications/routing/engine.js`), donc deux alertes du même
process partagent nécessairement le même serveur. Le champ existe dans le
modèle de données en vue d'une future extension multi-serveur de l'Alert
Engine lui-même.

## Timeline

`timeline-store.js` distingue deux origines, jamais mélangées en écriture :

- des lignes **natives** (`incident_timeline`) pour ce qui est propre à
  l'incident : changement d'état, acquittement, silence créé.
- des lignes **dérivées**, résolues uniquement à la **lecture** en
  interrogeant les tables déjà existantes :
  - `alerts` (alerte déclenchée / résolue, ou "health check" si
    `targetType === "health_check"`) ;
  - `process_events` (`lib/services/events/`), filtré par la durée de vie
    de l'incident et par l'ensemble des process rattachés (le process
    "principal" de l'incident **et** tout autre process qu'une corrélation
    par groupe y aurait rattaché — pas seulement le tout premier) ;
  - `notification_history`, filtré par les `alert_id` des alertes
    rattachées ;
  - `auto_healing_audit`, filtré de la même façon que `process_events`
    ci-dessus (durée de vie de l'incident, tous les process rattachés).

Rien de tout cela n'est copié dans `incident_timeline` : `GET
/api/incidents/:id/timeline` fusionne les deux sources et les trie par
horodatage à chaque appel.

## Silencing

`silence-store.js#isSilenced(alert, processOrg)` évalue chaque silence actif
(non annulé, non expiré) contre l'alerte :

| `scope_type`  | Matche si...                                                         |
| ------------- | -------------------------------------------------------------------- |
| `rule`        | `scope_value` == l'id de la règle d'alerte (`alert.ruleId`).         |
| `process`     | l'alerte cible un process et `scope_value` == son nom.               |
| `tag`         | le process porte un tag == `scope_value` (organisation des process). |
| `environment` | l'environnement du process == `scope_value`.                         |
| `group`       | le process appartient à un groupe == `scope_value`.                  |

`RoutingEngine#dispatch` (notifications) appelle `isSilenced()` juste après
le matching des routes et **avant tout envoi**. Si l'alerte est silencée :

- aucun appel n'est fait au provider (Email/Discord/Telegram/Slack/Webhook) ;
- une entrée est tout de même écrite dans `notification_history` avec le
  statut `silenced` (visible dans **Settings → 🔔 Notifications → Historique**),
  pour que l'absence de notification soit explicite plutôt que silencieuse ;
- l'alerte et l'événement qui l'a déclenchée restent **intacts** : le
  silence n'agit que sur le routing, jamais sur `alerts`/`process_events`.

Sans `silenceStore` injecté (tests unitaires historiques de
`routing/engine.js`), le comportement est inchangé : aucune vérification de
silence n'est faite.

## API REST

Montée sous `/api/incidents` (`lib/routes/incidents.js`) :

| Méthode  | Route              | Permission         | Description                                                                                         |
| -------- | ------------------ | ------------------ | --------------------------------------------------------------------------------------------------- |
| `GET`    | `/`                | `incidents_read`   | Liste paginée, filtrable (`status`, `severity`, `targetType`, `targetValue`).                       |
| `GET`    | `/catalog`         | `incidents_read`   | États valides, transitions autorisées, types de scope/silence.                                      |
| `GET`    | `/silences`        | `incidents_read`   | Liste des silences (`?active=1` pour les actifs seulement).                                         |
| `POST`   | `/silences`        | `incidents_manage` | Crée un silence (`scopeType`, `scopeValue`, `silenceType`, `durationMinutes` ou `until`, `reason`). |
| `DELETE` | `/silences/:id`    | `incidents_manage` | Annule un silence avant son expiration naturelle.                                                   |
| `GET`    | `/:id`             | `incidents_read`   | Détail d'un incident (+ `alertIds`).                                                                |
| `GET`    | `/:id/timeline`    | `incidents_read`   | Timeline fusionnée (voir [Timeline](#timeline)).                                                    |
| `POST`   | `/:id/acknowledge` | `incidents_manage` | `OPEN`/`INVESTIGATING` → `ACKNOWLEDGED`.                                                            |
| `POST`   | `/:id/investigate` | `incidents_manage` | → `INVESTIGATING`.                                                                                  |
| `POST`   | `/:id/mitigate`    | `incidents_manage` | → `MITIGATED`.                                                                                      |
| `POST`   | `/:id/resolve`     | `incidents_manage` | → `RESOLVED` (terminal).                                                                            |

Toute transition invalide (ex: tenter de rouvrir un incident `RESOLVED`)
renvoie `400` avec le détail des transitions autorisées depuis l'état
courant.

## Permissions

Deux actions globales (comme `alerts_read`/`events_read`) :

- `incidents_read` : liste, détail, timeline, silences.
- `incidents_manage` : transitions d'incident et gestion des silences
  (création/annulation).

Toutes les actions couvertes par `incidents_manage` sont auditées
(`ACTIONS.INCIDENT_STATE_CHANGE`, `INCIDENT_SILENCE_CREATE`,
`INCIDENT_SILENCE_DELETE` — voir [Audit Log](../../README.md#audit-log)).

## Interface

Onglet **Incidents** (visible avec `incidents_read`) :

- **Liste** filtrable par état, avec badge de sévérité.
- **Détail** : cible, type de problème, date d'ouverture, boutons d'action
  (acquitter/enquêter/atténuer/résoudre — seuls ceux valides depuis l'état
  courant sont proposés) et raccourci vers la création d'un silence
  pré-rempli avec le process de l'incident.
- **Timeline** : liste chronologique fusionnée.
- **Silences** : sous-onglet listant les silences (actifs et annulés),
  formulaire de création (scope, durée ou date, raison), annulation.

## Migration

`016_incidents` (voir `lib/db/migrations/016_incidents.js`) : crée les
quatre tables ci-dessus (dual SQLite/MySQL), aucune donnée existante
touchée. Rollback (`down`) supprime les quatre tables sans affecter
`alerts`, `process_events`, `notification_history` ou
`auto_healing_audit` (elles ne sont que lues, jamais possédées par ce
service).

## Tests

- `test/unit/incidents.test.js` : `incident-store` (CRUD, machine à états,
  agrégation de sévérité), `correlation` (corrélation directe, par groupe,
  hors fenêtre temporelle), `silence-store` (validation, matching par
  scope, expiration, annulation).
- `test/unit/incidents-timeline-multiprocess.test.js` : la timeline
  dérivée (événements PM2, Auto-Healing) couvre bien tous les process
  rattachés à l'incident via une corrélation par groupe, pas seulement le
  process de sa toute première alerte, et sans doublon.
- `test/unit/notifications-silencing.test.js` : intégration du silencing
  dans `RoutingEngine#dispatch` (aucun envoi si silencé, historique
  `silenced`, repli sûr si `silenceStore` lève une exception).
- `test/integration/incidents-api.test.js` : API REST complète (permissions,
  transitions valides/invalides, silences).

## Limites connues

- La corrélation par **groupe** ne considère que les incidents déjà ouverts
  sur la **même métrique** ; deux problèmes de nature différente sur des
  process du même groupe (ex: CPU haut sur l'un, restart_count élevé sur
  l'autre) ouvrent deux incidents distincts, même s'ils sont
  opérationnellement liés — comportement voulu, cohérent avec le critère
  "même type de problème" imposé à la corrélation déterministe (voir
  [Corrélation](#corrélation)).
- Un incident ne se résout **jamais automatiquement** : même si toutes ses
  alertes liées repassent à `resolved`, l'incident reste dans son état
  courant jusqu'à une action explicite (`POST /:id/resolve`) — évite de
  clôturer prématurément un incident encore en cours d'investigation
  humaine alors que l'alerte technique a cessé.
