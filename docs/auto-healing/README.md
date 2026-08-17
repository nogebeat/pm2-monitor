# Auto-Healing

Phase 7 du projet : redémarrage **automatique** d'un process quand une
condition d'échec est détectée (crash, health check `DOWN`, seuil dépassé).

> ⚠️ **Fonctionnalité CRITIQUE / DANGEREUSE.** Auto-Healing peut redémarrer
> automatiquement des process de production sans intervention humaine. Elle
> est **désactivée par défaut** et ne peut être activée que par une action
> explicite d'un utilisateur disposant de la permission `authealing_manage`.
> Lisez entièrement cette page (en particulier
> [Risques](#risques) et [Garde-fous](#garde-fous)) avant de l'activer.

## Sommaire

- [Risques](#risques)
- [Architecture](#architecture)
- [Sources d'événements](#sources-dévénements)
- [Action](#action)
- [Garde-fous](#garde-fous)
  - [Maximum attempts](#maximum-attempts)
  - [Cooldown / Backoff exponentiel](#cooldown--backoff-exponentiel)
  - [État bloqué (`AUTO-HEALING BLOCKED`)](#état-bloqué-auto-healing-blocked)
- [Activation](#activation)
- [Configuration](#configuration)
- [Permissions](#permissions)
- [Audit](#audit)
- [API REST](#api-rest)
- [Sécurité](#sécurité)
- [Migration](#migration)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Risques

- Un redémarrage automatique peut masquer un problème plus profond (fuite
  mémoire, dépendance externe morte) au lieu de le signaler clairement — les
  notifications et l'audit restent le principal signal à surveiller.
- Un cycle de crash rapide, sans les garde-fous ci-dessous, redémarrerait un
  process indéfiniment ("crash loop"). C'est précisément ce que le nombre
  maximum de tentatives et l'état bloqué empêchent.
- Auto-Healing n'exécute **qu'une seule action** : un redémarrage PM2
  (`pm2.restart`). Elle ne supprime, ne tue, ne redéploie et ne modifie
  jamais la configuration d'un process — voir [Action](#action).

## Architecture

```
lib/services/auto-healing/
├── engine.js          # AutoHealingService : seul point de décision/action (trigger())
├── settings-store.js  # config globale (ligne unique, activé/désactivé, maxAttempts, backoff)
├── state-store.js     # état par process (tentatives, bloqué, prochain essai autorisé)
├── audit-store.js     # journal append-only de chaque tentative
└── index.js           # adaptateurs des 3 sources d'événements -> trigger()
```

`AutoHealingService` ne agit **jamais** directement : toute action passe par
`trigger()`, qui vérifie systématiquement les garde-fous (désactivé ?
bloqué ? en cooldown ? tentatives déjà épuisées ?) avant d'appeler
`lib/pm2-actions.js#restart()`.

## Sources d'événements

Trois sources alimentent `trigger()`, sans créer de second listener/scheduler
(réutilisation explicite de ce qui existe déjà, même règle que pour les
Health Checks et la Timeline d'événements) :

1. **Alert Engine** — toute transition d'alerte vers `active` dont la cible
   est un process ou un health check (`lib/services/auto-healing/index.js#feedFromAlertTransition`,
   branché sur la même fonction `dispatchAlertTransition()` que les
   notifications, voir `lib/alert-dispatch.js`). Couvre par construction les règles
   `memory > threshold`, `restart_count > N`, `status == stopped`, etc.
2. **Health Checks** — un check `DOWN` est lui-même une nouvelle *source* de
   valeurs pour l'Alert Engine (voir `docs/health-checks/README.md`), donc
   déjà couvert par le point précédent : pas de deuxième chemin de code. Le
   nom du check (`alert.targetValue`) n'est **pas** utilisé tel quel comme
   nom de process : il est résolu via `health_checks.process_name`
   (colonne explicite, migration `010_health_checks_process_name.js`).
   Si ce champ n'est pas renseigné pour le check concerné, Auto-Healing
   **ignore** l'événement plutôt que de supposer une correspondance de noms
   — voir [Limites connues](#limites-connues).
3. **PM2 events** — le packet `process:event` du bus PM2 (`bus.on("process:event")`,
   branché dans `lib/realtime/pm2-bus.js` pour la timeline et le flux temps
   réel) ; seul l'événement `exit` déclenche Auto-Healing
   (`feedFromPm2Event()`), signal le plus direct et le plus rapide d'un crash.

Une transition d'alerte `resolved` (ou un health check redevenu sain)
appelle `recordRecovery()`, qui remet le compteur de tentatives à zéro —
**sauf si le process est déjà bloqué** (voir [État bloqué](#état-bloqué-auto-healing-blocked)).

## Action

Une seule action est possible pour le moment :

```
PM2 restart
```

`delete`, `kill`, `deploy` et toute modification de configuration sont
**volontairement absents** et nécessiteraient une nouvelle validation
architecturale avant d'être ajoutés.

## Garde-fous

Tous obligatoires, testés en premier (`test/unit/auto-healing-engine.test.js`).

### Maximum attempts

Configurable (`maxAttempts`, défaut `3`). Au-delà, plus aucun restart n'est
tenté : le process passe en [état bloqué](#état-bloqué-auto-healing-blocked).

```
max attempts = 3

attempt 1 → restart
attempt 2 → restart
attempt 3 → restart
(nouvel échec) → BLOCKED
```

### Cooldown / Backoff exponentiel

Après chaque tentative, un cooldown est posé avant la suivante
(`backoffSeconds`, tableau configurable, défaut `[60, 300, 900]` = 1 min,
5 min, 15 min). Un nouvel événement reçu pendant le cooldown est **ignoré**
(pas de restart, pas de comptage supplémentaire).

Le palier utilisé dépend du numéro de tentative (`backoffSeconds[attempt-1]`,
le dernier palier étant réutilisé si `maxAttempts > backoffSeconds.length`).

### État bloqué (`AUTO-HEALING BLOCKED`)

Après épuisement des tentatives, le process reste bloqué **indéfiniment**,
même si de nouveaux événements de crash arrivent — aucun restart
supplémentaire n'est tenté. Seule une action utilisateur explicite
(`POST /api/auto-healing/state/:process/unblock`, permission
`authealing_manage`) peut débloquer un process. Une guérison spontanée
(health check à nouveau `UP`) **ne débloque jamais** un process bloqué :
c'est une garantie volontaire (`recordRecovery()` retourne immédiatement si
`state.blocked`), pour qu'un humain regarde toujours la cause avant de
réactiver le healing automatique sur ce process.

Chaque passage en bloqué est audité avec `result: "blocked"` — à brancher
sur le système de notifications existant (`lib/services/notifications/`)
côté alerte critique si souhaité (même mécanisme que les alertes `critical`).

## Activation

Désactivé par défaut en base (migration `009_auto_healing.js`, colonne
`auto_healing_settings.enabled = 0`). Aucune variable d'environnement ne
l'active : l'activation est **toujours** une action explicite via l'API
(`PUT /api/auto-healing/settings { "enabled": true }`), jamais un effet de
bord d'une autre configuration.

## Configuration

```
GET /api/auto-healing/settings
PUT /api/auto-healing/settings
```

Champs modifiables :

| Champ            | Type            | Défaut            | Description                                   |
| ---------------- | --------------- | ------------------ | ---------------------------------------------- |
| `enabled`         | boolean         | `false`            | Active/désactive Auto-Healing globalement.     |
| `maxAttempts`      | entier (1–20)   | `3`                 | Nombre de restarts avant blocage.              |
| `backoffSeconds`   | tableau de nombres | `[60, 300, 900]` | Paliers de cooldown, en secondes, par tentative. |

## Permissions

Deux permissions globales (`lib/permissions.js`) :

- `authealing_read` — voir la configuration, l'état par process, l'audit.
- `authealing_manage` — activer/désactiver, changer la configuration,
  débloquer un process.

Aucune permission par app : Auto-Healing agit sur le nom du process tel que
rapporté par les sources d'événements (déjà filtré côté restart par
`lib/pm2-actions.js`, cohérent avec le reste de l'application).

## Audit

Chaque tentative (réussie, échouée, ou bloquée) est enregistrée dans
`auto_healing_audit`, sans exception :

```
Auto-healing triggered
Process: api-prod
Reason: health check failed
Action: restart
Attempt: 2/3
Result: success
```

```
GET /api/auto-healing/audit?process=api-prod&result=blocked&limit=100&offset=0
```

Journal **append-only** : aucun endpoint de suppression n'est exposé.

## API REST

| Méthode | Route                                   | Permission          | Description                          |
| ------- | ---------------------------------------- | -------------------- | ------------------------------------- |
| GET     | `/api/auto-healing/settings`             | `authealing_read`    | Configuration globale.                |
| PUT     | `/api/auto-healing/settings`             | `authealing_manage`  | Modifie la configuration globale.     |
| GET     | `/api/auto-healing/state`                | `authealing_read`    | État de tous les process suivis.      |
| GET     | `/api/auto-healing/state/:process`       | `authealing_read`    | État d'un process précis.             |
| POST    | `/api/auto-healing/state/:process/unblock` | `authealing_manage` | Débloque un process `BLOCKED`.        |
| GET     | `/api/auto-healing/audit`                | `authealing_read`    | Historique paginé des tentatives.     |

## Sécurité

- Aucune commande shell : la seule action possible passe par
  `lib/pm2-actions.js#restart()`, qui appelle l'API programmatique PM2
  (`pm2.restart(id, cb)`) déjà utilisée par `POST /api/processes/:id/restart`
  — jamais de `exec`/`spawn` avec une chaîne construite depuis une entrée
  utilisateur.
- `reason` (le motif journalisé) est toujours une phrase courte et fixe
  choisie par le code appelant (`"process crashed"`, `"<metric> <op>
  <threshold>"`), jamais une valeur libre injectée puis interprétée.
- Voir `test/unit/auto-healing-engine.test.js` (section "sécurité") pour la
  vérification explicite qu'une entrée malveillante en `processName`/`reason`
  ne se retrouve jamais exécutée : elle est transmise telle quelle à l'API
  PM2, qui ne l'interprète pas comme une commande.

## Migration

`lib/db/migrations/009_auto_healing.js` — trois tables :
`auto_healing_settings` (ligne unique), `auto_healing_state` (une ligne par
process), `auto_healing_audit` (append-only). `down()` les supprime sans
affecter les tables des phases précédentes.

## Tests

- `test/unit/auto-healing-engine.test.js` — garde-fous d'abord (max
  attempts, cooldown, backoff, blocage, recovery, déblocage manuel), puis
  audit et sécurité. Utilise des stores en mémoire (pas de DB, pas de PM2
  réel — `restart()` est injecté).
- `test/integration/auto-healing-api.test.js` — vrai routeur + vraie DB
  SQLite temporaire : permissions (`authealing_read`/`authealing_manage`),
  activation explicite, workflow bloqué → audit → déblocage.

Aucun test n'exécute de vrai redémarrage PM2 ni ne dépend d'un process
réel : `restart()` est toujours injecté (fake) dans les tests.

## Limites connues

- Un health check dont `process_name` n'est pas renseigné ne peut pas
  déclencher Auto-Healing (aucune correspondance implicite tentée) : c'est
  volontaire, pour ne jamais redémarrer le mauvais process. Renseigne
  `process_name` en créant/éditant le check si tu veux qu'il puisse
  déclencher un healing automatique.
- Une seule action (`restart`) est supportée pour l'instant ; `reload`
  (0-downtime) n'est pas branché sur Auto-Healing.
