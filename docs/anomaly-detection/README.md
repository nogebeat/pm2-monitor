# Détection d'anomalies

Phase 16 du projet : une détection **statistique locale**, basée sur
l'historique déjà collecté par le monitor — **aucune API IA externe**.
L'objectif est de repérer un comportement inhabituel (CPU/mémoire anormale,
restart inhabituel, crash inhabituel, taux d'événements inhabituel) _avant_
qu'un seuil fixe classique (`alert_rules`) ne soit franchi, en s'appuyant
sur ce qui est "normal" pour **cette** app/cette machine plutôt que sur une
valeur absolue choisie a priori.

Une anomalie alimente le moteur d'alertes existant
([`docs/alerts/README.md`](../alerts/README.md)) comme un nouveau type de
signal — **il n'existe pas de deuxième moteur d'alertes** : exactement le
même principe que les Health Checks
([`docs/health-checks/README.md`](../health-checks/README.md)).

## Sommaire

- [Architecture](#architecture)
- [Méthode](#méthode)
- [Métriques surveillées](#métriques-surveillées)
- [Configuration d'une règle](#configuration-dune-règle)
- [Intégration avec l'Alert Engine](#intégration-avec-lalert-engine)
  - [Escalade de sévérité](#escalade-de-sévérité)
  - [Filet de sécurité pour CPU/mémoire process](#filet-de-sécurité-pour-cpumémoire-process)
- [Historique des détections (explications)](#historique-des-détections-explications)
- [API REST](#api-rest)
- [Permissions](#permissions)
- [Interface](#interface)
- [Configuration (.env)](#configuration-env)
- [Migration](#migration)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Architecture

```
lib/services/anomaly-detection/
├── config.js            # constantes, valeurs par défaut, catalogue de métriques
├── math.js               # moyenne, écart-type, z-score, confiance (fonctions pures)
├── detector.js            # detectAnomaly()/explainDetection() : décision + explication (pure)
├── readers.js             # value+history par cible, réutilise les stores déjà existants
├── rules-store.js          # CRUD + validation de la table anomaly_rules
├── detections-store.js      # persistance de la table anomaly_detections (historique/explications)
├── service.js              # AnomalyDetectionService : orchestre readers -> detector -> AlertEngine
└── index.js                 # singleton partagé (routeur REST + lib/polling.js)

lib/routes/anomaly-detection.js               # routeur Express (/api/anomaly-detection/…)
lib/db/migrations/018_anomaly_detection.js    # tables anomaly_rules + anomaly_detections
```

Aucune nouvelle collecte de données : `readers.js` lit exclusivement des
historiques déjà alimentés ailleurs —

- CPU/mémoire/disque système → `lib/history-store.js` (déjà collecté par
  `lib/polling.js`, en mémoire, 24h glissantes).
- CPU/mémoire process → `lib/services/process-history/` (DB, déjà collecté
  par le même poller process).
- Taux de restart/crash/événements → `lib/services/events/` (timeline déjà
  normalisée par `lib/services/events/normalizer.js`).

## Méthode

Volontairement simple et explicable — **pas de modèle ML** :

1. **Baseline** : moyenne mobile + écart-type calculés sur l'historique
   disponible dans la fenêtre configurée (`windowMs`).
2. **Z-score** : `(valeur observée - moyenne) / écart-type`. Une valeur est
   jugée anormale quand `|z-score| >= sensibilité`.
3. **Comparaison à la période précédente** : en complément (affiché dans
   l'explication, pas dans la décision), la variation en % par rapport à la
   fenêtre précédente de même durée est calculée.

**Jamais de déclenchement sur une absence de données** : si l'historique
contient moins de `minSamples` échantillons dans la fenêtre, `detectAnomaly()`
renvoie `null` et `AnomalyDetectionService` n'appelle même pas
`AlertEngine.evaluate()` — ni création, ni résolution accidentelle d'une
anomalie réellement active faute de données momentanée.

## Métriques surveillées

| Cible     | Métriques                                                   |
| --------- | ----------------------------------------------------------- |
| `system`  | `cpu`, `memory`, `disk`                                     |
| `process` | `cpu`, `memory`, `restart_rate`, `crash_rate`, `event_rate` |

`restart_rate`/`crash_rate`/`event_rate` comptent les événements de la
timeline (`lib/services/events/`) par tranches d'1h successives ("buckets") :
la tranche la plus récente est comparée aux tranches précédentes dans la
fenêtre historique — une "comparaison période précédente" au sens du prompt
maître, appliquée par bucket plutôt que par échantillon brut (un restart est
un événement discret, pas une valeur continue).

## Configuration d'une règle

Une ligne `anomaly_rules` = une métrique surveillée sur une cible, avec :

- `enabled` — activation/désactivation.
- `sensitivity` — seuil en écarts-types (défaut `3`, ~99.7% des valeurs
  "normales" d'une distribution à peu près gaussienne restent en-deçà).
- `windowMs` — fenêtre historique utilisée pour la baseline (défaut 24h).
- `minSamples` — échantillons minimum requis dans la fenêtre pour oser
  évaluer (défaut `10`).
- `cooldownSeconds` — anti-flapping, même mécanisme que `alert_rules`
  (défaut 900s).
- `severity` — sévérité de l'alerte produite (`info`/`warning`/`critical`).
- `targetType`/`targetValue` — `"system"`, ou `"process"` + nom d'app
  (`"*"` pour toutes).

## Intégration avec l'Alert Engine

**Aucune modification de `lib/services/alerts/engine.js`.** Pour chaque
règle activée, `AnomalyDetectionService` calcule un z-score puis appelle
`alertEngine.evaluate(rule, target, value)` — **la même méthode** que pour
une règle d'alerte classique — via une "règle virtuelle" construite à la
volée :

```js
{
  id: null,                          // jamais stockée dans alert_rules (contrainte FK)
  metric: `${metric}_anomaly_${ruleId}`, // unique par règle : pas de collision entre 2 règles
  operator: ">",
  threshold: sensitivity,
  value: zscore absolu,
  durationSeconds: 0,
  cooldownSeconds,
  severity,
}
```

L'engine gère alors lui-même tout le cycle de vie
(`trigger → active → resolved`, acquittement, déduplication, cooldown) —
**exactement comme pour cpu/memory/restart_count classiques**. La
transition qui en résulte part vers `dispatchAlertTransition`
(`lib/alert-dispatch.js`) comme n'importe quelle autre alerte :
notifications, websocket dashboard (`alert.triggered`/`alert.resolved`),
auto-healing et corrélation d'incidents fonctionnent donc **sans code
supplémentaire**.

`rule_id` (colonne `alerts.rule_id`) reste toujours `null` pour ces
occurrences : la colonne porte une contrainte de clé étrangère vers
`alert_rules`, une table différente de `anomaly_rules`.

Évalué dans les deux boucles déjà existantes de `lib/polling.js` (système +
process) — **pas de troisième poller**.

### Escalade de sévérité

La sévérité d'une occurrence reste par défaut celle configurée sur la règle
(`severity`), fixée à la création (`trigger`) — comme pour une règle
d'alerte classique. Tant que l'occurrence reste ouverte
(`trigger`/`active`/`acknowledged`), `AnomalyDetectionService` la **réévalue
à chaque tick** et l'**escalade vers `critical`** si le z-score dépasse 2x
la sensibilité configurée — jamais de rétrogradation automatique, pour
éviter le flapping visuel pendant qu'une anomalie reste ouverte. Implémenté
en réutilisant `alertStore.update()` (colonne `severity`, désormais
modifiable après création) : **aucune logique de cycle de vie ajoutée à
`engine.js`**.

### Filet de sécurité pour CPU/mémoire process

Les métriques `cpu`/`memory` d'un process s'appuient d'abord sur
`lib/services/process-history/` (persistant, DB). Si ce service est
désactivé ou n'a pas encore assez d'échantillons (ex: tout juste démarré),
`AnomalyDetectionService` complète avec un historique **en mémoire**
(`ring-buffer.js`), alimenté à chaque tick d'évaluation — jamais un second
système de collecte persistante, juste un filet de sécurité local au
process. Une détection produite à partir de ce filet est marquée
`method: "zscore_fallback"` dans `anomaly_detections`, avec une explication
qui le précise.

## Historique des détections (explications)

Chaque détection anormale (pas chaque tick évalué) est persistée dans
`anomaly_detections`, liée à l'occurrence d'alerte produite
(`alert_id`) : métrique, valeur observée, baseline, écart-type, z-score,
confiance statistique approximative, direction (`above`/`below`), nombre
d'échantillons, et une **explication en langage naturel** générée par
`explainDetection()` — toujours produite pour une détection anormale,
exigence explicite de la tâche ("toujours expliquer pourquoi l'anomalie a
été détectée").

## API REST

Monté sous `/api/anomaly-detection` :

- `GET /rules`, `GET /rules/:id`, `POST /rules`, `PUT`/`PATCH /rules/:id`,
  `DELETE /rules/:id` — CRUD des règles.
- `POST /rules/:id/enable`, `POST /rules/:id/disable`.
- `GET /catalog` — types de cible/métriques valides par type (construction
  du formulaire).
- `GET /detections`, `GET /detections/:id` — historique paginé, filtrable
  par `ruleId`/`alertId`/`targetType`/`targetValue`/`metric`/`startTs`/`endTs`.

## Permissions

| Action           | Description                                    |
| ---------------- | ---------------------------------------------- |
| `anomaly_read`   | Voir les règles et l'historique des détections |
| `anomaly_create` | Créer une règle                                |
| `anomaly_update` | Modifier / activer / désactiver une règle      |
| `anomaly_delete` | Supprimer une règle                            |

Toute modification de règle est auditée (`anomaly.rule_change`, voir
`docs/audit/README.md`).

## Interface

`Settings → 📊 Anomalies` (visible si `anomaly_read`) — deux onglets :

- **Règles** : liste des règles (métrique, cible, sensibilité, fenêtre,
  cooldown, sévérité), création/édition/activation/désactivation/suppression.
- **Historique** : dernières anomalies détectées, avec l'explication
  statistique complète (valeur, baseline, z-score).

`frontend/src/components/modals/AnomalyDetectionModal.vue`, monté via
`ModalHost.vue` (type `anomalyDetection`) — même pattern que
`HealthChecksModal.vue`. Les occurrences d'alerte elles-mêmes (trigger/
active/resolved) ne sont pas gérées ici : elles apparaissent dans le flux
d'activité du Dashboard comme toute autre alerte.

## Configuration (.env)

| Variable                    | Défaut | Description                                                   |
| --------------------------- | ------ | ------------------------------------------------------------- |
| `ANOMALY_DETECTION_ENABLED` | `1`    | Active/désactive l'évaluation (indépendant des règles créées) |

Les règles elles-mêmes (sensibilité/fenêtre/cooldown/métriques) se
configurent via l'API REST ci-dessus, pas par variable d'environnement.

## Migration

`018_anomaly_detection.js` crée `anomaly_rules` et `anomaly_detections`.
`anomaly_detections.alert_id` référence `alerts(id)` (`ON DELETE SET NULL`)
et `anomaly_detections.rule_id` référence `anomaly_rules(id)` (`ON DELETE
SET NULL`) — une détection reste consultable même si la règle est ensuite
supprimée.

## Tests

- `test/unit/anomaly-math.test.js` — fonctions statistiques pures.
- `test/unit/anomaly-detector.test.js` — données normales/anormales/
  insuffisantes/bruit/valeurs manquantes, jamais de déclenchement sans
  assez de données.
- `test/unit/anomaly-ring-buffer.test.js` — filet de sécurité en mémoire :
  élagage par âge/nombre de points, exclusion du point courant.
- `test/unit/anomaly-readers.test.js` — extraction value/history depuis
  `lib/history-store.js`, `process-history` (DB réelle) et `event-store`
  (DB réelle), conversion d'unité mémoire cohérente avec `collector.js`.
- `test/unit/anomaly-service.test.js` — cycle de vie complet via le vrai
  `AlertEngine` (fausses détections en mémoire) : trigger/active/resolved,
  cooldown, dédup entre règles distinctes, jamais de déclenchement sur
  données insuffisantes ou absentes, escalade de sévérité, filet de
  sécurité en mémoire pour cpu/memory process.
- `test/unit/alert-store-severity.test.js` — `severity` reste modifiable
  après création (DB SQLite réelle, round-trip complet).
- `test/integration/anomaly-detection-api.test.js` — routeur réel + DB
  SQLite réelle + permissions (`403`/`400`/`404`/CRUD complet).

## Limites connues

- Les métriques CPU/mémoire/disque système sont limitées à la rétention de
  `lib/history-store.js` (24h glissantes) : une `windowMs` plus longue est
  silencieusement bornée par ce qui est réellement disponible.
- Le filet de sécurité en mémoire (`ring-buffer.js`) qui pallie une
  `process-history` indisponible/insuffisante pour cpu/memory process (voir
  [Intégration avec l'Alert Engine](#intégration-avec-lalert-engine))
  n'est pas persisté : il repart de zéro à chaque redémarrage du serveur,
  et n'est pas partagé entre plusieurs instances. Suffisant comme filet de
  sécurité ponctuel, pas comme substitut permanent à `process-history`
  activé.
