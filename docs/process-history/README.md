# Historique par process & Analytics (Phase 11)

Historique CPU/mémoire/restarts/disponibilité par process, en trois
résolutions (raw / medium / long), consultable via l'onglet "Metrics" d'une
carte process (graphique) et son panneau "Analytics" (stats de période +
comparaison à la période précédente).

```
lib/services/process-history/
├── config.js       # resolveConfig(env) : rétentions, intervalles, maxPoints…
├── store.js         # persistance process_metrics_raw / process_metrics_rollup
├── aggregator.js     # fonctions pures : computeStats, aggregateSamples, aggregateRollupBuckets
├── rollup.js          # raw -> medium -> long (compaction périodique)
├── analytics.js        # Phase 11 : stats de période + comparaison (computePeriodStats, computeAnalytics)
└── index.js              # ProcessHistoryService : record(), query(), analytics(), start()/stop()

lib/routes/processes.js   # GET /api/processes/:id/metrics et /:id/analytics
lib/process-helpers.js    # fmtProcess() : normalisation d'un process PM2, dont readAxmMetrics() (Phase 11)
lib/db/migrations/004_process_metrics.js             # tables raw/rollup
lib/db/migrations/013_process_metrics_analytics.js    # colonnes heap/event-loop-lag/online_count (Phase 11)
frontend/src/components/ProcessCard.vue               # UI (graphique + panneau Analytics)
```

## Multi-résolution

Un échantillon est inséré à chaque tick `pm2.list()` (voir `lib/polling.js`)
dans `process_metrics_raw`. `rollup.js` compacte ensuite périodiquement :
raw → `medium` (bucket configurable, par défaut horaire) → `long` (bucket
journalier), avec purge des raw/medium trop anciens. `ProcessHistoryService`
choisit la résolution automatiquement selon l'étendue de la plage demandée
(`pickResolution()`), ou accepte une résolution explicite.

## Métriques

Toujours disponibles (via `p.monit`, PM2 les fournit pour tout process) :

- **cpu** (%), **memory** — RSS du process en octets (c'est la même colonne
  `memory` historique : PM2 ne fournit pas de mesure heap séparée par
  défaut, voir plus bas), **instances**, **restarts** (compteur cumulé PM2 →
  delta calculé côté agrégation), **uptime**, **status**.

Best-effort (Phase 11), jamais inventées :

- **heap used / heap total** (octets), **event loop lag** (ms) : PM2
  n'expose ces métriques (`pm2_env.axm_monitor`) que pour les process Node.js
  instrumentés côté application (`@pm2/io`/pmx) — pas pour un process
  quelconque (script Python, binaire, Node sans probe…). `readAxmMetrics()`
  (`lib/process-helpers.js`) les lit quand elles sont présentes et retourne
  `null` sinon ; rien n'est calculé ou approximé quand la donnée n'existe
  pas. Quand `heap total` n'est pas directement rapporté mais que `heap
  used` et `% heap usage` le sont, il est dérivé (`heapUsed / (usage/100)`)
  à partir de deux valeurs réellement fournies par PM2 — jamais une valeur
  inventée de zéro.
- Le frontend masque simplement les cartes heap/event-loop-lag du panneau
  Analytics quand elles sont `null` sur toute la période (`hasHeapData` /
  `hasEventLoopData` dans `ProcessCard.vue`).

Dérivées à la lecture (aucun stockage dédié) :

- **restart frequency** (restarts/heure) = delta de restarts sur la période
  ÷ durée en heures.
- **disponibilité (%)** = échantillons `status === "online"` ÷ total des
  échantillons de la période. Stockée en agrégat (`online_count` sur
  `process_metrics_rollup`, migration 013) pour rester calculable sur des
  plages longues (7j/30j) où seuls les rollups existent (les rollups ne
  gardent pas le `status` brut, seulement ce compteur).
- **crashes** : ne vient pas de `process_metrics_raw` (échantillons
  périodiques, pas de notion de transition) mais de
  `lib/services/events/event-store.js` (Phase 4, `type: "crashed"`) —
  `analytics.js` interroge cette table plutôt que de dupliquer une détection
  de crash déjà faite ailleurs (voir `docs/events/README.md`).

## Analytics (`GET /api/processes/:id/analytics`)

Même permission que `/metrics` (`view`, lecture seule). Paramètres :
`start`, `end` (ms epoch, défaut : dernière heure), `resolution` (`raw` |
`medium` | `long`, défaut : auto selon la plage), `compare` (`0`/`false`
pour désactiver la comparaison, activée par défaut).

Réponse :

```jsonc
{
  "processName": "api",
  "resolution": "raw",
  "start": 1732000000000,
  "end": 1732003600000,
  "current": {
    "cpu": { "avg": 12.4, "min": 2, "max": 38, "p95": 30 },
    "memory": { "avg": 104857600, "min": 90000000, "max": 130000000, "p95": 125000000 },
    "heapUsed": { "avg": null, "min": null, "max": null, "p95": null }, // process non instrumenté
    "heapTotal": { "avg": null, "min": null, "max": null, "p95": null },
    "eventLoopLag": { "avg": null, "min": null, "max": null, "p95": null },
    "instancesAvg": 2,
    "restarts": 1,
    "restartFrequencyPerHour": 1,
    "crashes": 0,
    "availabilityPercent": 99.2,
    "sampleCount": 240
  },
  "previous": { /* même forme, période précédente de même durée */ },
  "previousStart": 1731996400000,
  "previousEnd": 1732000000000,
  "deltas": { "cpuAvgPct": 8.3, "memoryAvgPct": -2.1, "restartsPct": null, "crashesPct": 0, "availabilityPct": 0.4 }
}
```

`deltas.*Pct` est `null` quand la comparaison n'a pas de sens (valeur
précédente absente, ou division par zéro évitée — voir
`analytics.js#pctChange`), jamais un `Infinity`/`NaN`.

## UI

Le panneau "Metrics" d'une carte process (`ProcessCard.vue`) affiche, sous
le graphique Chart.js existant, une grille de statistiques (CPU/mémoire
moy./pic, restarts + fréquence, crashes, disponibilité, heap/event-loop-lag
si disponibles) avec un delta vs la période précédente, pour la même plage
que le sélecteur 1h/6h/24h/7j/30j déjà présent.

## Problèmes connus / limites

- Comme `/metrics` (voir commentaire dans
  `test/integration/process-history-api.test.js`), `/analytics` n'est testée
  qu'au niveau service (`ProcessHistoryService#analytics()` contre une vraie
  DB, voir `test/integration/process-history-analytics.test.js`) : `server.js`
  ne permet pas de monter la route HTTP isolément dans ce projet.
- Heap/event-loop-lag dépendent entièrement de l'instrumentation de l'app
  monitorée : sur la grande majorité des déploiements PM2 self-hosted
  (scripts non-Node, apps Node sans `@pm2/io`), ces deux cartes restent
  vides — c'est le comportement attendu, pas un bug.
