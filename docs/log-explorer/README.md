# Log Explorer (Phase 12)

Recherche **globale** dans les logs : plusieurs process, plusieurs serveurs
(voir [Multi-server / Remote PM2](../multi-server/README.md), Phase 10) à la
fois, avec contexte, pagination, export et suivi en direct.

Cette page décrit uniquement ce que la Phase 12 **ajoute**. La recherche par
process (`/api/processes/:id/logs/search`), la recherche plein texte, le
filtre par niveau, la plage temporelle, l'export et le tail existaient déjà
avant cette phase (`lib/log-store.js`, `lib/routes/logs.js`) et ne sont pas
recréés ici — voir la section [Logs](../../README.md#logs) du README
principal pour ces fonctionnalités par-process.

## Sommaire

- [Pourquoi un routeur séparé](#pourquoi-un-routeur-séparé)
- [API REST](#api-rest)
- [Permissions](#permissions)
- [Sécurité](#sécurité)
- [Persistance des logs distants](#persistance-des-logs-distants)
- [Frontend](#frontend)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Pourquoi un routeur séparé

`lib/routes/logs.js` résout `:id` via `pm2.describe()` — toujours **une
seule instance locale** de process. Le Log Explorer résout un **ensemble**
de `(serveur, nom de process)` fournis explicitement par le client, sans
jamais appeler `pm2` : `lib/routes/log-explorer.js` est donc un routeur
distinct, monté sur `/api/logs`, plutôt qu'un ajout dans `logs.js`. Même
découpage que `lib/routes/servers.js` (routes `/:key/processes/...`
séparées de `processes.js`).

Il ne recrée aucune primitive de recherche : `lib/log-store.js` reste la
seule implémentation du filtrage texte/regex/niveau/plage/tri, étendue avec
une nouvelle méthode, `searchMulti()`, réutilisée à la fois par la recherche
paginée et par l'export (mode streaming) — voir
[Sécurité](#sécurité) ci-dessous pour le détail des garde-fous, communs aux
deux.

## API REST

### `GET /api/logs/search`

| Paramètre    | Description                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `process`    | **Requis.** Noms de process exacts, séparés par des virgules (max 15).                                                                  |
| `server`     | Optionnel. `server_key` séparés par des virgules (max 15). Par défaut : tous les serveurs enregistrés (filtrés ensuite par permission). |
| `type`       | `all` (défaut) \| `out` \| `err`                                                                                                        |
| `level`      | `all` (défaut) \| `info` \| `warn` \| `error` \| `debug`                                                                                |
| `q`          | Texte ou motif regex.                                                                                                                   |
| `regex`      | `1` pour traiter `q` comme une regex (sinon recherche texte insensible à la casse).                                                     |
| `from`, `to` | Bornes temporelles en ms epoch.                                                                                                         |
| `sort`       | `desc` (défaut, plus récent d'abord) \| `asc`                                                                                           |
| `context`    | Lignes de contexte avant/après chaque résultat (0-20).                                                                                  |
| `limit`      | Taille de page (défaut 100, max 500).                                                                                                   |
| `offset`     | Défaut 0, max 50000.                                                                                                                    |

Réponse :

```json
{
  "results": [
    {
      "t": 1735000000000,
      "type": "err",
      "level": "error",
      "text": "Error: connection refused",
      "line": 42,
      "source": { "serverKey": "local", "name": "api" },
      "before": [{ "t": 1734999999000, "type": "out", "level": "info", "text": "…" }],
      "after": [{ "t": 1735000001000, "type": "out", "level": "info", "text": "…" }]
    }
  ],
  "total": 1,
  "truncated": false,
  "scanned": 128,
  "limit": 100,
  "offset": 0
}
```

`before`/`after` ne sont présents que si `context > 0`. `truncated: true`
signale qu'une des bornes de sécurité a été atteinte (voir
[Sécurité](#sécurité)) — le total affiché reste correct (compté), mais tous
les résultats n'ont pas pu être conservés pour le tri/la pagination.

### `GET /api/logs/export`

Mêmes paramètres que `/search` (sans `limit`/`offset`/`context`). Réponse
`text/plain` streamée, une ligne par correspondance
(`<horodatage ISO> [<serveur>/<process>] [<flux>/<niveau>] <texte>`), avec
`Content-Disposition: attachment`. Bornée à 20 000 lignes (au-delà :
message de troncature ajouté en fin de fichier, jamais d'erreur).

## Permissions

Chaque paire `(serveur, process)` demandée est revalidée **individuellement** :

- `permissions.hasPermission(user, processName, "logs")` — même action
  `logs` que `lib/routes/logs.js`, pas une nouvelle permission.
- `permissions.hasServerAccess(user, serverKey)` — scoping optionnel par
  serveur (Phase 10), orthogonal au point précédent.

Un process/serveur non autorisé est **filtré silencieusement** de la
recherche, jamais un `403` sur l'ensemble de la requête — même logique que
`lib/process-helpers.js#visibleProcesses` ailleurs dans l'app : un
utilisateur sans aucun accès obtient une réponse `200` avec un résultat
vide. Le frontend n'envoie jamais de nom qu'il n'a pas déjà vu passer par un
canal permission-filtré (voir [Frontend](#frontend)), mais le serveur ne
fait jamais confiance à cette liste : c'est lui qui tranche, toujours.

## Sécurité

- **Anti-ReDoS** : une regex de plus de 200 caractères, ou correspondant à
  l'heuristique "groupe déjà quantifié en interne, suivi d'un second
  quantifieur" (`(a+)+`, `(a*)+`, `(\d+)*`…) est refusée **avant** toute
  évaluation. Ce n'est pas une preuve formelle de sécurité (Node n'a pas de
  moteur regex à budget borné sans dépendance externe), donc combinée à une
  troncature de la cible testée (4000 caractères max par ligne) — la
  complexité d'un backtracking catastrophique croît avec la longueur de
  l'entrée, pas seulement celle du motif.
- **Aucune requête non bornée** : au-delà de 300 000 lignes scannées (toutes
  sources confondues), la recherche s'arrête et signale `truncated: true` —
  indépendamment de la sélectivité des filtres. Au-delà de 5000
  correspondances accumulées, le tri/la pagination s'arrêtent de conserver
  de nouveaux résultats (le comptage `total` reste exact). L'export est
  streamé ligne par ligne (jamais accumulé en mémoire) et plafonné à 20 000
  lignes.
- **Nombre de sources borné** : max 15 process × 15 serveurs par requête.

Ces bornes sont des constantes en tête de `lib/log-store.js`
(`MAX_REGEX_LENGTH`, `DEFAULT_MAX_SCAN_LINES`, `DEFAULT_MAX_CANDIDATES`) et
`lib/routes/log-explorer.js` (`MAX_PROCESSES`, `MAX_SERVERS`, `MAX_LIMIT`,
`MAX_EXPORT_MATCHES`) — à ajuster si besoin, pas des valeurs magiques
dispersées.

## Persistance des logs distants

Avant cette phase, un log reçu d'un agent distant (Phase 10) n'était que
**diffusé en direct** (`io.emit("log", …)`, voir `server.js#onLog`), jamais
écrit sur disque — donc jamais consultable après coup ni cherchable,
contrairement aux logs de l'hôte local (`lib/realtime/pm2-bus.js`, alimenté
depuis toujours). Cette phase corrige ce point : `onLog` appelle désormais
aussi `logStore.appendPacket(..., serverKey)`.

Nommage de fichier : l'hôte local garde **exactement** le nommage
historique (`proc-<pm_id>-<nomSlug>.jsonl`) — zéro migration, zéro risque
sur les logs déjà écrits. Un serveur distant utilise un espace de nommage
séparé (`proc-remote-<serverKeySlug>-<pm_id>-<nomSlug>.jsonl`), qui ne peut
jamais collisionner avec un fichier local existant. Aucune migration de
base de données n'est nécessaire : les logs sont des fichiers, pas des
lignes en base (voir `data/logs/`).

## Frontend

Le picker process/serveur de l'onglet Log Explorer se construit à partir de
ce que le client sait déjà en direct plutôt que d'ajouter un endpoint de
découverte :

- **Local** : `state.processes`, alimenté par le socket `"processes"`
  (`lib/realtime/process-socket.js`), déjà filtré côté serveur par
  `visibleProcesses()`.
- **Distant** : `state.servers.items[].processes`, alimenté par le socket
  `"server.snapshot"` (Phase 10), disponible une fois `loadServers()`
  appelé.

Pourquoi pas un `GET /api/logs/sources` qui liste les process depuis le
disque ? Un nom de process n'est stocké sur disque que **slugifié**
(`lib/log-store.js#slug`) — le nom d'origine exact n'est jamais reconstruit
une fois le fichier écrit, donc deux noms différents pourraient se
slugifier identiquement. Le frontend, lui, connaît déjà les noms exacts
(voir ci-dessus) : c'est cette liste qui est envoyée en paramètre `process`,
revalidée malgré tout côté serveur (voir [Permissions](#permissions)).

Le direct (`state.logExplorer.live`) réutilise le même événement socket
`"log"` que le panneau de logs classique (`LogsPanel.vue`) — pas de nouveau
canal temps réel. Une ligne reçue n'est reprise dans l'Explorer que si son
process apparaît dans une liste déjà filtrée par permission côté serveur
(`state.processes` / `state.servers.items[].processes`), même garde-fou que
le panneau de logs classique applique déjà implicitement.

## Tests

- `test/unit/log-store.test.js` : rétrocompatibilité du nommage local,
  `searchMulti()` (multi-process, multi-instance cluster, filtres, tri,
  pagination, contexte, regex invalide/catastrophique, bornes de sécurité,
  mode streaming).
- `test/integration/log-explorer-api.test.js` : permissions (process filtré
  silencieusement, scoping serveur), multi-serveur, regex invalide/
  catastrophique (`400`, jamais évaluée), volume, contexte, export
  (en-têtes, contenu, erreur avant envoi des en-têtes).

## Limites connues

- Un log émis par un agent distant **avant** le déploiement de cette phase
  n'a jamais été persisté — il n'y a rien à retrouver pour cette période,
  contrairement aux logs de l'hôte local (persistés depuis toujours).
- La découverte du picker process/serveur dépend de l'état temps réel déjà
  connu du client (voir [Frontend](#frontend)) : un process qui n'a jamais
  été vu en direct depuis l'ouverture de la page (serveur hors ligne depuis
  le chargement, par exemple) n'apparaît pas dans le picker — ses logs
  restent cependant cherchables si son nom exact est connu par ailleurs
  (l'API ne dépend, elle, d'aucune découverte).
- Le niveau (`info`/`warn`/`error`/`debug`) reste l'heuristique déjà en
  place dans `lib/log-store.js#classifyLevel` (mots-clés dans le texte),
  pas une extraction structurée — même limite que documentée dans le
  [README principal](../../README.md#limites-connues).
