# Multi-server / Remote PM2

Phase 10 du projet : permettre à une instance centrale de PM2 Monitor
(le « hub ») de surveiller **plusieurs hôtes** PM2, chacun équipé d'un
**agent** léger, en plus de l'hôte local historique.

```
PM2 Monitor (hub)
    │
    ├── PM2 local (même process, aucune configuration)
    │
    ├── Remote Agent A  (bin/agent.js sur un autre serveur)
    ├── Remote Agent B
    └── Remote Agent C
```

**Rétrocompatibilité totale** : une installation mono-hôte existante
continue de fonctionner sans aucune configuration supplémentaire. Le
serveur local est enregistré automatiquement au démarrage
(`ensureLocalServer()`, voir [Architecture](#architecture)) et reste
la seule source de vérité pour ses propres process — aucun changement de
comportement pour qui n'utilise pas d'agent.

## Sommaire

- [Architecture](#architecture)
- [Communication hub ↔ agent](#communication-hub--agent)
- [Installation d'un agent](#installation-dun-agent)
- [Configuration côté serveur central](#configuration-côté-serveur-central)
- [Permissions](#permissions)
- [Sécurité](#sécurité)
- [Interface](#interface)
- [API REST](#api-rest)
- [Historique & Analytics multi-serveur](#historique--analytics-multi-serveur)
- [Migration](#migration)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Limites connues](#limites-connues)

## Architecture

```
lib/services/servers/
├── store.js        # CRUD du registre de serveurs (table `servers`), tokens
│                      d'agent (bcrypt), ensureLocalServer(), touchStatus(),
│                      markStaleOffline()
├── user-scope.js    # scoping optionnel utilisateur -> serveurs autorisés
│                      (table `user_servers`), orthogonal aux permissions
└── protocol.js      # constantes partagées hub/agent (version de protocole,
                       intervalles heartbeat/timeout, liste blanche d'actions)

lib/realtime/agent-hub.js  # namespace Socket.IO `/agent` : authentification,
                              enregistrement, heartbeat, reconnexion, relais
                              d'actions distantes
lib/routes/servers.js      # API REST /api/servers
bin/agent.js                # script autonome exécuté sur l'hôte distant
frontend/src/components/ServersView.vue  # onglet "Serveurs"
```

Le serveur local (celui qui héberge PM2 Monitor lui-même) est représenté
par une ligne `servers.server_key = "local"`, `kind = "local"` — voir
`lib/services/servers/store.js#ensureLocalServer`. Il n'a pas de token
(pas d'agent : ses données viennent directement de `lib/system-stats.js`
et du PM2 local, dans le même process), et son statut est toujours
`ONLINE` (calculé à la volée, pas dépendant d'un heartbeat).

Un serveur distant (`kind = "agent"`) est créé via `POST /api/servers`,
qui retourne un token en clair **une seule fois**. Cette page est ensuite
utilisée pour configurer `bin/agent.js` sur la machine distante (voir
[Installation d'un agent](#installation-dun-agent)).

`bin/agent.js` est volontairement léger : il n'ouvre **aucune** connexion
base de données et ne démarre **aucun** serveur Express. Il réutilise
`lib/system-stats.js` (snapshot système) et `lib/pm2-actions.js` (actions
PM2), tous deux déjà découplés de la DB/de l'auth HTTP — pas
`lib/process-helpers.js`, dont le `require()` entraînerait `lib/auth.js`
(sessions) et `lib/services/audit` (donc un driver DB) sur un hôte qui n'a
ni besoin ni vocation à parler à la base du serveur central.

## Communication hub ↔ agent

Un namespace Socket.IO dédié, **`/agent`**, distinct du namespace principal
utilisé par le frontend (`lib/realtime/process-socket.js`) : deux
populations de clients différentes — navigateurs authentifiés par cookie de
session vs agents authentifiés par token — avec des règles d'auth propres à
chacune. `/agent` n'hérite pas du middleware de session (`io.use()` dans
`server.js`) puisque c'est un namespace, pas le socket racine.

Événements échangés (voir `lib/realtime/agent-hub.js` et `bin/agent.js`) :

| Événement       | Sens        | Contenu                                                             |
| --------------- | ----------- | ------------------------------------------------------------------- |
| `register`      | agent → hub | identité (hostname/OS/Node/PM2 version), premier snapshot + process |
| `heartbeat`     | agent → hub | snapshot système + liste de process, à intervalle régulier          |
| `process:event` | agent → hub | événement PM2 (start/stop/restart/exit/crash…)                      |
| `log`           | agent → hub | ligne de log stdout/stderr                                          |
| `action`        | hub → agent | action distante (`start`/`stop`/`restart`/`reload`) + ack           |

Le hub réémet ensuite sur le namespace principal, à destination du
frontend, avec un `serverId` explicite (`server.snapshot`, `server.status`,
et les événements `log`/`event` existants enrichis d'un `serverId`) — voir
[WebSocket](#interface) plus bas.

Paramètres du protocole (`lib/services/servers/protocol.js`, partagés par
le hub et l'agent pour éviter toute divergence) :

- `PROTOCOL_VERSION` : version majeure du protocole. Un agent dont la
  version majeure diffère de celle du hub est **refusé à la connexion**.
- `AGENT_HEARTBEAT_INTERVAL_MS` (défaut 10 000 ms)
- `AGENT_HEARTBEAT_TIMEOUT_MS` (défaut 3× l'intervalle) : au-delà, le
  serveur est basculé `OFFLINE` par le balayage périodique
  (`agentHub.startStaleSweep()`).
- `AGENT_STALE_SWEEP_INTERVAL_MS` (défaut 5 000 ms)
- `AGENT_ACTION_ACK_TIMEOUT_MS` (défaut 15 000 ms) : délai d'attente d'un
  accusé de réception avant de considérer une action distante perdue.

Un seul socket actif par `serverKey` à la fois : si un agent se reconnecte
pendant qu'une ancienne connexion existe encore, l'ancienne est fermée —
pas de connexion fantôme comptée comme `ONLINE` après un redémarrage
d'agent. La reconnexion côté agent est automatique (`socket.io-client`,
`reconnection: true`, backoff 1 s → 10 s).

## Installation d'un agent

1. Dans PM2 Monitor, onglet **Serveurs** (permission `servers_manage`
   requise), cliquez sur **Enregistrer un serveur**, renseignez un nom, un
   hostname (optionnel) et un environnement. Le token d'agent s'affiche
   **une seule fois** : copiez-le immédiatement.
2. Sur la machine distante, dans une copie du dépôt PM2 Monitor (ou juste
   `bin/agent.js` + ses dépendances `pm2`/`socket.io-client`), lancez :

   ```bash
   PM2_MONITOR_HUB_URL=https://monitor.example.com \
   PM2_MONITOR_SERVER_KEY=srv_xxxxxxxx \
   PM2_MONITOR_AGENT_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx \
   node bin/agent.js
   ```

   ou via le script npm fourni : `npm run agent` (mêmes variables d'env).

3. Variables reconnues par l'agent :

   | Variable                                                                                     | Requis | Description                                                         |
   | -------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
   | `PM2_MONITOR_HUB_URL`                                                                        | oui    | URL du serveur central                                              |
   | `PM2_MONITOR_SERVER_KEY`                                                                     | oui    | identifiant du serveur, fourni à l'enregistrement                   |
   | `PM2_MONITOR_AGENT_TOKEN`                                                                    | oui    | token d'agent, fourni une fois à l'enregistrement/régénération      |
   | `PM2_MONITOR_AGENT_NAME`                                                                     | non    | nom affiché dans les logs de l'agent (défaut : hostname)            |
   | `AGENT_HEARTBEAT_INTERVAL_MS` / `AGENT_HEARTBEAT_TIMEOUT_MS` / `AGENT_ACTION_ACK_TIMEOUT_MS` | non    | doivent être identiques côté hub et côté agent (voir `protocol.js`) |

4. Idéalement, faites tourner l'agent lui-même sous PM2 sur la machine
   distante (`pm2 start bin/agent.js --name pm2-monitor-agent`), pour
   bénéficier du redémarrage automatique en cas de crash.

5. Une fois connecté, le serveur passe `PENDING` → `ONLINE` dans l'onglet
   **Serveurs**, avec ses métriques CPU/RAM/disque/température et sa liste
   de process en direct.

Si le token est compromis (ou perdu), utilisez **Régénérer le token**
dans l'interface : l'ancien devient invalide immédiatement et la
connexion en cours est coupée.

## Configuration côté serveur central

Rien n'est requis pour le fonctionnement mono-hôte existant. Variables
optionnelles :

- `PM2_MONITOR_LOCAL_SERVER_NAME` : nom affiché pour le serveur local
  (défaut : `"Serveur local"`).
- `AGENT_HEARTBEAT_INTERVAL_MS`, `AGENT_HEARTBEAT_TIMEOUT_MS`,
  `AGENT_STALE_SWEEP_INTERVAL_MS`, `AGENT_ACTION_ACK_TIMEOUT_MS` : voir
  [Communication](#communication-hub--agent) — à garder synchronisées avec
  la configuration des agents.

## Permissions

Deux actions globales, ajoutées au catalogue existant
(`lib/permissions.js`) :

- `servers_read` : voir la liste des serveurs, leur statut, leurs
  métriques.
- `servers_manage` : enregistrer/modifier/activer-désactiver/supprimer un
  serveur, régénérer son token d'agent.

Les actions PM2 sur un process distant (`start`/`stop`/`restart`/`reload`
via `/api/servers/:key/action`) réutilisent les permissions **par
app/action** existantes (`hasPermission(user, processName, action)`) —
aucun système de permissions dédié aux actions distantes.

**Scoping serveur** (optionnel) : un administrateur peut restreindre un
utilisateur à un sous-ensemble de serveurs, dans la modale
**Utilisateurs & permissions** (section « Portée serveurs »). C'est un
filtre **orthogonal** aux permissions app/action ci-dessus — table
`user_servers`, gérée par `lib/services/servers/user-scope.js` — et non un
second système RBAC :

- Aucune ligne pour un utilisateur = pas de restriction (il voit tous les
  serveurs que ses permissions habituelles autorisent).
- Dès qu'au moins un serveur est explicitement listé, l'utilisateur est
  restreint à ce sous-ensemble (`lib/permissions.js#hasServerAccess`).

## Sécurité

- Le token d'agent n'est **jamais** stocké en clair (hash bcrypt, comme les
  mots de passe utilisateurs) et n'est retourné en clair par l'API qu'à
  la création et à la régénération — jamais par `GET /api/servers`.
- L'agent **ne fait confiance à aucune commande arbitraire** : la liste des
  actions distantes autorisées (`start`/`stop`/`restart`/`reload`) est une
  liste blanche définie dans `lib/services/servers/protocol.js`, appliquée
  **des deux côtés** (hub et agent) — défense en profondeur : même si le hub
  était compromis, l'agent refuse toute action hors de cette liste, et
  n'exécute jamais de commande shell arbitraire.
- Un serveur désactivé est déconnecté immédiatement (pas seulement au
  prochain heartbeat manqué).
- Toute action sensible (enregistrement, modification, activation/
  désactivation, suppression, régénération de token, action distante) est
  tracée dans l'audit log existant (`lib/services/audit/`, voir
  [`docs/audit/README.md`](../audit/README.md)) — aucun second système
  d'audit.
- Les actions distantes respectent les permissions par app/action
  existantes, en plus du scoping serveur ci-dessus.

## Interface

Nouvel onglet **Serveurs** (`frontend/src/components/ServersView.vue`),
visible avec la permission `servers_read` :

- liste des serveurs (local + agents), avec statut (En ligne / Hors ligne
  / En attente), environnement, hostname, nombre de process, dernière
  connexion ;
- métriques CPU/RAM/disque/température en direct pour les serveurs
  connectés (reçues via l'événement socket `server.snapshot`) ;
- gestion (permission `servers_manage`) : enregistrement, modification,
  activation/désactivation, régénération de token, suppression ;
- accès au serveur : liste dépliable des process distants, avec actions
  start/stop/restart/reload (soumises aux permissions par app/action), et un
  bouton "Metrics" par process ouvrant un panneau Analytics (moyenne/pic
  CPU/mémoire, restarts, crashes, disponibilité, comparaison à la période
  précédente — voir [Historique multi-serveur](#historique--analytics-multi-serveur)
  ci-dessous et `docs/process-history/README.md`).

Le temps réel réutilise le Socket.IO existant (`frontend/src/socket.js`) —
pas de second système de polling dédié :

- `server.snapshot` : `{ serverId, snapshot, processes }`, à chaque
  heartbeat d'un agent.
- `server.status` : `{ serverId, status }`, à la connexion/déconnexion
  d'un agent ou au balayage périodique des serveurs hors ligne.

Les données temps réel (logs, événements process) reçues d'un agent sont
associées à un `serverId` explicite pour éviter toute collision entre
deux process de même nom sur deux serveurs différents.

## API REST

Monté sur `/api/servers` (`lib/routes/servers.js`) :

| Méthode | Route                                | Permission                    | Description                                                 |
| ------- | ------------------------------------ | ----------------------------- | ----------------------------------------------------------- |
| GET     | `/api/servers`                       | `servers_read`                | liste des serveurs visibles par l'utilisateur               |
| GET     | `/api/servers/:key/status`           | `servers_read` + scope        | statut détaillé d'un serveur                                |
| POST    | `/api/servers`                       | `servers_manage`              | enregistre un nouveau serveur, retourne `{ server, token }` |
| PUT     | `/api/servers/:key`                  | `servers_manage`              | modifie nom/hostname/environnement                          |
| POST    | `/api/servers/:key/enable`           | `servers_manage`              | active un serveur                                           |
| POST    | `/api/servers/:key/disable`          | `servers_manage`              | désactive un serveur (coupe la connexion en cours)          |
| DELETE  | `/api/servers/:key`                  | `servers_manage`              | supprime un serveur (impossible pour `local`)               |
| POST    | `/api/servers/:key/regenerate-token` | `servers_manage`              | régénère le token (invalide l'ancien)                       |
| POST    | `/api/servers/:key/action`           | scope + permission app/action | relaie une action PM2 vers l'agent                          |
| GET     | `/api/servers/:key/processes/:processName/metrics`   | scope + permission `view` sur l'app | historique du process (voir Historique multi-serveur) |
| GET     | `/api/servers/:key/processes/:processName/analytics` | scope + permission `view` sur l'app | stats de période + comparaison (idem)                |

## Historique & Analytics multi-serveur

**Correctif** (postérieur à la mise en place initiale de la Phase 10) :
avant lui, `lib/services/process-history/` (historique par process,
graphique "Metrics" + panneau "Analytics") ne fonctionnait **que pour
l'hôte local du hub**. Deux causes cumulées :

1. `attachAgentHub()` (`onSnapshot`) recevait bien les heartbeats des
   agents (process + snapshot système) mais ne les transmettait jamais à
   `ProcessHistoryService#record()` — seul `lib/polling.js` (hôte local)
   le faisait. Aucune donnée n'était donc jamais collectée pour un agent.
2. `process_metrics_raw`/`process_metrics_rollup` (créées en Phase 4,
   avant ce Phase 10) n'avaient aucune notion de serveur : même en
   branchant la collecte, deux serveurs avec un process de même nom
   (fréquent — "api", "worker"…) auraient fusionné leur historique dans
   les mêmes lignes.

Résolu par la migration `014_process_metrics_server_key.js` (colonne
`server_key` sur les deux tables, `"local"` par défaut) et le branchement
de `onSnapshot` sur `processHistory.record(processes, now, serverKey)`
dans `server.js`. Détails complets, y compris les limites restantes
(crashes non scopés par serveur) : `docs/process-history/README.md`.

## Migration

`lib/db/migrations/012_servers.js` — deux tables, SQLite et MySQL,
création idempotente (`IF NOT EXISTS`) :

- `servers` : registre des serveurs (voir colonnes dans le fichier de
  migration).
- `user_servers` : scoping utilisateur → serveurs.

`lib/db/migrations/014_process_metrics_server_key.js` — ajoute `server_key`
à `process_metrics_raw`/`process_metrics_rollup` (voir
[Historique & Analytics multi-serveur](#historique--analytics-multi-serveur)) ;
reconstruit `process_metrics_rollup` sous SQLite (contrainte UNIQUE à
modifier, non supportée en `ALTER TABLE` par les versions embarquées
courantes) sans perte des lignes existantes (testé, voir
`test/unit/migration-014-server-key.test.js`).

```bash
npm run migrate:status
npm run migrate:up
```

## Tests

- `test/unit/servers-store.test.js` : CRUD, tokens, `ensureLocalServer`,
  `touchStatus`, `markStaleOffline`.
- `test/unit/permissions-server-scope.test.js` : `hasServerAccess`,
  `visibleServers`.
- `test/integration/servers-api.test.js` : enregistrement, authentification,
  mise à jour, activation/désactivation, suppression, régénération de
  token, permissions, isolation entre serveurs.
- `test/unit/migration-014-server-key.test.js` : préservation des données
  existantes lors de la reconstruction de `process_metrics_rollup`, non-
  collision entre deux serveurs partageant un nom de process.

```bash
npm test
```

## Troubleshooting

- **L'agent reste en `PENDING`** : vérifiez que `PM2_MONITOR_HUB_URL` est
  joignable depuis la machine distante et que le serveur n'est pas
  désactivé (`enabled = 0`) — un agent désactivé est refusé à la
  connexion.
- **`Version de protocole incompatible`** : l'agent et le hub tournent sur
  des versions majeures différentes de PM2 Monitor. Mettez à jour l'agent
  (ou le hub) pour aligner `PROTOCOL_VERSION`.
- **`Identifiants agent invalides, ou serveur désactivé/inconnu`** : le
  token a été régénéré depuis (auquel cas reconfigurez l'agent avec le
  nouveau), ou le `serverKey` ne correspond à aucun serveur enregistré.
- **Un serveur reste `ONLINE` après une coupure réseau brutale** : le
  balayage périodique (`AGENT_STALE_SWEEP_INTERVAL_MS`) le basculera
  `OFFLINE` une fois `AGENT_HEARTBEAT_TIMEOUT_MS` dépassé sans heartbeat —
  ce n'est pas instantané par design (laisse une marge à un simple
  ralentissement réseau).
- **Action distante en échec avec `Délai dépassé…`** : l'agent est
  injoignable ou bloqué ; l'action est tout de même tracée dans l'audit
  log avec `status: "failed"`.

## Limites connues

- La vue "Process" principale (sidebar + panneau de logs) reste centrée
  sur l'hôte local ; les process distants se consultent et se pilotent
  depuis l'onglet **Serveurs** (liste dépliable par serveur), pas encore
  intégrés à la sidebar/au panneau de logs principal.
- Les logs relayés par un agent (`socket.on("log", …)` dans
  `server.js`) portent un `serverId`, mais l'affichage détaillé
  (streaming ligne à ligne dans un panneau dédié, à la manière du
  panneau de logs local) n'est pas encore implémenté côté frontend —
  seuls les métriques/statuts/process sont actuellement affichés par
  serveur.
- **Crashes non scopés par serveur** : `lib/services/events/`
  (`process_events`) n'a pas de colonne `server_key`, contrairement à
  `process_metrics_raw`/`rollup` depuis la migration 014. Le compteur
  "crashes" du panneau Analytics d'un process distant peut donc inclure
  des crashes d'un process local (ou d'un autre serveur) portant le même
  nom. Non corrigé par ce correctif — nécessiterait sa propre migration
  sur `process_events`.
