# Docker Monitoring (Phase 22)

Ajoute à PM2 Monitor le monitoring **en lecture seule** des conteneurs
Docker de l'hôte : état, CPU, RAM, réseau, I/O disque, PIDs, métadonnées, et
logs stdout/stderr en temps réel — dans le **même dashboard** que les
process PM2 (onglet **Docker**).

PM2 et Docker restent **deux sources de monitoring distinctes** : Docker
n'est jamais requis, et une panne Docker ne touche ni le monitoring PM2, ni
le WebSocket PM2, ni le backend.

> **Strictement en lecture.** Aucune action `start`, `stop`, `restart`,
> `kill`, `remove`, `exec`… n'est exposée — ni en API, ni en UI, ni en
> WebSocket. Un test automatisé
> (`test/integration/docker-api.test.js`) vérifie qu'aucune route non-GET
> n'existe sur `/api/docker`.

## Prérequis

- Docker installé sur l'hôte **(optionnel)** — s'il est absent, l'onglet
  affiche « Docker indisponible » et tout le reste fonctionne normalement.
- Le processus PM2 Monitor doit pouvoir lire/écrire le socket Docker
  (`/var/run/docker.sock` par défaut) — voir [Accès au socket](#accès-au-socket-docker-et-sécurité).
- **Aucune dépendance npm ajoutée.** Le client Docker est écrit avec le
  module `http` natif de Node (`http.request({ socketPath })`), comme le
  formatteur Prometheus (`lib/services/metrics/format.js`) est écrit à la
  main plutôt que via `prom-client`.

## Accès au socket Docker et sécurité

> ⚠️ **L'accès au socket Docker donne des privilèges très élevés** au
> processus qui y accède. Quiconque peut parler à `/var/run/docker.sock`
> peut, en pratique, créer un conteneur montant `/` de l'hôte en écriture et
> devenir root sur la machine. PM2 Monitor n'utilise **que des appels en
> lecture** (`GET`), mais **le droit d'accès au socket, lui, n'est pas
> limité aux lectures** : si le processus PM2 Monitor est compromis, cet accès
> l'est aussi.

Recommandations :

- N'activez Docker Monitoring que sur les hôtes où vous en avez besoin ;
  `DOCKER_MONITORING_ENABLED=0` garantit que le socket n'est jamais touché.
- Donnez l'accès au **strict nécessaire** : ajouter l'utilisateur qui lance
  PM2 Monitor au groupe `docker` (`sudo usermod -aG docker <user>`, puis
  nouvelle session / redémarrage du process) est équivalent à lui donner
  root. Si ce compromis ne vous convient pas, envisagez un proxy de socket
  en lecture seule (ex : [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy)
  n'autorisant que `CONTAINERS=1`), et pointez `DOCKER_SOCKET_PATH` dessus.
  _PM2 Monitor ne l'installe ni ne le configure pour vous._
- Réservez `docker_read` / `docker_logs` aux comptes de confiance : les
  logs de conteneurs peuvent contenir des secrets.
- PM2 Monitor ne modifie **jamais** automatiquement les permissions du
  système ni son déploiement (`deploy.sh` inchangé).

### Si PM2 Monitor tourne lui-même dans Docker

Le déploiement fourni (`deploy.sh`) installe PM2 Monitor directement sur
l'hôte, sans conteneur — rien à changer dans ce cas. Si vous le conteneurisez
vous-même, montez le socket :

```yaml
services:
  pm2-monitor:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

`:ro` ne rend **pas** le socket lui-même en lecture seule (c'est un socket,
pas un fichier : le droit de s'y connecter suffit à envoyer n'importe quelle
requête) — voir l'avertissement ci-dessus.

## Configuration

| Variable                    | Défaut                 | Rôle                                                            |
| --------------------------- | ---------------------- | --------------------------------------------------------------- |
| `DOCKER_MONITORING_ENABLED` | `1`                    | `0` = fonctionnalité désactivée, le socket n'est jamais touché. |
| `DOCKER_SOCKET_PATH`        | `/var/run/docker.sock` | Chemin du socket Docker.                                        |
| `DOCKER_POLL_INTERVAL_MS`   | `5000`                 | Intervalle du snapshot partagé (minimum imposé : `1000`).       |

## Lancer en local

```bash
npm install
npm start                       # Docker Monitoring activé par défaut
DOCKER_MONITORING_ENABLED=0 npm start   # sans toucher au socket Docker
```

Puis ouvrez l'onglet **Docker**. Pour vérifier l'accès au socket :

```bash
curl --unix-socket /var/run/docker.sock http://localhost/_ping   # => OK
```

## Architecture

```
                    PM2 Monitor
                         │
              ┌──────────┴──────────┐
           PM2 API              Docker API (socket Unix)
              │                     │
   PM2 processes + bus       lib/services/docker/  ── poller PARTAGÉ (5s)
              │                     │
              └──────────┬──────────┘
                      Socket.IO (même serveur `io`)
                         │
                      Vue UI
```

- `lib/services/docker/client.js` — transport HTTP sur socket Unix.
- `lib/services/docker/format.js` — fonctions pures (CPU, mémoire, réseau, I/O).
- `lib/services/docker/log-demux.js` — décodage du flux de logs Docker.
- `lib/services/docker/index.js` — service : poller partagé, cache,
  disponibilité, logs à la demande.
- `lib/routes/docker.js` — API REST, montée sous `/api/docker`.
- `lib/realtime/docker-bus.js` — branchement sur le Socket.IO existant.

### Un seul poller partagé

Une seule boucle (`DOCKER_POLL_INTERVAL_MS`) fait : `ping` → liste des
conteneurs → un appel `stats` **par conteneur en cours d'exécution, en
parallèle**, puis met le résultat en cache. Ce cache alimente **les trois
consommateurs** — WebSocket, REST, Prometheus — sans jamais déclencher un
appel Docker de plus. Le coût est donc indépendant du nombre de clients
connectés et de scrapes Prometheus. Un tick n'en chevauche jamais un autre.

> L'API Docker n'a pas d'endpoint « stats de tous les conteneurs » : un
> appel par conteneur est incompressible. La collecte est regroupée par
> tick, pas par requête.

### Calcul du CPU

Docker ne donne pas un pourcentage mais des compteurs cumulés. Le
pourcentage est calculé entre **deux échantillons successifs du poller**
(même approche que `lib/system-stats.js`), avec la formule de `docker stats` :

```
cpuDelta    = total_usage(t) − total_usage(t−1)
systemDelta = system_cpu_usage(t) − system_cpu_usage(t−1)
CPU %       = (cpuDelta / systemDelta) × nb de CPU × 100
```

- Un conteneur observé pour la première fois affiche `0 %` (pas encore de
  delta) — jamais une valeur inventée.
- Sur un hôte à N cœurs, un conteneur peut dépasser 100 % (jusqu'à N×100),
  comme dans `docker stats`.
- **Mémoire** : usage moins le cache page (comme `docker stats`), compatible
  cgroup v1 (`cache`) et v2 (`inactive_file`).
- Une donnée que Docker ne fournit pas (ex : réseau avec `network_mode=none`,
  I/O bloc selon le cgroup driver) reste `null` et s'affiche « Non exposé »,
  jamais `0`. Un conteneur arrêté n'a **aucune** métrique (`null`), ce qui
  est différent de « 0 % ».

## API REST

Toutes en `GET`, lisent le cache du poller (aucun appel Docker par requête).

| Route                                 | Permission    | Rôle                                                                                            |
| ------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `GET /api/docker/status`              | `docker_read` | `{ enabled, available, checkedAt, pollIntervalMs }`                                             |
| `GET /api/docker/containers`          | `docker_read` | `{ available, checkedAt, containers: [...] }`                                                   |
| `GET /api/docker/containers/:id`      | `docker_read` | Un conteneur (ID complet **ou préfixe court**). `404` si inconnu, `503` si Docker indisponible. |
| `GET /api/docker/containers/:id/logs` | `docker_logs` | Historique récent : `?tail=200` (1–2000). Le direct passe par le WebSocket.                     |

Forme d'un conteneur :

```json
{
  "id": "abc123…",
  "name": "postgres",
  "image": "postgres:16",
  "state": "running",
  "status": "Up 2 hours",
  "created": 1700000000000,
  "ports": [{ "privatePort": 5432, "publicPort": 5432, "type": "tcp", "ip": "0.0.0.0" }],
  "labels": {},
  "serverKey": "local",
  "cpuPercent": 2.4,
  "memory": { "usageBytes": 440401920, "limitBytes": 2147483648, "percent": 20.5 },
  "network": { "rxBytes": 1024, "txBytes": 2048 },
  "blockIo": { "readBytes": 4096, "writeBytes": 8192 },
  "pids": 7
}
```

Les clés API ne peuvent **pas** accéder à ces routes dans cette version
(aucun scope API n'est défini pour Docker — refus par défaut).

## WebSocket

Même serveur Socket.IO que le reste de l'application — pas de second
système temps réel.

| Événement                 | Sens             | Contenu                                                             |
| ------------------------- | ---------------- | ------------------------------------------------------------------- |
| `docker.snapshot`         | serveur → tous   | `{ available, checkedAt, containers }`, à chaque tick du poller.    |
| `docker:subscribe-logs`   | client → serveur | `{ containerId }` — ouvre le flux de logs de CE conteneur.          |
| `docker:unsubscribe-logs` | client → serveur | Ferme le flux du socket.                                            |
| `docker:log`              | serveur → abonné | `{ containerId, type: "out"\|"err", text, at }`                     |
| `docker:log-error`        | serveur → abonné | `{ containerId, error }` (refus de permission, conteneur disparu…). |

**Pourquoi les logs fonctionnent différemment de PM2.** PM2 expose un bus
qui streame déjà tous les logs en permanence, gratuitement. Docker n'a rien
d'équivalent : lire les logs d'un conteneur exige une connexion HTTP dédiée,
gardée ouverte. Ouvrir un flux par conteneur en permanence serait coûteux et
inutile ; un flux n'est donc ouvert que pour le conteneur **sélectionné**.

Le flux est fermé quand : l'utilisateur sélectionne un autre conteneur (un
seul abonnement par socket), quitte l'onglet, se déconnecte (WebSocket
fermé), quand le conteneur est supprimé (flux terminé côté Docker et/ou
absent du snapshot suivant), ou à l'arrêt du serveur (`SIGINT`).

Contrairement au flux `log` de PM2, l'abonnement est vérifié côté serveur
(`docker_logs`) **avant** d'ouvrir le flux Docker.

Le format des logs distingue stdout/stderr via l'en-tête multiplexé de Docker
(frames de 8 octets). **Exception :** un conteneur lancé avec un TTY
(`docker run -t`) n'a pas cette distinction — Docker lui-même ne la fait
pas dans ce mode ; tout est alors rapporté comme `out`.

## Permissions (RBAC)

Deux actions **globales** (pas de scope par conteneur dans cette version :
un utilisateur avec `docker_read` voit **tous** les conteneurs de l'hôte).

| Rôle       | `docker_read` | `docker_logs` |
| ---------- | :-----------: | :-----------: |
| `admin`    |      ✅       |      ✅       |
| `operator` |      ✅       |      ✅       |
| `viewer`   |      ✅       |      ✅       |
| `auditor`  |      ✅       |      ❌       |

`docker_read` couvre liste, détail et métriques ; `docker_logs` ajoute la
lecture des logs (historique et direct). Attribuables individuellement.

## Prometheus

Les métriques Docker sont ajoutées à `GET /metrics` (voir
[`docs/metrics/README.md`](../metrics/README.md)), depuis le **même cache** :
un scrape ne déclenche aucun appel Docker.

| Métrique                                                      | Type    |
| ------------------------------------------------------------- | ------- |
| `pm2_monitor_docker_up`                                       | gauge   |
| `pm2_monitor_docker_container_status{…,status}`               | gauge   |
| `pm2_monitor_docker_container_cpu_percent`                    | gauge   |
| `pm2_monitor_docker_container_memory_usage_bytes`             | gauge   |
| `pm2_monitor_docker_container_memory_limit_bytes`             | gauge   |
| `pm2_monitor_docker_container_network_{rx,tx}_bytes_total`    | counter |
| `pm2_monitor_docker_container_blkio_{read,write}_bytes_total` | counter |
| `pm2_monitor_docker_container_pids`                           | gauge   |

Labels : `container` (nom, pas l'ID — cardinalité stable après recréation),
`image`, `server` (toujours `local` pour l'instant). Une métrique dont la
donnée est absente n'est pas émise (jamais `0` par défaut).

## Résilience

| Situation                           | Comportement                                                           |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Docker non installé / socket absent | `available: false`, onglet « indisponible », reste inchangé.           |
| Daemon arrêté / socket inaccessible | Idem ; le poller réessaie à chaque tick, se rétablit seul.             |
| Conteneur supprimé pendant un tick  | Rapporté sans métriques, le tick continue.                             |
| Conteneur arrêté                    | Listé, métriques `null`.                                               |
| Conteneur redémarré                 | Repart d'un nouvel échantillon CPU (`0 %` un tick).                    |
| Erreur de flux de logs              | `docker:log-error` à l'abonné, flux fermé, rien ne remonte au process. |
| Flux interrompu (arrêt/redémarrage) | `docker:log-error` (`ended: true`), reprise auto via `since`.          |
| WebSocket fermé                     | Flux de logs de ce socket fermé.                                       |

## Problèmes courants

- **« Docker indisponible » alors que Docker tourne** — presque toujours un
  problème de permission sur le socket : `ls -l /var/run/docker.sock`,
  l'utilisateur de PM2 Monitor est-il dans le groupe `docker` (et le process
  redémarré depuis) ? Testez avec
  `curl --unix-socket /var/run/docker.sock http://localhost/_ping`.
- **Socket ailleurs** (Docker rootless : `$XDG_RUNTIME_DIR/docker.sock`) —
  définissez `DOCKER_SOCKET_PATH`.
- **CPU à 0 % juste après le démarrage** — normal, il faut deux
  échantillons (un intervalle).
- **Pas de distinction stdout/stderr** — conteneur lancé avec un TTY (voir
  ci-dessus).
- **Onglet Docker absent** — le compte n'a pas `docker_read`.
- **Logs refusés** — le compte a `docker_read` mais pas `docker_logs`
  (cas du rôle `auditor`).

## Multi-serveur (préparé, non implémenté)

Docker Monitoring est **local uniquement** dans cette version. Chaque
conteneur et instantané porte déjà un `serverKey` (`"local"`) et les
métriques Prometheus un label `server`, afin qu'un futur support des agents
distants (`bin/agent.js`) n'ait pas à changer la forme des données. Aucune
logique multi-serveur n'existe pour Docker à ce jour.

## Tests

```bash
node --test test/unit/docker-format.test.js test/unit/docker-log-demux.test.js
node --test test/integration/docker-service.test.js test/integration/docker-api.test.js
```

Les tests d'intégration utilisent un **faux daemon Docker sur un vrai socket
Unix** : aucun Docker réel n'est nécessaire.
