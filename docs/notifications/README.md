# Notification system — Phases 5A à 5D (fondations, providers, admin, routing)

Phase 5A a posé l'architecture, les modèles de données et le registry
des providers du système de notifications (Email/Discord/Telegram/
Slack/Webhook générique). Phase 5B a implémenté l'envoi réel pour ces
cinq providers (`validateConfig()`/`test()`/`send()`, `healthCheck()`
pour email et telegram). Phase 5C a ajouté le CRUD HTTP complet des
providers et l'interface d'administration (`Settings → Notifications →
Providers`). **Phase 5D branche le routing par règles
(`notification_routes`) sur l'Alert Engine** (`lib/services/alerts/`) :
quand une alerte se déclenche (ou se résout, si la règle le demande),
les règles activées dont les `conditions` matchent l'alerte envoient
une notification (avec template optionnel) à chacun de leurs
providers, et chaque tentative est journalisée dans
`notification_history`. La mise en file d'attente/retry
(`lib/services/queue/`) reste hors scope et prévue en Phase 5E : le
dispatch de cette phase est direct (pas de retry automatique en cas
d'échec provider).

## Sommaire

- [Architecture](#architecture)
- [Provider Registry](#provider-registry)
- [Providers (Phase 5B)](#providers-phase-5b)
- [Modèle de configuration de provider](#modèle-de-configuration-de-provider)
- [Secrets](#secrets)
- [Routing (Phase 5D)](#routing-phase-5d)
- [Templates (Phase 5D)](#templates-phase-5d)
- [Notification Queue (Phase 5E)](#notification-queue-phase-5e)
- [Historique](#historique)
- [API REST](#api-rest)
- [Permissions](#permissions)
- [Configuration (.env)](#configuration-env)
- [Migration](#migration)
- [Ajouter un provider](#ajouter-un-provider)
- [Intégration & Sécurité (Phase 5F)](#intégration--sécurité-phase-5f)
- [Limites connues de cette phase](#limites-connues-de-cette-phase)

## Architecture

```
lib/services/notifications/
├── index.js              # point d'entrée : assemble registry + manager + stores (singleton)
├── manager.js             # NotificationManager : catalogue de types, validation — jamais les détails d'un provider
├── registry.js            # ProviderRegistry : registerProvider/getProvider/listProviders/hasProvider
├── types.js               # classe abstraite NotificationProvider (validateConfig, test() par défaut, send() abstrait, healthCheck() optionnel)
├── provider-store.js      # CRUD table notification_providers, secrets chiffrés
├── history-store.js       # CRUD table notification_history (modèle seul, rien n'écrit encore automatiquement)
├── providers/
│   ├── index.js            # liste des providers à enregistrer au démarrage
│   ├── shared.js            # helpers communs : résultats normalisés, timeout fetch(), classification d'erreurs
│   ├── email.js              # SMTP via nodemailer — send() + healthCheck() (verify())
│   ├── discord.js             # Webhook Discord — send() + healthCheck() (GET webhook)
│   ├── telegram.js            # Bot API Telegram — send() + healthCheck() (getMe())
│   ├── slack.js                # Incoming Webhook Slack — send()
│   └── webhook.js               # Webhook générique configurable — send()
├── routing/
│   ├── route-store.js      # CRUD table notification_routes (conditions, providerIds, templates, notifyOnResolve)
│   ├── templates.js         # rendu {{placeholder}} d'un titre/message à partir d'une occurrence d'alerte
│   └── engine.js             # RoutingEngine (Phase 5D) : matching des conditions + dispatch vers les providers
└── utils/
    └── crypto.js           # chiffrement AES-256-GCM des secrets au repos

lib/routes/notifications.js   # routeur Express (/api/notifications/…), aucune logique métier dedans
lib/db/migrations/006_notifications.js   # tables notification_providers, notification_routes, notification_history
lib/db/migrations/007_notification_routing_templates.js   # + title_template/message_template/notify_on_resolve sur notification_routes
docs/notifications/providers/   # un fichier par provider (configuration, sécurité, tests, erreurs)
```

Même découpage que `lib/services/alerts/` et `lib/services/events/` :
`lib/services/notifications/index.js` exporte un singleton (`registry`,
`manager`, `routingEngine`, `providerStore`, `routeStore`,
`historyStore`) partagé par `lib/routes/notifications.js` et par
`lib/alert-dispatch.js` (appelé depuis la boucle de polling et depuis le
moteur de health checks) — un seul registry en mémoire pour tout le
process.

**Comment une alerte devient une notification (Phase 5D)** — voir
`lib/alert-dispatch.js` :

```
AlertEngine.evaluateSystemReading()/evaluateProcessReadings() (tick périodique, lib/polling.js)
  → occurrence d'alerte transitionne trigger->active (ou ->resolved)
  → dispatchAlertTransition() (lib/alert-dispatch.js) détecte cette
    transition précise (sans modifier engine.js, voir le commentaire de
    createDispatchAlertTransition() dans lib/alert-dispatch.js)
  → routingEngine.dispatch(alert, "triggered" | "resolved")
      → routeStore.list({ enabledOnly: true })
      → routeMatches(route, alert) pour chaque règle (severity/alertType/process/server)
      → pour chaque route matchée × chaque providerId de la route :
          templates.renderNotification(route, alert, event)
          → registry.getProvider(provider.type).send(notification, config)
          → historyStore.create({ providerId, alertId, status, errorCode, responseTimeMs })
```

`routingEngine.dispatch()` ne lance jamais : une erreur (provider en
panne, DB indisponible pour l'historique…) est journalisée en console
et ne remonte jamais jusqu'à la boucle de monitoring (voir
[Limites connues](#limites-connues-de-cette-phase)).

## Provider Registry

Le `NotificationManager` ne connaît jamais les détails d'un provider
précis : il passe toujours par le `ProviderRegistry`
(`registerProvider()` / `getProvider()` / `listProviders()` /
`hasProvider()`). Ajouter un provider revient à ajouter un fichier dans
`providers/` + le déclarer dans `providers/index.js`, sans toucher au
manager ni aux routes.

Chaque provider implémente la classe abstraite `NotificationProvider`
(`types.js`) :

```text
type              # identifiant unique, ex: "discord"
label              # nom lisible, ex: "Discord"
validateConfig()    # retourne un tableau d'erreurs (jamais d'exception)
test()               # implémentation par défaut dans types.js : valide la config
                       #   puis délègue à send() avec une notification de test standard
send()                # abstrait dans types.js, implémenté par chaque provider (Phase 5B)
healthCheck()          # optionnel — vérification de connectivité distincte d'un envoi
                          #   (implémenté pour email et telegram uniquement, voir plus bas)
```

Cinq providers sont enregistrés et pleinement opérationnels :
`email`, `discord`, `telegram`, `slack`, `webhook`. Voir
[Providers (Phase 5B)](#providers-phase-5b) pour le détail de chacun.

## Providers (Phase 5B)

Documentation complète (configuration, prérequis, sécurité, test,
erreurs communes) : [`docs/notifications/providers/`](./providers/).

| Provider          | Fichier                 | Doc                                              | `healthCheck()`                                  |
| ----------------- | ----------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Email/SMTP        | `providers/email.js`    | [providers/email.md](./providers/email.md)       | Oui (`verify()`)                                 |
| Discord           | `providers/discord.js`  | [providers/discord.md](./providers/discord.md)   | Oui (GET webhook)                                |
| Telegram          | `providers/telegram.js` | [providers/telegram.md](./providers/telegram.md) | Oui (`getMe()`)                                  |
| Slack             | `providers/slack.js`    | [providers/slack.md](./providers/slack.md)       | Non (webhook Slack sans introspection GET utile) |
| Webhook générique | `providers/webhook.js`  | [providers/webhook.md](./providers/webhook.md)   | Non (dépend du système externe)                  |

Résultat normalisé, commun à tous les providers (`send()`, `test()`,
`healthCheck()`) :

```text
succès : { success: true,  provider, messageId,             responseTime }
échec  : { success: false, provider, errorCode, safeMessage, responseTime }
```

`errorCode` ∈ `INVALID_CONFIG`, `AUTH_ERROR`, `NOT_FOUND`,
`RATE_LIMITED`, `TIMEOUT`, `NETWORK_ERROR`, `PROVIDER_ERROR`,
`HTTP_ERROR`, `MALFORMED_RESPONSE`. `safeMessage` est **toujours** un
message générique construit à partir d'un code d'erreur connu (statut
HTTP, `err.code` nodemailer, timeout) — jamais le message brut d'une
erreur réseau/SMTP, qui peut contenir l'URL appelée (donc un token de
webhook) ou le host SMTP interne. Voir
[`providers/shared.js`](../../lib/services/notifications/providers/shared.js).

Notification envoyée par `send(notification, config)` : objet
`{ title, message, severity, timestamp }`, produit soit manuellement
(ex. `POST /providers/:id/test`, via `buildTestNotification()`), soit
par `routing/templates.js#renderNotification()` lors d'un dispatch
déclenché par une alerte (voir [Routing](#routing-phase-5d)) — chaque
provider le traduit ensuite au format attendu par son fournisseur
(embed Discord, message Telegram, payload Slack…).

## Modèle de configuration de provider

Table `notification_providers`. Plusieurs configurations du même `type`
sont supportées (ex : "Discord Production" + "Discord Staging", "SMTP
Admin" + "SMTP Developers") — pas de contrainte d'unicité sur `type`.

| Champ           | Type                    | Description                                                                                                                                           |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | string (requis)         | Nom lisible, ex. "Discord Production".                                                                                                                |
| `type`          | string (requis)         | Doit correspondre à un provider du registry (validé côté manager/routes, pas par le store lui-même).                                                  |
| `enabled`       | bool (défaut `true`)    | Non exploité côté orchestration (routing/queue, Phase 5C) — un provider `enabled: false` peut toujours être appelé directement via `send()`/`test()`. |
| `configuration` | objet JSON              | Champs publics du provider (ex. `fromEmail`, `username`).                                                                                             |
| `secrets`       | objet JSON, **chiffré** | Champs sensibles (mot de passe SMTP, webhook, bot token…). Jamais retourné en clair — voir [Secrets](#secrets).                                       |

`provider-store.js` reste indépendant du `ProviderRegistry` (pas de
dépendance circulaire store ↔ providers/) : la validation "ce type
existe bien" se fait plus haut (manager, routes), pas dans le store.

## Secrets

Le projet n'avait jusqu'ici que du hachage à sens unique (bcrypt, mots
de passe utilisateurs). Inadapté ici : ces secrets doivent être
déchiffrables pour être effectivement utilisés par un provider (mot de
passe SMTP, webhook Discord/Slack, bot token Telegram — voir
[Providers (Phase 5B)](#providers-phase-5b)). `lib/services/notifications/utils/crypto.js`
introduit donc AES-256-GCM (confidentialité + intégrité, IV aléatoire
par valeur chiffrée), utilisé uniquement pour ce besoin.

- Clé : `NOTIFICATIONS_ENCRYPTION_KEY` (voir [Configuration](#configuration-env)), dérivée en 32 octets via SHA-256.
- Si absente, une clé aléatoire est générée **en mémoire** au démarrage (même repli que `SESSION_SECRET`), avec un avertissement au démarrage — mais contrairement aux sessions, un redémarrage sans clé explicite rend **tous les secrets déjà stockés définitivement indéchiffrables**.
- `GET /api/notifications/providers` ne renvoie jamais les secrets : uniquement `hasSecrets` (booléen).
- `getDecryptedSecrets(id)` existe dans `provider-store.js` mais n'est exposé par aucune route pour l'instant (usage interne réservé à l'orchestration, Phase 5C) — les providers eux-mêmes (Phase 5B) reçoivent une config déjà déchiffrée, fournie par l'appelant.
- Chaque provider respecte la même règle au niveau du réseau : jamais de secret dans un log, jamais dans un message d'erreur renvoyé (`safeMessage` est toujours générique, voir [Providers (Phase 5B)](#providers-phase-5b)).
- `notification_history.metadata` ne doit **jamais** contenir de credentials — uniquement des détails d'exécution (code retour HTTP, extrait de réponse).

## Routing (Phase 5D)

Table `notification_routes` (`routing/route-store.js`), évaluée par
`routing/engine.js#RoutingEngine` à chaque transition d'alerte
(déclenchement, et résolution si `notifyOnResolve`).

| Champ             | Type                  | Description                                                                                                                                                                                                                                                                    |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`            | string (requis)       | Nom lisible.                                                                                                                                                                                                                                                                   |
| `enabled`         | bool (défaut `true`)  | Une règle désactivée n'est jamais évaluée (`routeStore.list({ enabledOnly: true })`).                                                                                                                                                                                          |
| `conditions`      | objet JSON            | `{ severity?, alertType?, process?, server?, tag? }`, chacun un tableau (vide/absent = toutes valeurs) — voir sémantique exacte ci-dessous.                                                                                                                                    |
| `providerIds`     | tableau d'ids         | Ids de `notification_providers` ciblés par la règle. Pas de FK SQL (même raison que `alert_rules.target_value`) : désactiver/supprimer un provider référencé ne casse pas la règle, il est juste ignoré au dispatch (voir [Limites connues](#limites-connues-de-cette-phase)). |
| `titleTemplate`   | string, nullable      | Voir [Templates](#templates-phase-5d). `null` = titre par défaut.                                                                                                                                                                                                              |
| `messageTemplate` | string, nullable      | Idem pour le message.                                                                                                                                                                                                                                                          |
| `notifyOnResolve` | bool (défaut `false`) | Si `true`, la règle notifie aussi à la résolution de l'alerte (en plus du déclenchement, toujours notifié si la règle matche).                                                                                                                                                 |

**Sémantique de `conditions`** (`routeMatches()` dans `routing/engine.js`) :

- `severity` : matche `alert.severity` (`info`/`warning`/`critical`).
- `alertType` : matche `alert.metric` (ex. `cpu`, `memory`, `disk`, `restart_count`, `status`) — c'est la métrique de la règle d'alerte à l'origine de l'occurrence, pas un champ dédié côté alerte.
- `process` : ne matche que les alertes `targetType: "process"`, et seulement si `alert.targetValue` (le nom du process) est dans la liste.
- `server` : ce moniteur est mono-hôte — ne matche que les alertes `targetType: "system"` (pas de notion de serveur distinct côté modèle d'alerte actuel). Accepté pour compatibilité future (déploiement multi-hôte).
- `tag` : les règles d'alerte (`alert_rules`) ne portent pas de tag dans le modèle actuel — un filtre `tag` non vide **ne matche donc jamais aucune alerte** pour l'instant (limitation connue, pas un bug).
- Plusieurs clés de `conditions` sont combinées en ET logique.

## Templates (Phase 5D)

`routing/templates.js#renderNotification(route, alert, event)` — sans
template sur la route (`titleTemplate`/`messageTemplate` à `null`), un
gabarit par défaut est généré à partir de l'alerte
(`defaultTitle()`/`defaultMessage()`). Avec un template, les
placeholders `{{nom}}` sont remplacés par les variables suivantes
(`buildVariables()`) — toutes dérivées uniquement de l'occurrence
d'alerte, **jamais** d'un secret de provider :

| Placeholder       | Source                                                                     |
| ----------------- | -------------------------------------------------------------------------- |
| `{{ruleName}}`    | `alert.ruleName`                                                           |
| `{{severity}}`    | `alert.severity`                                                           |
| `{{metric}}`      | `alert.metric`                                                             |
| `{{operator}}`    | `alert.operator`                                                           |
| `{{threshold}}`   | `alert.threshold`                                                          |
| `{{value}}`       | `alert.value` (valeur observée au moment du dispatch)                      |
| `{{targetType}}`  | `"process"` ou `"system"`                                                  |
| `{{targetValue}}` | nom du process, ou `"system"` si `targetType === "system"`                 |
| `{{state}}`       | état de l'occurrence (`active`, `resolved`…)                               |
| `{{event}}`       | `"triggered"` ou `"resolved"` — l'événement qui a causé ce dispatch précis |
| `{{alertId}}`     | id de l'occurrence (`alerts.id`)                                           |

Un placeholder inconnu (faute de frappe) est laissé tel quel dans le
texte plutôt que de faire échouer le rendu — une notification mal
formée vaut mieux qu'aucune notification.

## Notification Queue (Phase 5E)

`lib/services/notifications/dispatch-queue.js` (`NotificationDispatchQueue`)
— fiabilise la livraison sans jamais bloquer le monitoring PM2, le
WebSocket ni l'Alert Engine. S'appuie sur la file d'attente persistante déjà
existante (`lib/services/queue/`, Phase 1) sans en créer une seconde.

```text
Alert/Event
   ↓
RoutingEngine#dispatch()        (routing + templates, Phase 5D — inchangé)
   ↓
NotificationDispatchQueue#enqueue()   (dedup, rate limit, historique "pending")
   ↓
jobs (table SQL, PersistentQueue)     (retry + backoff exponentiel)
   ↓
NotificationDispatchQueue#handleJob() (worker : envoi + mise à jour historique)
   ↓
Provider (Phase 5B)
```

- **Job** : ne contient jamais de secret — uniquement `providerId`
  (référence vers `notification_providers`), `alertId`, le `notification`
  déjà rendu (titre/message) et l'id de la ligne d'historique associée. Les
  secrets déchiffrés ne sont récupérés qu'au moment de l'envoi, dans le
  worker (`providerStore.getDecryptedSecrets()`), jamais persistés dans la
  table `jobs`.
- **Retry + backoff** : réutilise tel quel le comportement de
  `PersistentQueue` (`lib/services/queue/persistent-queue.js`) — nombre
  maximal de tentatives et délai croissant entre chacune (configurable via
  `createQueue(name, { maxAttempts, backoffMs })`, par défaut 4 tentatives).
  `NotificationDispatchQueue` ne réimplémente pas cette logique ; il se
  contente de lancer une exception pour faire retenter la queue tant que la
  tentative n'est pas la dernière.
- **Rate limiting** : fenêtre glissante en mémoire, par provider
  (`{ windowMs, max }`, par défaut 60 envois/minute). Au-delà, la
  notification n'est pas mise en file — une ligne d'historique `failed`
  (`RATE_LIMITED`) est écrite immédiatement pour ne pas perdre la trace de
  l'événement.
- **Déduplication** : clé `providerId:alertId:event` (ex.
  `3:42:triggered`), fenêtre par défaut de 5 minutes — deux notifications
  identiques (même alerte, même transition, même provider) dans cette
  fenêtre sont regroupées : la seconde n'est ni mise en file ni tracée dans
  l'historique.
- **Historique évolutif** : contrairement à l'envoi direct (Phase 5D, qui
  écrit une seule ligne `success`/`failed` a posteriori), le mode queue crée
  d'abord une ligne `pending` à la mise en file, puis la fait évoluer via
  `historyStore.update()` (nouveau en Phase 5E) : `retrying` après chaque
  tentative infructueuse tant qu'il en reste, `success` ou `failed` à
  l'issue finale. `metadata.attempt` trace le numéro de la tentative.
- **Failure handling** : provider désactivé/supprimé ou type de provider
  inconnu → échec immédiat, définitif, sans consommer de tentative de
  retry (condition permanente, pas transitoire). Un provider qui lance une
  exception (au lieu de renvoyer `{ success: false }`) est traité comme un
  échec récupérable classique — jamais propagé à l'appelant.
- **Ne bloque jamais l'appelant** : `enqueue()` ne lance jamais, y compris
  si l'écriture de l'historique échoue (ex. base indisponible) — la mise en
  file continue, seule la traçabilité est dégradée (message dans les logs
  serveur).
- **Branchement** : `lib/services/notifications/index.js` instancie une
  `dispatchQueue` partagée et la passe à `routingEngine` — c'est donc le
  mode utilisé en production. `server.js` démarre le worker
  (`dispatchQueue.start()`, qui appelle d'abord
  `recoverStaleActiveJobs()` pour reprendre les jobs orphelins d'un arrêt
  brutal) et l'arrête proprement sur `SIGINT`. `RoutingEngine` accepte
  toujours d'être construit sans `dispatchQueue` (comportement Phase 5D,
  envoi direct synchrone) — c'est le cas des tests unitaires de
  `routing/engine.js`.

## Historique

Table `notification_history` (`history-store.js`) — écrite
automatiquement par `routing/engine.js#RoutingEngine`, soit directement
(mode Phase 5D, une ligne `success`/`failed` par couple règle matchée ×
provider ciblé), soit via la file d'attente (mode Phase 5E, voir
[Notification Queue](#notification-queue-phase-5e) — une ligne `pending`
puis mise à jour au fil des tentatives). Disponible en lecture/écriture
manuelle (`create`/`update`/`getById`/`list`) pour d'autres usages futurs.

| Champ            | Type              | Description                                                                                                                                                                                                                                                      |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providerId`     | int, nullable     | `ON DELETE SET NULL` — supprimer une config de provider ne fait pas disparaître l'historique déjà écrit.                                                                                                                                                         |
| `alertId`        | int, nullable     | `ON DELETE SET NULL` vers `alerts` — relie une notification à l'alerte qui l'a déclenchée.                                                                                                                                                                       |
| `status`         | string (requis)   | `pending`, `retrying`, `success` ou `failed`. `pending`/`retrying` uniquement en mode file d'attente (Phase 5E, voir [Notification Queue](#notification-queue-phase-5e)) ; en mode direct (Phase 5D, sans `dispatchQueue`) seuls `success`/`failed` sont écrits. |
| `timestamp`      | int               |                                                                                                                                                                                                                                                                  |
| `responseTimeMs` | int, optionnel    | Temps de réponse renvoyé par le provider, ou mesuré par le RoutingEngine à défaut.                                                                                                                                                                               |
| `errorCode`      | string, optionnel | Ex. `PROVIDER_NOT_FOUND`, `PROVIDER_DISABLED`, `UNKNOWN_PROVIDER_TYPE`, `INTERNAL_ERROR`, ou un code de `providers/shared.js` (`NETWORK_ERROR`, `TIMEOUT`…).                                                                                                     |
| `metadata`       | objet JSON        | Non renseigné par le RoutingEngine à ce stade — réservé à un usage futur. Jamais de credentials.                                                                                                                                                                 |

## API REST

Toutes les routes sont sous `/api/notifications`. CRUD complet des
providers et test HTTP depuis la Phase 5C ; CRUD des règles de routing
(`/routes`) et lecture de l'historique (`/history`) depuis la Phase 5D.

| Méthode | Route                                   | Permission              | Description                                                                                                                                                                                                                                                                               |
| ------- | --------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET     | `/api/notifications/provider-types`     | `notifications_read`    | Catalogue des types de providers connus (`type`, `label`, `implemented: true`).                                                                                                                                                                                                           |
| GET     | `/api/notifications/providers`          | `notifications_read`    | Liste les configurations enregistrées. `?type=` filtre par type (`400` si type inconnu du registry). Ne renvoie jamais les secrets (`hasSecrets` uniquement).                                                                                                                             |
| GET     | `/api/notifications/providers/:id`      | `notifications_read`    | Détail d'une configuration (`404` si absente). Mêmes garanties que la liste : jamais de secret en clair.                                                                                                                                                                                  |
| POST    | `/api/notifications/providers`          | `notifications_create`  | Crée une configuration. Body : `{ name, type, enabled?, fields }` — `fields` fusionne champs publics et secrets, scindés côté serveur via `provider.secretFields` (voir [Secrets](#secrets)). `400` si `type` inconnu ou si la configuration ne passe pas `validateConfig()` du provider. |
| PATCH   | `/api/notifications/providers/:id`      | `notifications_update`  | Modification partielle. `fields` omis = configuration/secrets inchangés ; un champ secret absent de `fields` = credential conservé (case "Keep existing credential" côté UI) ; présent (même vide) = remplacé. Le `type` ne peut pas être changé (`400`). `404` si absente.               |
| PUT     | `/api/notifications/providers/:id`      | `notifications_update`  | Même contrat que PATCH (remplacement complet recommandé côté appelant : fournir tous les `fields`).                                                                                                                                                                                       |
| DELETE  | `/api/notifications/providers/:id`      | `notifications_delete`  | Supprime la configuration. `404` si absente.                                                                                                                                                                                                                                              |
| POST    | `/api/notifications/providers/:id/test` | `notifications_test`    | Envoie réellement une notification de test avec la configuration stockée (secrets déchiffrés en mémoire pour cet appel uniquement). Réponse = résultat normalisé du provider (`success`, `safeMessage`/`errorCode`…, jamais de secret). `404` si absente.                                 |
| GET     | `/api/notifications/routes`             | `notifications_read`    | Liste les règles de routing. `?enabledOnly=1` filtre les règles activées.                                                                                                                                                                                                                 |
| GET     | `/api/notifications/routes/:id`         | `notifications_read`    | Détail d'une règle (`404` si absente).                                                                                                                                                                                                                                                    |
| POST    | `/api/notifications/routes`             | `notifications_manage`  | Crée une règle. Body : `{ name, enabled?, conditions?, providerIds?, titleTemplate?, messageTemplate?, notifyOnResolve? }` (voir [Routing](#routing-phase-5d)). `400` si `name` absent ou si un champ a le mauvais type.                                                                  |
| PATCH   | `/api/notifications/routes/:id`         | `notifications_manage`  | Modification partielle — seuls les champs fournis sont changés. `404` si absente.                                                                                                                                                                                                         |
| PUT     | `/api/notifications/routes/:id`         | `notifications_manage`  | Même contrat que PATCH.                                                                                                                                                                                                                                                                   |
| DELETE  | `/api/notifications/routes/:id`         | `notifications_manage`  | Supprime la règle. `404` si absente.                                                                                                                                                                                                                                                      |
| GET     | `/api/notifications/history`            | `notifications_history` | Liste l'historique d'envoi, plus récent d'abord. Filtres `?providerId=`, `?alertId=`, `?status=`, `?limit=` (1 à 500, défaut 50). Ne renvoie jamais de secret (voir [Historique](#historique)).                                                                                           |

## Permissions

Réutilise le système existant (`lib/permissions.js`, `hasPermission()`),
sans nouveau mécanisme. Action **globale** (pas liée à une app précise),
même raisonnement que `alerts_*`/`events_read` :

| Action                  | Description                                                | Vérifiée par une route à ce stade ? |
| ----------------------- | ---------------------------------------------------------- | ----------------------------------- |
| `notifications_read`    | Voir les providers, leurs types, et les règles de routing. | Oui                                 |
| `notifications_create`  | Créer une configuration de provider.                       | Oui (Phase 5C)                      |
| `notifications_update`  | Modifier une configuration de provider.                    | Oui (Phase 5C)                      |
| `notifications_delete`  | Supprimer une configuration de provider.                   | Oui (Phase 5C)                      |
| `notifications_test`    | Envoyer une notification de test avec une configuration.   | Oui (Phase 5C)                      |
| `notifications_history` | Voir l'historique détaillé des notifications envoyées.     | Oui (Phase 5D, GET /history)        |
| `notifications_manage`  | Gérer les règles de routing des notifications.             | Oui (Phase 5D, CRUD /routes)        |

Toutes déclarées dès la Phase 5A pour que le jeu de permissions complet
soit disponible aux admins sans exiger une nouvelle migration de
permissions à chaque sous-phase suivante.

```bash
node bin/manage-users.js grant <username> "*" notifications_read
```

## Configuration (.env)

```bash
# Clé de chiffrement des secrets de providers de notification (SMTP
# password, webhook Discord/Slack, bot token Telegram…). Dérivée en 32
# octets via SHA-256 — accepte n'importe quelle chaîne, pas seulement un
# hex de 64 caractères. Si absente, une clé aléatoire est générée en
# mémoire au démarrage (avertissement affiché) : tout secret déjà stocké
# devient alors illisible au prochain redémarrage. À définir avant de
# stocker une vraie configuration de provider (le CRUD persistant arrive
# en Phase 5C — les providers Phase 5B peuvent déjà être appelés
# directement avec une config en mémoire, sans passer par le store).
NOTIFICATIONS_ENCRYPTION_KEY=
```

Voir `.env.example` à la racine du projet. Contrairement à
`SESSION_SECRET`, cette variable n'a aucun impact tant qu'aucune
configuration de provider n'est réellement persistée (pas de CRUD
exposé en HTTP à ce stade) — mais mieux vaut la fixer dès maintenant
plutôt que d'oublier au moment de la Phase 5C.

## Migration

```text
version : 006_notifications
up      : crée notification_providers, notification_routes,
          notification_history (+ index dédiés)
down    : DROP TABLE notification_history, puis notification_routes,
          puis notification_providers (ordre FK-safe pour MySQL/InnoDB)

version : 007_notification_routing_templates
up      : ALTER TABLE notification_routes ADD COLUMN
          title_template, message_template, notify_on_resolve
down    : DROP COLUMN des 3 mêmes colonnes (MySQL et SQLite >= 3.35,
          pas de contournement "recréer la table" nécessaire)

rollback : node bin/migrate.js down            # annule 007 seule
           node bin/migrate.js down --steps 2  # annule aussi 006
           node bin/migrate.js down --steps 7  # annule tout (001 à 007)
```

`up` est idempotent pour 006 (`CREATE TABLE IF NOT EXISTS`) ; 007
(`ALTER TABLE ADD COLUMN`) ne l'est pas nativement — relancer `up` sur
une base où 007 est déjà appliquée est sans effet car `migrator.js` ne
rejoue jamais une version déjà dans `schema_migrations` (voir
`lib/db/migrator.js#status`). `down` est destructif (perte des
configurations de providers, des règles de routing et de tout
historique déjà écrit) — à réserver au développement/tests.

## Ajouter un provider

1. Créer `lib/services/notifications/providers/<type>.js`, classe
   étendant `NotificationProvider` (`types.js`) et implémentant
   `validateConfig()` + `send()` (obligatoires), `healthCheck()`
   (optionnel — uniquement si le fournisseur a une vérification de
   connectivité distincte d'un envoi). `test()` a une implémentation par
   défaut dans la classe de base : pas besoin de la surcharger sauf
   besoin spécifique.
2. Réutiliser `providers/shared.js` pour les résultats normalisés
   (`successResult`/`failureResult`), le fetch avec timeout
   (`fetchWithTimeout`) et la classification d'erreurs
   (`classifyHttpStatus`/`classifyFetchError`) — ne jamais renvoyer un
   message d'erreur brut (voir [Providers (Phase 5B)](#providers-phase-5b)).
3. L'ajouter à `lib/services/notifications/providers/index.js`.
4. Rien d'autre à modifier : le registry, le manager et les routes
   restent inchangés (voir [Provider Registry](#provider-registry)).
5. Documenter dans `docs/notifications/providers/<type>.md` (configuration,
   prérequis, sécurité, test, erreurs communes) et ajouter une ligne au
   tableau de la section [Providers (Phase 5B)](#providers-phase-5b).
6. Tester avec des mocks uniquement (`global.fetch`, ou `nodemailer` via
   `t.mock.method` pour l'email) — voir `test/unit/notifications-providers.test.js`.
   Aucun appel réseau réel dans la CI.

## Intégration & Sécurité (Phase 5F)

Connecte proprement tout ce qui précède, sans rien y ajouter de nouveau
côté modèle de données.

```text
AlertEngine.evaluate()  (lib/services/alerts/, inchangé)
   ↓ transition trigger->active ou ->resolved détectée par lib/alert-dispatch.js
RoutingEngine.dispatch(alert, event)          (Phase 5D : routing + templates)
   ↓
NotificationDispatchQueue.enqueue()           (Phase 5E : dedup + rate limit + historique "pending")
   ↓
jobs (table SQL)                              (Phase 1 : retry + backoff exponentiel)
   ↓
NotificationDispatchQueue.handleJob()         (Phase 5E : envoi + historique final)
   ↓
Provider.send()                               (Phase 5B : Email/Discord/Telegram/Slack/Webhook)
   ↓
notification_history                          (traçabilité complète, jamais de secret)
```

Ce branchement existait déjà à l'issue de la Phase 5E (`lib/alert-dispatch.js`
appelle `notificationRoutingEngine.dispatch()` sur chaque transition, qui
délègue à `dispatchQueue` — voir [Notification Queue](#notification-queue-phase-5e)).
La Phase 5F n'a rien changé à ce câblage : elle l'a **audité et testé
comme un tout**.

### Audit de sécurité (Phase 5F)

`test/integration/notifications-security-audit.test.js` — cherche
explicitement un secret marqueur dans : réponses API (`POST`/`GET`/`PATCH`
`/providers`), réponses d'erreur (validation, 404), résultat de
`POST /providers/:id/test` même en échec, la colonne `secrets` de
`notification_providers` (doit être chiffrée, jamais en clair), les lignes
`notification_history`, et la colonne `payload` des `jobs` de la queue de
dispatch. Confirme aussi que le secret déchiffré est bien transmis au
provider au moment de l'envoi (le seul endroit légitime). Aucune fuite
trouvée dans aucun de ces canaux.

### Audit de permissions (Phase 5F)

`test/integration/notifications-permission-audit.test.js` — matrice
exhaustive : les 15 endpoints REST de `lib/routes/notifications.js`
croisés avec les 7 permissions `notifications_read/create/update/delete/
test/history/manage` (voir [Permissions](#permissions)). Pour chaque
endpoint : refusé sans aucune permission, refusé avec seulement une
permission adjacente (ex. `notifications_read` seul ne doit pas donner
accès à `POST /providers`), accepté avec exactement la permission requise.
Vérifie aussi qu'un `appName: "*"` ne donne pas accès à une action non
accordée (pas de wildcard implicite sur l'action côté
`lib/permissions.js#hasPermission`).

### Anti-spam (Phase 5F)

`test/integration/notifications-spam.test.js` — confirme les deux
protections qui s'appliquent en production :

1. **Côté Alert Engine** (déjà existant, indépendant des notifications) :
   `dispatch()` n'est appelé qu'à la _transition_ trigger→active, jamais à
   chaque tick où la condition reste vraie — 100 évaluations consécutives
   à condition constante ne produisent qu'une seule notification.
2. **Côté dispatch-queue** (Phase 5E) : déduplication (deux dispatches
   identiques regroupés) et rate limiting (une avalanche de 1000
   occurrences distinctes visant le même provider est plafonnée au
   maximum configuré, jamais 1000 envois réels).

### Scénarios de panne (Phase 5F)

`test/integration/notifications-failure-scenarios.test.js` — avec les
vrais providers (Phase 5B) et uniquement `global.fetch`/`nodemailer`
mockés (jamais d'appel réseau réel en CI) : SMTP down, Discord down,
Telegram timeout, Slack réponse invalide, Webhook injoignable — dans tous
les cas, `notification_history` trace l'échec et **aucune exception ne
remonte** au-delà de `dispatch()`/`processOne()`. Redémarrage de la queue
(job resté `active` après un arrêt brutal, repris par
`recoverStaleActiveJobs()`) et base indisponible pendant l'écriture
d'historique (dégradé mais jamais bloquant, voir
`NotificationDispatchQueue#enqueue`) sont également couverts.

### Test end-to-end (Phase 5F)

`test/integration/notifications-e2e.test.js` — rejoue le scénario complet
de la tâche (métrique dépasse le seuil → alerte déclenchée → routing
matché → notification créée → queue → provider → notification envoyée →
historique) avec de vrais stores/moteurs sur SQLite, plus la résolution
d'alerte (avec/sans `notifyOnResolve`) et un provider en panne qui
n'empêche pas une évaluation d'alerte indépendante de fonctionner
normalement ensuite.

## Limites connues de cette phase

- **File d'attente / retry (Phase 5E)** : `RoutingEngine.dispatch()` peut
  désormais déléguer l'envoi à `lib/services/notifications/dispatch-queue.js`
  (voir [Notification Queue (Phase 5E)](#notification-queue-phase-5e))
  plutôt que d'appeler `provider.send()` en direct — retry + backoff
  exponentiel, rate limiting et déduplication. C'est la file utilisée en
  production (branchée via `lib/services/notifications/index.js` et
  démarrée dans `server.js`) ; le mode direct (comportement historique de
  la Phase 5D) reste disponible pour tout appelant qui veut un résultat
  synchrone (c'est celui utilisé par les tests unitaires de
  `routing/engine.js` qui ne fournissent pas de `dispatchQueue`).
- **Anti-spam à deux niveaux** :
  (trigger→active, →resolved), jamais à chaque tick d'évaluation — la
  déduplication/cooldown déjà en place dans
  `lib/services/alerts/engine.js` protège donc aussi les notifications,
  sans code de rate-limiting dédié côté notifications dans cette phase.
- **`tag` dans `conditions` ne matche jamais** : le modèle de règle
  d'alerte actuel (`alert_rules`) ne porte pas de tag — voir
  [Routing](#routing-phase-5d).
- **`server` dans `conditions`** : accepté pour compatibilité future
  (déploiement multi-hôte), mais ce moniteur reste mono-hôte — seules
  les cibles `system` peuvent matcher un filtre `server` non vide, il
  n'y a pas de distinction entre plusieurs hôtes.
- **Détection de transition sans modifier `AlertEngine`** :
  `lib/alert-dispatch.js` détecte qu'une occurrence "vient de" passer active en comparant
  `triggeredAt === lastSeenAt` sur le résultat d'`evaluate()` (les deux
  ne sont égaux qu'au tick de la transition trigger→active, voir
  `engine.js#trigger`) plutôt que par un événement explicite émis par
  l'Alert Engine — un choix délibéré pour ne pas changer le contrat de
  retour d'`evaluate()` (testé indépendamment,
  `test/unit/alert-engine.test.js`) ni coupler les deux services.
- `providerIds` sur une route n'a pas de contrainte FK SQL (même raison
  que `alert_rules.target_value`) : supprimer/désactiver un provider
  référencé par une règle ne bloque pas l'opération — au dispatch, ce
  provider produit simplement une ligne d'historique `failed`
  (`PROVIDER_NOT_FOUND`/`PROVIDER_DISABLED`) sans bloquer les autres
  providers de la même règle.
- `notification_history.metadata` reste `null` en mode direct (Phase 5D,
  sans `dispatchQueue`) ; en mode file d'attente (Phase 5E), il contient
  uniquement `{ attempt: <n> }` — pas encore d'extrait de réponse HTTP du
  provider, laissé pour un usage futur.
- **Rate limit et déduplication en mémoire** (`dispatch-queue.js`) : non
  partagés entre plusieurs instances du process (déploiement multi-process
  hors scope de ce moniteur self-hosted mono-instance) et réinitialisés à
  chaque redémarrage — contrairement aux jobs eux-mêmes (persistés dans la
  table `jobs`), aucune perte de données possible, seulement un
  sur-envoi ponctuel dans le pire cas (redémarrage pile pendant une
  avalanche d'alertes).
- Le champ `to` du provider email (destinataire(s)) reste une extension
  pragmatique posée en Phase 5B — hors de la liste stricte des champs
  de la tâche mais indispensable pour qu'un envoi SMTP soit possible.
- Le gabarit `payload` du webhook générique (`providers/webhook.js`)
  garde sa propre syntaxe de substitution (`{{title}}`, `{{message}}`,
  `{{severity}}`, `{{timestamp}}`, `{{url}}`) — distincte du moteur de
  templates de route (`routing/templates.js`, [Templates](#templates-phase-5d)) : le premier s'applique au payload brut envoyé au
  webhook, le second au `notification` de haut niveau construit à
  partir de l'alerte avant d'atteindre n'importe quel provider.
- `type` sur `notification_providers` n'est pas contraint par une clé
  étrangère vers le registry (contrôle applicatif uniquement) : une
  configuration peut techniquement référencer un type qui n'est plus
  enregistré si un provider est retiré du code — au dispatch, ce
  provider produit une ligne d'historique `failed`
  (`UNKNOWN_PROVIDER_TYPE`).
