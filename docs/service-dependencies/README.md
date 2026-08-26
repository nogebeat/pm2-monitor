# Carte de dépendances de service (Service Dependency Map)

Phase 17 du projet : une carte de dépendances **explicite**, déclarée par
l'utilisateur (`API -> PostgreSQL`, `Worker -> Redis`, ...), optionnellement
enrichie par les Health Checks existants
([`docs/health-checks/README.md`](../health-checks/README.md)) pour dériver
un statut par dépendance/service et calculer les services **potentiellement
affectés** quand l'un d'eux tombe.

**PM2 Monitor n'invente jamais une dépendance.** Rien n'est déduit
automatiquement du trafic réseau, des process PM2 ou d'une quelconque
heuristique — seul ce que l'utilisateur déclare existe dans le graphe.

## Sommaire

- [Architecture](#architecture)
- [Modèle de données](#modèle-de-données)
- [Statut dérivé](#statut-dérivé)
- [Détection de cycle](#détection-de-cycle)
- [Impact ("dépendances affectées")](#impact-dépendances-affectées)
- [API REST](#api-rest)
- [Permissions](#permissions)
- [Interface](#interface)
- [Migration](#migration)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Architecture

```
lib/services/service-dependencies/
├── store.js           # CRUD + validation de la table service_dependencies
├── graph.js            # fonctions pures : detectCycle(), computeImpact() (reachability)
├── process-status.js    # dérive le statut PROCESS depuis pm2.list() (local), mapping pur + I/O séparés
├── status.js             # dérive le statut (health checks liés > process PM2) + buildGraphSnapshot() + computeImpact()
└── index.js               # point d'entrée partagé (routeur REST + hook server.js)

lib/routes/service-dependencies.js               # routeur Express (/api/service-dependencies/…)
lib/db/migrations/019_service_dependencies.js     # table service_dependencies
frontend/src/components/ServiceDependenciesView.vue  # vue graphe/liste/statut/détail
```

Aucun nouveau poller : le statut d'une dépendance est recalculé **en
lecture** à partir de `health_checks.status` (déjà maintenu par le moteur de
health checks, [`lib/services/health-checks/`](../../lib/services/health-checks/)).
`server.js` réagit simplement au même événement `healthCheckEngine.onCheckResult`
que le Dashboard global (Phase 8), sans dupliquer aucune logique de sonde.

## Modèle de données

Une dépendance (`service_dependencies`) :

| Champ             | Description                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `source`          | Nom du service qui dépend d'un autre (ex. `"API"`)                       |
| `target`          | Nom du service dont `source` dépend (ex. `"PostgreSQL"`)                 |
| `type`            | `HTTP` \| `TCP` \| `DATABASE` \| `REDIS` \| `CUSTOM` \| `PROCESS`        |
| `enabled`         | Dépendance active dans le graphe (calcul d'impact) ou seulement déclarée |
| `description`     | Note libre, optionnelle                                                  |
| `health_check_id` | Health check existant lié (optionnel) — dérive le statut de cette arête  |
| `metadata`        | Objet JSON libre, optionnel                                              |

`source`/`target` sont des chaînes libres (pas de FK vers une table
"process" : PM2 Monitor ne stocke pas les process PM2 en base, voir
[`lib/process-helpers.js`](../../lib/process-helpers.js)). Elles peuvent
désigner un process PM2, ou un service externe ("PostgreSQL", "Redis",
un fournisseur tiers...).

La paire `(source, target, type)` est unique — pas de doublon silencieux.

## Statut dérivé

Aucun statut n'est stocké dans `service_dependencies` : il est recalculé à
chaque lecture, dans cet ordre de priorité :

1. Dépendance désactivée (`enabled = false`) → toujours `UNKNOWN`, même si
   le health check lié est `DOWN` (une dépendance désactivée ne doit ni
   afficher d'alarme ni propager d'impact).
2. Un health check lié (`health_check_id`) → **toujours prioritaire**,
   explicitement configuré par l'utilisateur : le statut du health check
   (`UP` / `DOWN` / `DEGRADED`).
3. Type `PROCESS` sans health check lié → le statut réel du process PM2
   **local** portant le nom `target` (`pm2.list()`, voir
   [`lib/services/service-dependencies/process-status.js`](../../lib/services/service-dependencies/process-status.js)) :
   `online` → `UP`, `stopped`/`errored` → `DOWN`, `stopping`/`launching` →
   `DEGRADED`, process introuvable → `UNKNOWN`. `pm2.list()` n'est appelé
   que si au moins une dépendance `PROCESS` sans health check existe — aucun
   coût pour les installations qui n'utilisent pas ce type.
4. Sinon → `UNKNOWN` (dépendance purement déclarative).

Le statut d'un **nœud** (service) est le pire statut parmi toutes les
arêtes (entrantes ou sortantes, actives) qui le touchent.

**Le Global Status du Dashboard (Phase 8) n'est pas modifié par cette
phase.** Une dépendance DOWN peut être affichée comme cause potentielle
dans sa propre vue, mais ne change jamais le calcul existant de
`lib/routes/dashboard.js`.

## Détection de cycle

`lib/services/service-dependencies/graph.js#detectCycle()` est appliqué à
chaque création/modification (`store.js`) : une dépendance qui boucle
(`A -> B -> ... -> A`) est refusée avant écriture, avec un message
explicite du chemin détecté. Fonction pure, testée indépendamment du store
(voir [Tests](#tests)).

## Impact ("dépendances affectées")

Quand un service `X` est `DOWN`, `computeImpact(X)`
([`status.js`](../../lib/services/service-dependencies/status.js)) retourne
la liste des services qui en dépendent, **directement ou transitivement**
(remontée du graphe), en suivant uniquement les dépendances **activées**.
Chaque entrée porte sa distance et le chemin de dépendance jusqu'à `X`.

Ce calcul **n'affirme jamais une causalité certaine** — il liste des
services _potentiellement_ affectés (vocabulaire utilisé partout dans
l'API et l'interface : `potentiallyAffected`), à charge pour la personne
qui investigue de confirmer.

## API REST

Toutes les routes sont sous `/api/service-dependencies` :

| Méthode   | Route              | Permission            | Description                                                                             |
| --------- | ------------------ | --------------------- | --------------------------------------------------------------------------------------- |
| GET       | `/catalog`         | `dependencies_read`   | Types valides (`HTTP`, `TCP`, ...)                                                      |
| GET       | `/graph`           | `dependencies_read`   | Nœuds + arêtes + statut dérivé                                                          |
| GET       | `/impact/:service` | `dependencies_read`   | Services potentiellement affectés si `:service` tombe (`?assumeDown=1` force le calcul) |
| GET       | `/`                | `dependencies_read`   | Liste des dépendances (filtres `source`/`target`/`type`/`enabled`)                      |
| GET       | `/:id`             | `dependencies_read`   | Détail d'une dépendance                                                                 |
| POST      | `/`                | `dependencies_create` | Créer une dépendance                                                                    |
| PUT/PATCH | `/:id`             | `dependencies_update` | Modifier une dépendance                                                                 |
| POST      | `/:id/enable`      | `dependencies_update` | Activer                                                                                 |
| POST      | `/:id/disable`     | `dependencies_update` | Désactiver                                                                              |
| DELETE    | `/:id`             | `dependencies_delete` | Supprimer                                                                               |

## Permissions

Ajoutées à [`lib/permissions.js`](../../lib/permissions.js) : `dependencies_read`,
`dependencies_create`, `dependencies_update`, `dependencies_delete` — action
globale (pas liée à une app PM2 précise), même style que `anomaly_*`.

Chaque création/modification/activation/désactivation/suppression est tracée
dans l'audit log (`ACTIONS.DEPENDENCY_CHANGE`,
[`docs/audit/README.md`](../audit/README.md)).

## Interface

Nouvel onglet "Dépendances" (`frontend/src/components/ServiceDependenciesView.vue`),
trois sous-vues sur les mêmes données :

- **Graphe** : représentation en couches (CSS simple, sans librairie de
  graphe) — les services sans dépendance entrante en première colonne, puis
  leurs dépendants.
- **Liste** : tableau des dépendances déclarées (source/cible/type/statut
  actif), triable/filtrable côté client.
- **Statut** : un service par ligne avec son statut dérivé.

Ces deux dernières constituent la **représentation accessible en dehors du
graphe** demandée par la phase. Cliquer sur un nœud (dans n'importe quelle
sous-vue) charge son détail et la liste des dépendances potentiellement
affectées dans le panneau latéral.

## Migration

[`019_service_dependencies.js`](../../lib/db/migrations/019_service_dependencies.js) —
table `service_dependencies`, FK `health_check_id -> health_checks(id)` en
`ON DELETE SET NULL` (supprimer un health check ne supprime jamais la
dépendance déclarée), contrainte unique `(source, target, type)`.

## Tests

- `test/unit/service-dependencies-graph.test.js` — `detectCycle()`,
  `computeImpact()` (fonctions pures, sans DB).
- `test/unit/service-dependencies-process-status.test.js` —
  `mapPm2StatusToDependencyStatus()` (fonction pure, sans PM2).
- `test/unit/service-dependencies-store.test.js` — CRUD, doublons, cycle,
  lien/suppression d'un health check (`ON DELETE SET NULL`).
- `test/unit/service-dependencies-status.test.js` — statut dérivé,
  agrégation par nœud, `computeImpact()` avec DB réelle, dépendances
  `PROCESS` (`listProcessStatuses` injecté — jamais de vrai `pm2.list()`
  dans les tests).
- `test/unit/service-dependencies-index.test.js` — hook
  `handleHealthCheckResult()` (câblage `server.js`).
- `test/integration/service-dependencies-api.test.js` — API REST bout en
  bout (CRUD, permissions, `/graph`, `/impact/:service`).

## Limites connues

- Le statut d'un service qui n'a **aucune** dépendance liée à un health
  check, et qui n'est pas de type `PROCESS`, reste `UNKNOWN` : la carte
  reste utile même partiellement instrumentée, mais ne peut pas deviner un
  statut non déclaré.
- Le layout du graphe est une simple mise en couches (topologique), pas un
  algorithme de positionnement physique — choix volontaire de la Phase 17
  ("commencer simplement"), pourra être enrichi plus tard si besoin.
- Le type `PROCESS` dérive son statut du process PM2 **local** uniquement
  (`pm2.list()` sur l'instance qui exécute PM2 Monitor) — pas des process
  d'agents distants (Multi-server, Phase 10). Un health check `PROCESS`
  distant reste possible en le liant explicitement à un health check plutôt
  qu'en s'appuyant sur la dérivation automatique.
