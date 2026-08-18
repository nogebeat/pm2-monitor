# Health Checks

Phase 6 du projet : un système de vérification de disponibilité
**indépendant du statut PM2**. Un process `online` chez PM2 veut dire "le
process n'a pas crashé", pas "l'application répond correctement" — par
exemple un serveur HTTP dont le port ne répond plus, ou une connexion base
de données morte, tout en restant un process PM2 `online`.

Un health check sonde une cible (URL HTTP, port TCP, ou commande) à
intervalle régulier, en déduit un statut (`UP`/`DOWN`/`DEGRADED`/`UNKNOWN`),
et alimente le moteur d'alertes existant ([`docs/alerts/README.md`](../alerts/README.md))
— **il n'existe pas de deuxième système d'alerte** : un health check n'est
qu'une nouvelle _source_ de valeurs pour `AlertEngine.evaluate()`, comme le
sont déjà les métriques process/système.

## Sommaire

- [Architecture](#architecture)
- [Types de sonde](#types-de-sonde)
  - [HTTP](#http)
  - [TCP](#tcp)
  - [Command](#command)
- [Statuts et transitions](#statuts-et-transitions)
- [Intervalles et timeouts](#intervalles-et-timeouts)
- [Intégration avec l'Alert Engine](#intégration-avec-lalert-engine)
- [API REST](#api-rest)
- [Permissions](#permissions)
- [Interface](#interface)
- [Configuration (.env)](#configuration-env)
- [Migration](#migration)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Architecture

```
lib/services/health-checks/
├── runner.js   # exécution pure des 3 types de sonde (http/tcp/command),
│                 impls réseau injectables pour les tests (aucun mock global)
├── store.js    # CRUD + validation de la table health_checks
├── engine.js   # HealthCheckEngine : run/runDueChecks/scheduler + feed Alert Engine
└── index.js    # singleton HealthCheckEngine partagé (routeur REST + scheduler)

lib/routes/health-checks.js              # routeur Express (/api/health-checks/…)
lib/db/migrations/008_health_checks.js   # table health_checks
frontend/src/components/modals/HealthChecksModal.vue  # UI (Settings → Health Checks)
```

`HealthCheckEngine` ne connaît ni Express ni PM2 : il sait exécuter une
sonde (`runProbe()` dans `runner.js`), persister le résultat, et notifier
l'Alert Engine. `server.js` se contente de démarrer le scheduler
(`engine.start(intervalMs)`) et de brancher `onAlertResult` sur le même
`dispatchAlertTransition` déjà utilisé pour les alertes process/système —
aucune route de dispatch de notification supplémentaire.

## Types de sonde

Configurables dans la table `health_checks` (une ligne = config + état
courant, voir `008_health_checks.js`) et par l'UI (Settings → Health
Checks). Le catalogue des types/méthodes/statuts valides est exposé par
`GET /api/health-checks/catalog`.

### HTTP

| Champ                 | Description                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `url`                 | URL complète (`http://` ou `https://` uniquement).                                              |
| `method`              | `GET`/`HEAD`/`POST`/`PUT`/`DELETE`/`PATCH` (défaut `GET`).                                      |
| `timeoutMs`           | Délai avant `DOWN` (défaut `5000`).                                                             |
| `expectedStatus`      | Code(s) de statut attendu(s) : `"200-299"`, `"200,201,204"`, `"200"` (défaut `"200-299"`).      |
| `expectedContent`     | Sous-chaîne attendue dans le corps de la réponse (optionnel, comparaison brute — pas de regex). |
| `intervalSeconds`     | Fréquence d'exécution (défaut `60`).                                                            |
| `degradedThresholdMs` | Au-delà : `DEGRADED` même si le reste est correct (optionnel).                                  |

Mesuré à chaque exécution : `responseTimeMs` (temps total requête) et
`statusCode`. Le corps de la réponse n'est lu qu'à hauteur de 64 Ko (juste
de quoi vérifier `expectedContent`), pour ne jamais charger une réponse
énorme en mémoire pour une simple sonde.

### TCP

| Champ                 | Description                                             |
| --------------------- | ------------------------------------------------------- |
| `host`                | Hôte à joindre.                                         |
| `port`                | Port TCP (1-65535).                                     |
| `timeoutMs`           | Délai avant `DOWN` (défaut `5000`).                     |
| `intervalSeconds`     | Fréquence d'exécution (défaut `60`).                    |
| `degradedThresholdMs` | Au-delà du temps de connexion : `DEGRADED` (optionnel). |

Un simple test de connexion (`net.Socket#connect`) : succès de la poignée
de main TCP = `UP` (ou `DEGRADED` si lent), refus de connexion/timeout =
`DOWN`. Ne fait aucune hypothèse sur le protocole applicatif au-dessus.

### Command

**Traité comme sensible** : une sonde `command` exécute un programme sur la
machine hôte. Elle n'est proposée dans l'UI/API que parce qu'une exécution
sécurisée est garantie par construction :

- `runner.js` utilise exclusivement **`child_process.execFile`** (jamais
  `exec`, jamais `spawn({ shell: true })`).
- La commande (`command`) et ses arguments (`commandArgs`, un tableau de
  chaînes) sont **toujours passés séparément** à `execFile` — aucune
  concaténation de chaîne, donc **aucune interprétation shell** des
  métacaractères (`; | & $() \`` …) qu'un argument pourrait contenir. Un
argument comme `"http://x; rm -rf /"`est transmis tel quel au binaire
cible en tant qu'argument unique, jamais exécuté comme une sous-commande
(voir`test/unit/health-checks-runner.test.js`, test "args passés
  séparément à execFile").
- `shell: false` est explicite dans les options d'`execFile`.
- Un `timeout` est toujours appliqué ; le process est tué (`SIGTERM`) s'il
  est dépassé, et ce cas est traité comme `DOWN` (`error: "timeout"`), pas
  comme une exception de programmation.

Autrement dit : la restriction "ne jamais concaténer naïvement des entrées
utilisateur dans un shell" est respectée nativement par `execFile`, ce qui
est la raison pour laquelle ce type est implémenté (l'alternative aurait été
de ne pas l'implémenter du tout — voir la consigne de la phase).

Ce que ce mécanisme **ne protège pas** (limites à connaître, pas des bugs) :
la commande elle-même peut faire n'importe quoi une fois lancée (c'est un
exécutable arbitraire sur le serveur). Créer un health check `command`
nécessite donc `health_checks_create`, une permission globale — un
utilisateur qui ne l'a pas ne peut pas définir de commande à exécuter par le
serveur. Un déploiement qui ne fait confiance à personne pour lancer des
commandes côté serveur peut simplement ne créer aucun check de ce type ;
rien ne l'exige.

| Champ                 | Description                                                                         |
| --------------------- | ----------------------------------------------------------------------------------- |
| `command`             | Chemin de l'exécutable (pas de recherche dans un shell : chemin absolu recommandé). |
| `commandArgs`         | Tableau d'arguments (chaînes), passés séparément — jamais concaténés.               |
| `expectedExitCode`    | Code de sortie attendu (défaut `0`).                                                |
| `timeoutMs`           | Délai avant `DOWN` (défaut `5000`).                                                 |
| `intervalSeconds`     | Fréquence d'exécution (défaut `60`).                                                |
| `degradedThresholdMs` | Au-delà du temps d'exécution : `DEGRADED` (optionnel).                              |

## Statuts et transitions

| Statut     | Signification                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN`  | État initial, avant la première exécution (ou check désactivé — aucune exécution en cours).                       |
| `UP`       | La dernière sonde a réussi et le temps de réponse est sous `degradedThresholdMs` (ou aucun seuil configuré).      |
| `DEGRADED` | La dernière sonde a réussi mais le temps de réponse dépasse `degradedThresholdMs`.                                |
| `DOWN`     | La dernière sonde a échoué : timeout, connexion refusée, code de statut/sortie inattendu, contenu attendu absent. |

Le statut affiché est **toujours celui de la dernière exécution** (pas de
lissage/moyenne). Ce qui s'accumule, ce sont `consecutiveFailures` et
`consecutiveSuccesses` — remis à zéro dès que le statut change de camp
(`DOWN` vs. tout le reste) — qui servent de base au comptage "N échecs
consécutifs" utilisé par l'Alert Engine (voir section suivante).

## Intervalles et timeouts

- `intervalSeconds` : fréquence de sonde **propre à chaque check**. Le
  scheduler (`HealthCheckEngine.runDueChecks()`) tourne toutes les
  `HEALTH_CHECKS_SCHEDULER_INTERVAL_MS` (défaut 5s) et n'exécute que les
  checks dont `now - lastCheckAt >= intervalSeconds * 1000` — ce n'est pas
  la fréquence d'exécution de chaque check individuellement.
- `timeoutMs` : délai avant qu'une sonde en cours soit considérée comme un
  échec (`DOWN`, `error: "timeout"`). S'applique à la requête HTTP, à la
  connexion TCP, ou à l'exécution de la commande.
- `degradedThresholdMs` (optionnel) : si le temps de réponse mesuré dépasse
  ce seuil alors que la sonde a par ailleurs réussi, le statut est
  `DEGRADED` plutôt que `UP`. Sans ce champ (ou à `null`), seul `UP`/`DOWN`
  sont possibles pour ce check (jamais `DEGRADED`).

## Intégration avec l'Alert Engine

Chaque exécution d'un health check (planifiée ou "run test") appelle
`HealthCheckEngine.feedAlertEngine(check)`, qui évalue toutes les règles
`alert_rules` activées avec `targetType = "health_check"` ciblant ce check
(`targetValue` = nom du check, ou `"*"` pour tous) via
`alertEngine.evaluate(rule, check.name, check.status)` — **exactement** le
même appel que `evaluateProcessReadings()`/`evaluateSystemReading()`
utilisent déjà pour les métriques process/système
(`lib/services/alerts/engine.js`, non modifié pour cette phase : `evaluate()`
était déjà générique sur `(rule, target, value)`).

Exemple concret — "3 échecs consécutifs déclenchent une alerte" se
configure comme n'importe quelle autre règle d'alerte :

```
POST /api/alerts/rules
{
  "name": "API principale down",
  "targetType": "health_check",
  "targetValue": "API principale",   // nom du health check, ou "*" pour tous
  "metric": "status",
  "operator": "==",
  "threshold": "DOWN",
  "durationSeconds": ...,             // à calibrer selon intervalSeconds du check :
                                       // N échecs consécutifs ≈ durationSeconds = N × intervalSeconds
  "severity": "critical",
  "cooldownSeconds": 1800
}
```

La transition résultante (`trigger`/`active`/`resolved`) suit ensuite le
routage de notifications déjà en place (Discord/Slack/Email/…) sans aucun
code spécifique aux health checks — voir
[`docs/alerts/README.md#durée-anti-bruit-de-mesure`](../alerts/README.md#durée-anti-bruit-de-mesure)
pour le détail du calcul de durée, et
[`docs/notifications/README.md`](../notifications/README.md) pour le
routing.

## API REST

Toutes les routes sont montées sous `/api/health-checks` (voir
`lib/routes/health-checks.js`).

| Méthode   | Route             | Permission             | Description                                                                                                          |
| --------- | ----------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET       | `/`               | `health_checks_read`   | Liste tous les checks (`?enabled=1` pour ne lister que ceux activés).                                                |
| GET       | `/catalog`        | `health_checks_read`   | Types/méthodes/statuts valides (pour construire un formulaire).                                                      |
| GET       | `/status/summary` | `health_checks_read`   | Vue condensée statut/dernier check/temps de réponse (dashboard).                                                     |
| GET       | `/:id`            | `health_checks_read`   | Détail d'un check.                                                                                                   |
| POST      | `/`               | `health_checks_create` | Crée un check.                                                                                                       |
| PUT/PATCH | `/:id`            | `health_checks_update` | Modifie la configuration d'un check.                                                                                 |
| POST      | `/:id/enable`     | `health_checks_update` | Active un check.                                                                                                     |
| POST      | `/:id/disable`    | `health_checks_update` | Désactive un check (le scheduler l'ignore, la config reste).                                                         |
| DELETE    | `/:id`            | `health_checks_delete` | Supprime un check.                                                                                                   |
| POST      | `/:id/test`       | `health_checks_test`   | Exécute la sonde immédiatement, persiste le résultat (alimente aussi l'Alert Engine — pas un chemin de code séparé). |

## Permissions

Actions globales, ajoutées à `GLOBAL_ACTIONS` dans `lib/permissions.js` (un
health check n'est pas "sur" une app PM2 précise au sens des permissions —
il peut même ne cibler aucune app, ex: un check TCP sur une base de données
externe) :

- `health_checks_read`
- `health_checks_create`
- `health_checks_update` (couvre aussi enable/disable)
- `health_checks_delete`
- `health_checks_test` (run test à la demande)

## Interface

Settings → **❤ Health Checks** (bouton dans la topbar, visible si
`health_checks_read`). Permet de :

- créer / éditer / supprimer un check (formulaire adapté au type choisi) ;
- activer / désactiver ;
- lancer une exécution immédiate ("Run test") ;
- voir, par check : statut courant, date du dernier check, temps de
  réponse, date de la dernière panne, et le dernier message d'erreur le cas
  échéant.

## Configuration (.env)

```bash
# Passe à 0 pour désactiver le scheduler (l'API de gestion reste disponible,
# rien ne s'exécute automatiquement).
HEALTH_CHECKS_ENABLED=1

# Fréquence (ms) à laquelle le scheduler regarde quels checks sont dus.
HEALTH_CHECKS_SCHEDULER_INTERVAL_MS=5000
```

Voir `.env.example` à la racine du projet. Aucune de ces variables n'est
requise : les valeurs par défaut ci-dessus s'appliquent si elles sont
absentes.

## Migration

```text
version : 008_health_checks
up      : crée la table health_checks (config + état courant) et ses index
down    : supprime la table health_checks
```

```bash
npm run migrate:status
npm run migrate:up
```

## Tests

```bash
node --test test/unit/health-checks-runner.test.js    # sondes HTTP/TCP/Command, mockées (aucun accès réseau)
node --test test/unit/health-checks-engine.test.js     # transitions de statut, feed Alert Engine
node --test test/integration/health-checks-api.test.js # API réelle + DB SQLite temporaire + permissions
```

Aucun de ces tests ne fait d'appel réseau réel : `runner.js` accepte des
implémentations injectées (`httpRequestImpl`/`tcpConnectImpl`/`execFileImpl`)
utilisées par les tests unitaires, et les tests d'intégration API ciblent
volontairement des ports/IP locaux voués à échouer rapidement (`127.0.0.1`
sur un port improbable) plutôt qu'un service externe.

## Limites connues

- Le scheduler tourne dans le même process Node que le reste du dashboard
  (comme le moteur d'alertes et l'historique de process) : pas de worker
  séparé. Un grand nombre de checks avec des intervalles courts peut donc
  concurrencer les autres tâches périodiques.
- Le type `command` exécute un binaire côté serveur avec les droits du
  process Node — voir la mise en garde dans la section [Command](#command).
- `expectedContent` fait une comparaison de sous-chaîne brute sur les 64
  premiers Ko de la réponse HTTP, pas une recherche regex ni une lecture du
  corps complet.
