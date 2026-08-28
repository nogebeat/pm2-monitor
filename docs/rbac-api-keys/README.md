# RBAC avancé & Clés API (Phase 18)

Cette phase étend le système d'authentification/permissions existant
(`lib/permissions.js`, `lib/auth.js`, `lib/user-store.js`) — elle
n'introduit **aucun second système RBAC**. Deux ajouts, tous les deux
purement additifs :

1. **Rôles prédéfinis** (Admin/Operator/Viewer/Auditor) : un gabarit pratique
   pour remplir les permissions existantes en un clic, rien de plus.
2. **Clés API** pour les intégrations machine-to-machine (M2M), avec un
   ensemble restreint et explicite de scopes.

## Sommaire

- [Rôles prédéfinis](#rôles-prédéfinis)
- [Clés API](#clés-api)
- [Scopes](#scopes)
- [Enforcement des scopes sur les routes existantes](#enforcement-des-scopes-sur-les-routes-existantes)
- [Audit](#audit)
- [API REST](#api-rest)
- [CLI](#cli)
- [Migration](#migration)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Rôles prédéfinis

`lib/permissions.js#ROLES` définit quatre rôles :

| Rôle       | Ce qu'il donne                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`    | `is_admin = 1` (accès complet, comme avant cette phase).                                                                                                                                                                                                          |
| `operator` | Toutes les actions process sauf `delete`, sur toutes les apps (`*`), plus l'acquittement d'alertes, la gestion des health checks/incidents.                                                                                                                       |
| `viewer`   | Lecture seule des process (`view`/`logs` sur `*`).                                                                                                                                                                                                                |
| `auditor`  | Lecture transverse orientée conformité : audit, événements, alertes, incidents, health checks, notifications, serveurs, dépendances — volontairement **sans** `view`/`logs` (un auditeur consulte l'état des sous-systèmes, pas le contenu des logs applicatifs). |

Appliquer un rôle (**via l'API ou le CLI**) ne fait qu'écrire des lignes
concrètes dans la table `permissions` (+ `is_admin` le cas échéant) — exactement
ce qu'un administrateur ferait à la main. `users.role` est une étiquette
**purement informative**, jamais lue par `hasPermission()` : elle sert
seulement à afficher "quel rôle a été appliqué en dernier" côté UI/CLI. Éditer
les permissions d'un utilisateur à la main après lui avoir appliqué un rôle ne
casse rien ; l'étiquette peut simplement devenir obsolète (visuel uniquement).

## Clés API

Une clé API (`lib/services/api-keys/`) est un objet indépendant d'un
utilisateur, pour une intégration M2M précise (superviser des métriques,
relayer des alertes…). Elle porte :

| Champ                    | Description                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`             | Identifiant et nom donné par l'utilisateur.                                                                                             |
| `scopes`                 | Sous-ensemble de la liste ci-dessous.                                                                                                   |
| `resourceScopes`         | Optionnel — restreint la clé par serveur/environnement/groupe/process, voir [Scopes de ressource](#scopes-de-ressource-resourcescopes). |
| `createdAt`, `expiresAt` | `expiresAt` optionnel — une clé sans expiration reste valide indéfiniment (jusqu'à révocation).                                         |
| `lastUsedAt`             | Mis à jour à chaque vérification réussie.                                                                                               |
| `revokedAt`              | Une clé révoquée n'est **jamais supprimée** (trace d'audit conservée).                                                                  |

Le secret en clair (`pmk_<48 hex>`, 192 bits d'aléatoire) **n'est renvoyé
qu'à la création**, jamais réaffiché ensuite. Il n'est jamais stocké en
clair : seul `SHA-256(secret)` est en base, comparé en temps constant à la
vérification. Voir `lib/services/api-keys/store.js` pour le raisonnement
détaillé sur ce choix (vs. bcrypt pour les mots de passe humains).

Une clé s'utilise via l'en-tête HTTP :

```
Authorization: Bearer pmk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Scopes

| Scope                | Donne accès à                                                            |
| -------------------- | ------------------------------------------------------------------------ |
| `metrics:read`       | Métriques système (CPU/RAM/disque).                                      |
| `processes:read`     | Liste des process et leur statut.                                        |
| `processes:restart`  | **Sensible** — redémarrer un process (seule action de mutation exposée). |
| `logs:read`          | Lecture/recherche des logs d'un process.                                 |
| `alerts:read`        | Règles d'alerte + alertes actives/historique.                            |
| `alerts:write`       | **Sensible** — acquitter une alerte active.                              |
| `notifications:test` | **Sensible** — déclencher une notification de test.                      |
| `servers:read`       | Registre de serveurs (Multi-server) et leur statut.                      |

Ce catalogue est volontairement **court et explicite** — une clé API n'a
jamais accès à une action qui n'y figure pas, même si elle porte tous les
scopes existants (`manage_users`, `stop`, `delete`… restent hors de portée
d'une clé API dans cette phase). Voir
`lib/permissions.js#ACTION_TO_API_KEY_SCOPE` pour le mapping exact vers les
actions internes, et `apiKeyCanPerform()` pour la vérification elle-même.

### Scopes de ressource (`resourceScopes`)

En plus des scopes ci-dessus, une clé peut être restreinte à un sous-ensemble
de ressources — toutes les listes contiennent des **noms** (jamais
d'identifiants numériques), et une liste absente/vide = pas de restriction
sur ce critère :

| Champ                         | Restreint à                                                        | Vérifié par                                                                        |
| ----------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `resourceScopes.processes`    | Une liste d'apps précises.                                         | `lib/permissions.js#apiKeyCanPerform` (pur, synchrone).                            |
| `resourceScopes.servers`      | Une liste de `serverKey` (Multi-server).                           | `lib/permissions.js#apiKeyHasServerAccess`, via `lib/auth.js#requireServerAccess`. |
| `resourceScopes.environments` | Une liste de noms d'environnement (voir Organisation des process). | `lib/services/api-keys/resource-scope.js#processResourceScopeAllows` (lookup DB).  |
| `resourceScopes.groups`       | Une liste de noms de groupe.                                       | Idem.                                                                              |

Plusieurs critères combinés sont tous requis (ET logique) : une clé avec
`environments: ["production"]` **et** `groups: ["backend"]` ne peut agir que
sur un process qui appartient aux deux à la fois.

## Enforcement des scopes sur les routes existantes

Aucune route existante n'a été dupliquée : `lib/auth.js#requirePermission` et
`lib/process-helpers.js#withAppPermission` (les deux points de passage déjà
utilisés par toutes les routes protégées) vérifient désormais, en plus du
chemin session existant (inchangé), un chemin clé API basé sur
`apiKeyCanPerform()`. Une requête ne peut jamais combiner les deux : soit une
session valide (`req.user`), soit une clé API valide (`req.apiKeyAuth`),
jamais un mélange des deux droits.

## Audit

Nouveaux types d'événements (`lib/services/audit/index.js#ACTIONS`) :

- `api_key.create` / `api_key.update` / `api_key.revoke` — gestion d'une clé (toujours auditée, comme les autres actions de gestion du projet).
- `api_key.sensitive_use` — **utilisation** d'un scope marqué sensible (`alerts:write`, `notifications:test`), tracée à chaque appel réussi, pas seulement en cas de refus.

La clé elle-même (secret ou hash) n'est **jamais** écrite dans une entrée
d'audit.

## API REST

Toutes ces routes sont réservées aux utilisateurs avec **session**
(`api_keys_read`/`api_keys_manage`) — une clé API ne peut jamais gérer les
clés API elles-mêmes.

| Méthode | Route                      | Permission                                                        |
| ------- | -------------------------- | ----------------------------------------------------------------- |
| GET     | `/api/api-keys`            | `api_keys_read` — liste (jamais le secret).                       |
| GET     | `/api/api-keys/scopes`     | `api_keys_read` — catalogue des scopes.                           |
| POST    | `/api/api-keys`            | `api_keys_manage` — crée une clé, renvoie `{ apiKey, secret }`.   |
| PATCH   | `/api/api-keys/:id`        | `api_keys_manage` — modifie nom/scopes/resourceScopes/expiration. |
| POST    | `/api/api-keys/:id/revoke` | `api_keys_manage` — révoque (jamais de suppression).              |

Rôles : `GET /api/users/roles/catalog` (admin) liste les rôles prédéfinis ;
`POST`/`PUT /api/users(/:id)` acceptent désormais un champ `role` optionnel.

## CLI

```bash
node bin/manage-users.js role <username> <admin|operator|viewer|auditor>
```

## Migration

`020_rbac_api_keys` (réversible) ajoute :

- `users.role` (colonne texte nullable, informative).
- La table `api_keys` (voir ci-dessus), avec index sur `key_hash`.

`created_by` n'a volontairement **aucune contrainte de clé étrangère** —
même convention que `audit_log.user_id` : une clé doit rester
listable/auditable même si son créateur est ensuite supprimé.

## Tests

- `test/unit/rbac-roles-scopes.test.js` — rôles prédéfinis, catalogue de
  scopes (dont `processes:restart`/`servers:read`),
  `hasScope()`/`apiKeyCanPerform()`/`apiKeyHasServerAccess()`.
- `test/unit/api-keys-store.test.js` — génération/hash/expiration/révocation
  du store, secret jamais réexposé.
- `test/unit/api-keys-resource-scope.test.js` — `resourceScopes.environments`
  / `.groups`, critères combinés (ET logique).
- `test/integration/api-keys-api.test.js` — CRUD des clés via l'API REST,
  permissions.
- `test/integration/api-keys-security.test.js` — enforcement de scope
  bout-en-bout via le vrai enchaînement de middlewares (clé invalide,
  expirée, révoquée, scope insuffisant/suffisant, scope de ressource
  process, action jamais exposée à une clé API, audit d'usage sensible,
  absence du secret dans toute réponse d'erreur, non-régression du chemin
  session existant).
- `test/integration/api-keys-servers-scope.test.js` — scope `servers:read`
  et `resourceScopes.servers` sur `GET /api/servers` et
  `GET /api/servers/:key/status`.

## Limites connues

- Une clé API ne peut effectuer qu'**une seule** action de mutation sur les
  process : `restart` (scope `processes:restart`, sensible, auditée à
  chaque usage réussi). `stop`/`reload`/`scale`/`delete`… restent hors de
  portée, quels que soient les scopes détenus — extension possible dans une
  phase ultérieure en ajoutant une entrée à
  `lib/permissions.js#ACTION_TO_API_KEY_SCOPE`.
- Les routes protégées uniquement par `requireAuth` sans passer par
  `requirePermission`/`withAppPermission` (aucune identifiée comme sensible
  à ce jour) ne sont pas concernées par cette phase : une clé API valide y
  passerait le contrôle d'authentification mais `req.user` y resterait
  `undefined`, ce qui revient en pratique à un résultat vide plutôt qu'à une
  fuite de données (voir par ex. `visibleAppNames`/`visibleProcesses`, qui
  renvoient `[]` sans utilisateur) — `GET /api/processes` et
  `GET /api/servers` ont néanmoins reçu un traitement explicite (voir
  `lib/routes/processes.js`/`lib/routes/servers.js`) car c'étaient les seuls
  cas identifiés où ce comportement par défaut aurait autrement empêché
  `processes:read`/`servers:read` de fonctionner du tout.
- Pas d'écran dédié dans l'interface web pour gérer les clés API : la
  gestion se fait via l'API REST (`/api/api-keys`) ou le CLI
  (`node bin/manage-users.js role …` pour les rôles). Une UI pourra être
  ajoutée dans une phase ultérieure sans changement de schéma.
