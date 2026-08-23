# Tags, Environments & Process Groups

Phase 13 du projet : une organisation logique des process **entièrement
gérée par PM2 Monitor**, indépendante de la configuration PM2 elle-même.
Tagger un process, lui assigner un environnement ou l'ajouter à un groupe
ne modifie jamais son `ecosystem.config.js` ni aucun réglage PM2 — c'est un
système de méta-données propre au monitor, au même titre que les Health
Checks ou l'Audit Log.

## Sommaire

- [Concepts](#concepts)
- [Architecture](#architecture)
- [Modèle de données](#modèle-de-données)
- [API REST](#api-rest)
- [Permissions](#permissions)
- [Interface](#interface)
- [Intégration avec l'Alert Engine et les notifications](#intégration-avec-lalert-engine-et-les-notifications)
- [Migration](#migration)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Concepts

- **Tag** : étiquette libre (`production`, `backend`, `payments`,
  `critical`, `worker`…). Un process peut porter plusieurs tags.
- **Environnement** : `production` / `staging` / `development` (créés par
  défaut au premier démarrage) ou tout environnement personnalisé
  (`qa`, `canary`…). Contrairement aux tags, **un process appartient à un
  seul environnement à la fois** (assigner un nouvel environnement remplace
  le précédent).
- **Groupe** : regroupement logique de process (`E-commerce` contenant
  `frontend`, `api`, `worker`, `cron`…). Un process peut appartenir à
  plusieurs groupes si c'est cohérent avec son rôle.

Ces trois catalogues sont indépendants les uns des autres et gérés par
CRUD (voir [API REST](#api-rest)) ; un process peut n'avoir aucune, une ou
plusieurs associations dans chacun.

## Architecture

```
lib/services/process-organization/
├── store.js   # CRUD des catalogues (tags/environnements/groupes) +
│                lecture/écriture des associations process <-> catalogue
└── index.js   # ré-exporte store.js (point d'entrée du service)

lib/routes/process-organization.js         # routeur Express (/api/process-organization/…)
lib/db/migrations/015_process_organization.js  # tables (voir Modèle de données)
frontend/src/components/modals/OrganizationModal.vue  # UI (Settings → Organisation)
frontend/src/components/ProcessSidebar.vue             # filtres + vue groupe
```

Le store ne fait aucun appel `pm2.*` : il ne connaît des process que leur
nom (`processName`) et, pour le multi-serveur, la clé du serveur qui les
héberge (`serverKey`, voir [Multi-server](../multi-server/README.md)). Un
process n'a pas besoin d'exister/tourner pour recevoir une association —
utile pour préparer l'organisation d'un déploiement avant son premier
démarrage.

## Modèle de données

Six tables (migration `015_process_organization`), structure relationnelle
plutôt qu'un blob JSON dans une colonne, pour rester filtrable/cherchable
en SQL :

| Table                   | Rôle                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tags`                  | Catalogue de tags (`name` unique, `color` optionnelle pour l'UI).                                                                                                                                                                                                                                       |
| `environments`          | Catalogue d'environnements (`name` unique, `color` optionnelle). Seedé avec `production`/`staging`/`development` au premier démarrage (`store.js#ensureDefaults`, appelé depuis `server.js` comme `serversStore.ensureLocalServer`) ; l'utilisateur reste libre d'en créer/renommer/supprimer d'autres. |
| `process_groups`        | Catalogue de groupes (`name` unique, `description` optionnelle).                                                                                                                                                                                                                                        |
| `process_tags`          | Association N-N process ↔ tag (`server_key`, `process_name`, `tag_id`).                                                                                                                                                                                                                                 |
| `process_environment`   | Association 1-N process → environnement (`server_key`, `process_name`, `environment_id`) — une seule ligne par process.                                                                                                                                                                                 |
| `process_group_members` | Association N-N process ↔ groupe (`server_key`, `process_name`, `group_id`).                                                                                                                                                                                                                            |

Un process est identifié par `(server_key, process_name)`, la même
convention que `process_metrics_raw`/`rollup` (migration 014) et
`health_checks.process_name` (migration 010) : nécessaire pour ne pas
fusionner deux process de même nom sur deux serveurs différents. Toutes
les associations utilisent `ON DELETE CASCADE` côté catalogue : supprimer
un tag/environnement/groupe retire ses associations, jamais le process
lui-même.

## API REST

Toutes les routes sous `/api/process-organization` (voir
`lib/routes/process-organization.js`) :

| Méthode  | Route                                  | Description                                                                                                                                                                                                                                    |
| -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/tags`                                | Liste les tags.                                                                                                                                                                                                                                |
| `POST`   | `/tags`                                | Crée un tag (`{ name, color? }`).                                                                                                                                                                                                              |
| `PUT`    | `/tags/:id`                            | Modifie un tag.                                                                                                                                                                                                                                |
| `DELETE` | `/tags/:id`                            | Supprime un tag (retire ses associations).                                                                                                                                                                                                     |
| `GET`    | `/environments`                        | Liste les environnements.                                                                                                                                                                                                                      |
| `POST`   | `/environments`                        | Crée un environnement (`{ name, color? }`).                                                                                                                                                                                                    |
| `PUT`    | `/environments/:id`                    | Modifie un environnement.                                                                                                                                                                                                                      |
| `DELETE` | `/environments/:id`                    | Supprime un environnement.                                                                                                                                                                                                                     |
| `GET`    | `/groups`                              | Liste les groupes.                                                                                                                                                                                                                             |
| `POST`   | `/groups`                              | Crée un groupe (`{ name, description? }`).                                                                                                                                                                                                     |
| `PUT`    | `/groups/:id`                          | Modifie un groupe.                                                                                                                                                                                                                             |
| `DELETE` | `/groups/:id`                          | Supprime un groupe.                                                                                                                                                                                                                            |
| `GET`    | `/assignments`                         | Organisation de **tous** les process ayant au moins une association (un seul aller-retour pour construire les filtres/la vue groupe côté UI).                                                                                                  |
| `GET`    | `/assignments/:processName?serverKey=` | Organisation d'un process précis (`{ tags: string[], environment: string\|null, groups: string[] }`). `serverKey` par défaut `"local"`.                                                                                                        |
| `PUT`    | `/assignments/:processName`            | Applique tags + environnement + groupes en un seul appel (`{ serverKey?, tagIds?: number[], environmentId?: number\|null, groups?: number[] }`). Chaque champ fourni **remplace** l'ensemble existant (ex: `tagIds: []` retire tous les tags). |
| `DELETE` | `/assignments/:processName?serverKey=` | Retire toutes les associations d'un process.                                                                                                                                                                                                   |

## Permissions

Deux actions globales (comme `servers_read`/`servers_manage`), voir
`lib/permissions.js` :

- `process_org_read` : lecture du catalogue et des assignations (y compris
  les filtres/la vue groupe côté UI).
- `process_org_manage` : CRUD du catalogue et assignation à un process.

## Interface

Settings → **🏷 Organisation** (visible si `process_org_read`) ouvre une
modale à quatre onglets :

- **Tags** / **Environnements** / **Groupes** : liste + petit formulaire de
  création/édition (visible si `process_org_manage`).
- **Assignation** : recherche un process par son nom (autocomplétion sur
  les process de l'hôte local) et coche ses tags/son environnement/ses
  groupes en un seul enregistrement.

La colonne de gauche (liste des process) gagne deux filtres (par tag, par
environnement) et une case **Vue groupe**, qui réorganise la liste par
groupe (un process apparaît sous chacun de ses groupes ; les process sans
groupe sont rassemblés sous « Sans groupe »).

## Intégration avec l'Alert Engine et les notifications

Le routing des notifications (`lib/services/notifications/routing/`,
Phase 5D) prévoyait déjà des conditions `tag` dans son modèle, mais
celles-ci ne pouvaient matcher aucune alerte tant qu'aucune source de tag
n'existait — la Phase 13 comble ce vide :

- `RoutingEngine` (voir `routing/engine.js`) reçoit optionnellement un
  `processOrgStore` (`lib/services/process-organization/store.js`, injecté
  depuis `lib/services/notifications/index.js`).
- Pour chaque alerte ciblant un process (`alert.targetType === "process"`),
  `_resolveProcessOrg()` résout une fois son organisation
  (`getOrganizationForProcess`), réutilisée pour évaluer toutes les routes
  du dispatch.
- Une route dont `conditions.tag`/`conditions.environment`/`conditions.group`
  est non vide matche si le process de l'alerte porte l'un des tags listés
  (resp. l'environnement listé, l'un des groupes listés) — voir
  `routeMatches()`. Une alerte "system" (pas de process) ne matche jamais
  ces trois filtres. Les anciennes règles sans ces conditions ne sont pas
  affectées.

Voir aussi [`docs/notifications/README.md`](../notifications/README.md)
pour le modèle complet de `conditions`.

## Migration

`lib/db/migrations/015_process_organization.js` — voir
[Modèle de données](#modèle-de-données). Réversible (`down()` supprime les
six tables). Au premier démarrage après la migration,
`processOrgStore.ensureDefaults()` (appelé depuis `server.js`, idempotent)
crée les environnements `production`/`staging`/`development` s'ils
n'existent pas déjà.

## Tests

- `test/unit/process-organization-store.test.js` — CRUD des trois
  catalogues, associations (remplacement complet, isolation multi-serveur,
  cascade de suppression), `ensureDefaults()`.
- `test/unit/notifications-routing.test.js` — matching `tag`/`environment`/
  `group` dans `routeMatches()` (avec et sans `processOrgStore`), résolution
  au niveau `dispatch()` (y compris résilience si `processOrgStore` lève une
  exception).
- `test/integration/process-organization-api.test.js` — permissions, CRUD
  REST complet, flux d'assignation de bout en bout.
- `test/unit/migrator.test.js` / `test/integration/migrate-cli.test.js` —
  mis à jour pour la nouvelle migration 015 (comptage, `down({ steps })`).

## Limites connues

- L'Alert Engine reste mono-hôte (voir `lib/services/alerts/engine.js`) :
  une alerte ne porte pas de `serverKey`, seulement un nom de process. La
  résolution tag/environnement/groupe pour le routing des notifications
  utilise donc `serverKey = "local"` par défaut — comportement correct pour
  une installation mono-hôte (le cas normal) et cohérent avec la limitation
  déjà documentée du filtre `conditions.server`. Une alerte provenant d'un
  agent distant portant le même nom de process qu'un process local
  n'hérite pas automatiquement de l'organisation de ce dernier.
- Un process appartient à **un seul** environnement à la fois (assigner un
  nouvel environnement remplace le précédent), conformément à l'énoncé de
  la Phase 13.
