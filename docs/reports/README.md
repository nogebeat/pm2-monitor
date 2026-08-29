# Reports & Capacity Planning

Phase 20 du projet : un système de rapports construit **au-dessus** des
données déjà collectées ailleurs (process-history, alertes, incidents,
notifications, Auto-Healing, health checks, historique système), sans
introduire un second système de métriques. Un rapport lui-même est calculé
à la volée sur une période demandée (aucune table de "rapports" en base) ;
seule une table technique (`system_metrics_history`, migration
`021_system_metrics_history`) persiste, à basse fréquence (5 min), les
métriques système déjà calculées ailleurs, pour que le Capacity Planning
dispose d'un véritable historique long-terme (voir
[Capacity Planning](#capacity-planning)).

## Sommaire

- [Concepts](#concepts)
- [Architecture](#architecture)
- [Contenu d'un rapport](#contenu-dun-rapport)
- [Process ranking](#process-ranking)
- [Capacity Planning](#capacity-planning)
- [API REST](#api-rest)
- [Export](#export)
- [Permissions](#permissions)
- [Interface](#interface)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Concepts

- **Période** : `daily` (24h glissantes), `weekly` (7j glissants), `monthly`
  (30j glissants) ou `custom` (`start`/`end` explicites, epoch ms ou ISO).
  Les périodes prédéfinies sont volontairement glissantes (se terminent à
  "maintenant"), pas calées sur le calendrier — voir
  `lib/services/reports/periods.js`.
- **Scope** : l'ensemble de process couverts par le rapport, résolu à partir
  des filtres `serverKey` / `environment` / `group` / `process` (les deux
  derniers réutilisent le système de tags/environnements/groupes de la
  Phase 13, `lib/services/process-organization/`) et **toujours** restreint
  à ce que l'utilisateur a le droit de voir (`lib/permissions.js#hasPermission`
  "view" par process, `#hasServerAccess` par serveur) — voir
  `lib/services/reports/scope.js`.
- **Rapport** : un objet JSON composé de `period`, `scope`, `summary`
  (agrégats fleet-wide), `processes` (une ligne par process), `ranking`
  (top-N par critère) et `capacityPlanning` (projections système).

## Architecture

```
lib/services/reports/
  periods.js      — résolution daily/weekly/monthly/custom (pur, testable)
  scope.js        — quels process sont dans le rapport (process-organization + permissions)
  queries.js       — lectures directes (alertes/incidents/notifications/auto-healing sur une période)
  ranking.js      — classement des process les plus problématiques (pur)
  capacity.js     — régression linéaire + projection de seuil (pur)
  aggregator.js   — compose le tout : generateReport()
  export.js       — sérialisation JSON/CSV
  index.js        — point d'entrée public
lib/routes/reports.js — GET /api/reports, /export, /catalog
```

Aucune nouvelle collecte n'est ajoutée : `aggregator.js` lit exclusivement
des services déjà existants :

| Donnée               | Source réutilisée                                                        |
| -------------------- | -------------------------------------------------------------------------- |
| Disponibilité/CPU/RAM/restarts/crashes par process | `lib/services/process-history/analytics.js#computePeriodStats()` (Phase 11) |
| Alertes               | `alerts` (table existante, Phase 3), lues directement (`queries.js`)     |
| Incidents             | `incidents` (table existante, Phase 14), lues directement                |
| Notifications         | `notification_history` (table existante, Phase 6), lues directement      |
| Auto-Healing          | `auto_healing_audit` (table existante, Phase 9), lue directement         |
| Health checks         | `lib/services/health-checks/store.js#list()` — statut **courant** uniquement |
| CPU/RAM/disque système | `lib/services/reports/system-history-store.js` (persistance downsamplée 5 min, migration 021) |

`queries.js` interroge certaines tables directement via `lib/db` plutôt que
par les stores existants (`alert-store.js`, `incident-store.js`...) : ces
stores n'exposent pas la combinaison "plage de temps + filtre process" dont
un rapport a besoin, et cette lecture reste strictement en lecture seule —
même principe que `lib/services/backup/sections.js` (Phase 19), qui lit
plusieurs domaines de la même façon pour construire un export.

## Contenu d'un rapport

`summary` agrège, sur le scope et la période demandés :

- **Disponibilité** (`availabilityPercent`) : moyenne simple des
  disponibilités par process.
- **Crashes / Restarts** : somme sur le scope.
- **CPU / RAM** : moyenne simple des moyennes par process.
- **Incidents** : nombre d'incidents ouverts dans la période, dont la cible
  est dans le scope.
- **Alertes** : total + répartition par sévérité (`critical`/`warning`/`info`).
- **Health checks** : répartition **courante** UP/DOWN/DEGRADED/UNKNOWN des
  checks liés à un process du scope (`currentSnapshot: true` — voir
  [Limites connues](#limites-connues)).
- **Notifications** : total envoyées/échouées, rattachées au scope via
  l'alerte qui les a déclenchées.
- **Auto-Healing** : total de tentatives + répartition succès/échec/bloqué.

`processes` liste, pour chaque process du scope : disponibilité, crashes,
restarts, CPU/RAM moyens, temps d'indisponibilité estimé
(`downtimeMs = période × (1 - disponibilité)`), et nombre d'alertes.

## Process ranking

`ranking` classe les process du scope (top 10 par défaut, `rankingLimit`
dans la requête) selon 6 critères indépendants : `crashes`, `restarts`,
`cpu`, `ram`, `downtime`, `alertCount`. Logique pure dans
`lib/services/reports/ranking.js`, testée en isolation.

## Capacity Planning

Projections **système** (CPU/RAM/disque) basées sur une régression linéaire
simple (moindres carrés) sur la série de points disponible — méthode
volontairement explicable plutôt qu'un modèle "boîte noire"
(`lib/services/reports/capacity.js`). Une projection contient toujours :

- `currentValue`, `slope`/`slopePerDay`, `r2` (qualité de l'ajustement),
  `sampleCount` ;
- `projectedAt`/`daysUntilThreshold` : date/délai avant d'atteindre le seuil
  (80% par défaut), ou `null` si non applicable ;
- `confidence` : `insufficient_data` | `stable_or_decreasing` |
  `beyond_horizon` | `already_exceeded` | `low` | `medium` | `high` — **une
  projection n'est jamais présentée comme une certitude**, l'UI doit
  toujours afficher cette qualification à côté de la date projetée.

Exemple de lecture : *"Projection : dépassement de 80% dans environ 67
jours (confiance moyenne, R²=0.62, 18 points)."*

### Historique système utilisé

`lib/history-store.js#HistoryStore` (métriques système temps réel affichées
dans l'onglet Système) ne conserve que les dernières 24h **en mémoire** —
insuffisant pour une tendance fiable sur un rapport `weekly`/`monthly`.
`lib/services/reports/system-history-store.js` persiste donc, dans la table
`system_metrics_history` (migration `021_system_metrics_history`), un point
CPU/RAM/disque toutes les 5 minutes (~288 lignes/jour) — **la même valeur**
déjà calculée à chaque tick par `lib/system-stats.js` (voir
`lib/polling.js`, juste après `historyStore.push()`), donc **aucune
seconde collecte** : uniquement une rétention plus longue (400 jours par
défaut, purge quotidienne automatique) de ce qui est déjà mesuré. Le
Capacity Planning d'un rapport regarde au moins les 14 derniers jours (et
davantage si la période demandée est plus longue), avec la même
qualification de confiance que ci-dessus — sur une installation neuve
(moins de quelques points persistés), `confidence` retombe naturellement
sur `insufficient_data`.

## API REST

Toutes les routes nécessitent la permission `reports_read`.

| Méthode | Route                | Description                                                  |
| ------- | --------------------- | -------------------------------------------------------------- |
| GET     | `/api/reports`        | Génère un rapport (voir paramètres ci-dessous), réponse JSON. |
| GET     | `/api/reports/export` | Même génération, réponse en pièce jointe (`format=json\|csv`). |
| GET     | `/api/reports/catalog` | `{ periods, formats, rankingCriteria }` — pour peupler l'UI.  |

Paramètres de requête (communs à `/` et `/export`) :

- `period` (`daily` \| `weekly` \| `monthly` \| `custom`, défaut `daily`)
- `start` / `end` (epoch ms ou ISO, requis seulement si `period=custom`)
- `serverKey`, `environment`, `group`, `process` (filtres de scope, tous optionnels)
- `rankingLimit` (nombre de process par critère de classement, défaut 10)
- `format` (`/export` uniquement, `json` \| `csv`, défaut `json`)

Un `period`/`format` invalide, ou un `custom` sans `start` valide, renvoie
`400 { error }`.

## Export

- **JSON** : le rapport complet, sans transformation.
- **CSV** : une ligne par process (`process, server, availability_percent,
  crashes, restarts, cpu_avg_percent, memory_avg_bytes, downtime_ms,
  alert_count`) — les sections `summary`/`ranking`/`capacityPlanning`
  restent disponibles via le format JSON, plus adapté à leur forme imbriquée.
- **PDF** : non ajouté (voir prompt de phase : uniquement si une solution
  propre existe déjà, ou si la dépendance est raisonnable). Ce projet n'a
  aucune dépendance de génération PDF existante ; en ajouter une seulement
  pour un export déjà couvert par JSON/CSV n'était pas justifié.

## Permissions

Une seule permission globale, `reports_read`, pour la consultation **et**
l'export : un rapport n'est qu'une vue dérivée de données déjà lisibles
ailleurs, et chaque source qu'il agrège reste filtrée par la visibilité
habituelle de l'utilisateur (voir [Concepts](#concepts)) — contrairement à
`backup_export` (Phase 19), qui peut inclure des secrets chiffrés et
justifie une permission séparée. `reports_read` est incluse dans le rôle
prédéfini `auditor` (lecture seule transverse orientée supervision).

## Interface

Onglet **Reports** (visible si `reports_read`), `frontend/src/components/ReportsView.vue` :
filtres période/serveur/environnement/groupe/process, cartes de résumé,
classement des process (par critère, onglets), section Capacity Planning
(avec la mise en garde "tendance, pas une certitude"), tableau détaillé par
process, et deux boutons d'export (JSON/CSV) qui ouvrent directement
`/api/reports/export?...` dans un nouvel onglet — même principe que l'export
du Log Explorer (Phase 12).

## Tests

- `test/unit/reports-periods.test.js` — résolution des périodes.
- `test/unit/reports-capacity.test.js` — régression linéaire, projections
  (tendance croissante/stable/déjà dépassée, données insuffisantes, horizon
  trop lointain).
- `test/unit/reports-ranking.test.js` — classement par critère, limite,
  exclusion des valeurs manquantes.
- `test/unit/reports-export.test.js` — sérialisation JSON/CSV, échappement CSV.
- `test/unit/reports-aggregator.test.js` — scope (filtres serveur/process/
  environnement/groupe/visibilité), requêtes période (alertes/incidents/
  notifications/auto-healing, y compris hors période et hors scope),
  agrégation complète, **gros volume** (30 process × 20 échantillons),
  Capacity Planning système à partir de `system-history-store`.
- `test/unit/reports-system-history-store.test.js` — throttle d'écriture
  (`PERSIST_INTERVAL_MS`), requête par plage, purge par rétention.
- `test/integration/reports-api.test.js` — permissions (403 sans
  `reports_read`), filtres via HTTP, erreurs 400 (période/format invalides),
  export CSV/JSON, `/catalog`.

## Limites connues

- **Health checks** : aucune table d'historique de résultats n'existe pour
  ce domaine (seul le statut courant + compteurs consécutifs sont
  persistés, voir `health_checks`). `summary.healthChecks` reflète donc un
  **instantané courant**, pas une répartition sur la période demandée
  (`currentSnapshot: true` dans la réponse). Corriger cela nécessiterait sa
  propre table d'historique et sa propre phase — hors périmètre ici.
- **Crashes multi-serveurs** : comme documenté dans
  `docs/process-history/README.md`, `lib/services/events/` n'a pas encore
  de notion de serveur — un crash "flaky" sur un serveur distant et un
  crash "flaky" local au même nom de process se mélangeraient. Hérité de
  `process-history/analytics.js#computePeriodStats()`, pas introduit ici.
