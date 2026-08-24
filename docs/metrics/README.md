# Prometheus Metrics Export (Phase 15)

Expose un endpoint `GET /metrics` au format d'exposition Prometheus, en
composant les métriques déjà collectées ailleurs dans PM2 Monitor (process
PM2, système, alertes, health checks, registre de serveurs). **Aucune
nouvelle source de données, aucun nouveau scheduler** : ce module ne fait
que mettre en forme ce qui existe déjà.

Prometheus n'est **jamais obligatoire** : si `METRICS_ENABLED=0` (ou si
personne n'interroge `/metrics`), rien ne change pour le reste de
l'application.

## Composants

- `lib/services/metrics/config.js` — `resolveConfig(env)` : lecture des
  variables d'environnement (activation, token, restriction IP).
- `lib/services/metrics/format.js` — formatteur texte Prometheus minimal
  (échappement des labels, lignes `HELP`/`TYPE`/échantillon), écrit à la
  main plutôt que via une dépendance (`prom-client`) : PM2 Monitor ne fait
  tourner aucun _registry_/_collector_ en continu, juste une conversion
  ponctuelle à chaque scrape.
- `lib/services/metrics/registry.js` — `buildMetricsText(deps)` : fonction
  **pure** (aucun accès DB/réseau/pm2) qui assemble le texte final à partir
  de données déjà chargées par le routeur.
- `lib/db/migrations/017_servers_last_processes.js` — ajoute
  `servers.last_processes` (colonne additive, nullable) : persiste le
  dernier snapshot process reçu d'un agent distant au même rythme que
  `servers.last_snapshot` (migration 012) le fait déjà pour le snapshot
  système, via `lib/services/servers/store.js#touchStatus` — donnée
  disponible pour `GET /metrics` même après un redémarrage du serveur
  central (pas de cache mémoire volatile, pas de nouveau canal de
  collecte : le même événement `register`/`heartbeat` d'agent, déjà
  traité par `lib/realtime/agent-hub.js`, écrit simplement une colonne de
  plus).
- `lib/routes/metrics.js` — `GET /metrics`, monté directement sur `app`
  (pas sous `/api`, voir [Sécurité](#sécurité)).

## Scrape configuration

Exemple minimal de `prometheus.yml` (sans authentification, réseau interne
de confiance uniquement) :

```yaml
scrape_configs:
  - job_name: "pm2-monitor"
    scrape_interval: 15s
    static_configs:
      - targets: ["localhost:4200"]
```

Avec un jeton (`METRICS_TOKEN`, recommandé dès que Prometheus n'est pas sur
la même machine) :

```yaml
scrape_configs:
  - job_name: "pm2-monitor"
    scrape_interval: 15s
    bearer_token: "le-meme-token-que-METRICS_TOKEN"
    static_configs:
      - targets: ["monitor.example.com:4200"]
```

Si le dashboard est servi en HTTPS derrière un reverse proxy, ajoute
`scheme: https` (et `tls_config` si certificat auto-signé).

## Sécurité

`/metrics` n'est **pas** protégé par le système d'authentification par
session de PM2 Monitor (cookie de navigateur) — un scraper Prometheus n'a
ni compte ni session. Il applique donc sa propre politique d'accès,
contrôlée par trois variables (voir `.env.example`) :

- **`METRICS_ENABLED`** (défaut `1`) — passe à `0` pour désactiver
  complètement l'endpoint (404 pour toute requête, y compris authentifiée).
- **`METRICS_TOKEN`** — si défini, toute requête doit porter l'en-tête
  `Authorization: Bearer <token>` (comparaison en temps constant). Sans
  cette variable, aucun jeton n'est exigé.
- **`METRICS_ALLOWED_IPS`** — liste d'IP autorisées, séparées par des
  virgules (comparaison exacte sur l'IP de la requête, cohérente avec
  `app.set("trust proxy", 1)` déjà en place dans `server.js`).

**Comportement par défaut** (aucune des deux dernières variables définie) :
seul l'hôte local (`127.0.0.1` / `::1`) peut interroger `/metrics`. Un
opérateur qui veut scraper depuis une autre machine doit définir
explicitement `METRICS_TOKEN` et/ou `METRICS_ALLOWED_IPS` — l'endpoint
n'est jamais exposé publiquement par défaut, même si le port du dashboard
l'est.

**Aucun secret n'est jamais exposé** : les variables d'environnement des
process PM2 (`pm2_env.env` — souvent porteuses de secrets applicatifs :
mots de passe DB, clés API…), les tokens d'agent (Phase 10) et les secrets
de providers de notification (Phase 5) ne font partie d'aucune métrique.
Seules des valeurs numériques (CPU, mémoire, uptime, restarts, statut,
compteurs) et des labels de nommage (nom de process, clé de serveur,
environnement) sont exposés — voir `test/unit/metrics-registry.test.js` et
`test/integration/metrics-api.test.js` pour les tests correspondants.

## Métriques disponibles

Toutes les métriques sont préfixées `pm2_monitor_`.

### Process (labels : `process`, `server`, `environment`)

| Métrique                             | Type    | Description                                                                                                                                                               |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pm2_monitor_process_cpu_percent`    | gauge   | CPU du process (tel que rapporté par `pm2 monit`), en %.                                                                                                                  |
| `pm2_monitor_process_memory_bytes`   | gauge   | Mémoire résidente (RSS), en octets.                                                                                                                                       |
| `pm2_monitor_process_uptime_seconds` | gauge   | Temps depuis le dernier démarrage (0 si non `online`).                                                                                                                    |
| `pm2_monitor_process_restarts_total` | counter | Nombre de redémarrages depuis la création dans PM2.                                                                                                                       |
| `pm2_monitor_process_status`         | gauge   | `1` pour le label `status` correspondant à l'état courant (`online`/`stopped`/`stopping`/`launching`/`errored`) — une seule série par process, pas une par état possible. |

### Système (labels : `server`, `environment`)

| Métrique                                                             | Type  | Description                                         |
| -------------------------------------------------------------------- | ----- | --------------------------------------------------- |
| `pm2_monitor_system_cpu_percent`                                     | gauge | Utilisation CPU système (moyenne tous cœurs), en %. |
| `pm2_monitor_system_memory_used_bytes` / `_total_bytes` / `_percent` | gauge | Mémoire système.                                    |
| `pm2_monitor_system_disk_used_bytes` / `_total_bytes` / `_percent`   | gauge | Espace disque (partition `/`).                      |

### Registre de serveurs (Phase 10, labels : `server`, `environment`, `kind`)

| Métrique                    | Type  | Description                                                                                      |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `pm2_monitor_server_status` | gauge | `1` pour le label `status` correspondant (`ONLINE`/`OFFLINE`/`PENDING`) — une série par serveur. |

### Health checks (labels : `check`, `enabled`)

| Métrique                         | Type  | Description                                                                                        |
| -------------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| `pm2_monitor_healthcheck_status` | gauge | `1` pour le label `status` correspondant (`UP`/`DOWN`/`DEGRADED`/`UNKNOWN`) — une série par check. |

### Alertes (labels : `severity`, `target_type`, `target`)

| Métrique                    | Type  | Description                                                                                                                                                                                                                                                                  |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pm2_monitor_alerts_active` | gauge | Nombre d'alertes actives, par sévérité (`critical`/`warning`), type de cible (`process`/`system`/`health_check`) et cible (nom d'app ou de check, absent pour `system`). Reflète `alert_rules.target_type`/`target_value` — voir `lib/services/alerts/alert-rules-store.js`. |

Pas de label `server` sur cette métrique : `lib/polling.js` (seul appelant
du moteur d'alertes) n'évalue les règles que contre l'hôte local — la
Phase 10 (multi-server) n'a jamais été rétrofittée dans le moteur
d'alertes, donc toute alerte active concerne forcément le serveur local.
Un label `server="local"` figé sur cette seule métrique serait trompeur
(laisserait croire que les alertes distantes existent mais sont absentes
du scrape, alors qu'elles n'existent tout simplement pas côté moteur
d'alertes) — retrofitter le moteur d'alertes pour le multi-serveur
sortirait du périmètre de cette phase (export de métriques, pas
réécriture de l'Alert Engine).

### Divers

| Métrique                              | Type  | Description                                                                             |
| ------------------------------------- | ----- | --------------------------------------------------------------------------------------- |
| `pm2_monitor_up`                      | gauge | Toujours `1` si la réponse a pu être générée (permet de détecter un scrape qui échoue). |
| `pm2_monitor_build_info{version="…"}` | gauge | Métadonnées de version (`package.json#version`), valeur toujours `1`.                   |

## Labels — conventions

- **`process`** : nom d'app PM2 (jamais un PID/ID, qui change à chaque
  redémarrage — cardinalité bornée par le nombre de process réellement
  gérés).
- **`server`** : `serverKey` du registre de serveurs (Phase 10 — `"local"`
  ou `"srv_xxx"`), le **même** identifiant que celui déjà utilisé partout
  ailleurs dans l'application (`serverId` des événements Socket.IO,
  historique par process). Jamais le nom affichable (modifiable par
  l'utilisateur, non garanti unique).
- **`environment`** : `servers.environment` (Phase 10 —
  production/staging/development/custom), un environnement **par
  serveur**. Les tags/environnements par process (Phase 13, Organisation
  des process) ne sont volontairement pas repris ici, pour éviter
  d'exploser la cardinalité avec des combinaisons tag × process
  arbitraires.
- **`target_type`** / **`target`** : uniquement sur
  `pm2_monitor_alerts_active` — voir la note dans la section
  [Alertes](#alertes-labels--severity-target_type-target) ci-dessus.

## Multi-server (Phase 10)

Si le registre de serveurs (`lib/services/servers/`) est présent, chaque
serveur suivi (local + agents distants) apparaît avec ses propres séries
`server`/`environment` pour les métriques process et système, plus une
série `pm2_monitor_server_status` par serveur.

Les données process d'un serveur distant proviennent de
`servers.last_processes` (migration 017) : le dernier snapshot process
reçu de l'agent, **persisté en base** à chaque `register`/`heartbeat` (voir
`lib/services/servers/store.js#touchStatus`) — donc toujours disponible
après un redémarrage du serveur central, contrairement à un simple cache
mémoire qui resterait vide jusqu'au prochain heartbeat de chaque agent. Si
l'agent est hors ligne depuis longtemps, ces métriques reflètent son
dernier état connu, pas un état "en direct" réévalué à chaque scrape
(cohérent avec le reste de l'application : le dashboard/l'historique
fonctionnent de la même façon).
