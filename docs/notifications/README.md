# Notification system — Phase 5A (fondations) + Phase 5B (providers)

Phase 5A a posé l'architecture, les modèles de données et le registry
des providers du système de notifications (Email/Discord/Telegram/
Slack/Webhook générique). **Phase 5B implémente l'envoi réel** pour ces
cinq providers (`validateConfig()`/`test()`/`send()`, `healthCheck()`
pour email et telegram). Le routing par règles (`notification_routes`),
l'écriture automatique de l'historique (`notification_history`), la
file d'attente/retry et l'intégration avec le moteur d'alertes
(`lib/services/alerts/`) restent hors scope et sont prévus en Phase 5C,
de même que l'interface d'administration complète et le CRUD HTTP des
providers.

## Sommaire

- [Architecture](#architecture)
- [Provider Registry](#provider-registry)
- [Providers (Phase 5B)](#providers-phase-5b)
- [Modèle de configuration de provider](#modèle-de-configuration-de-provider)
- [Secrets](#secrets)
- [Modèle de routing (à venir)](#modèle-de-routing-à-venir)
- [Modèle d'historique (à venir)](#modèle-dhistorique-à-venir)
- [API REST](#api-rest)
- [Permissions](#permissions)
- [Configuration (.env)](#configuration-env)
- [Migration](#migration)
- [Ajouter un provider](#ajouter-un-provider)
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
│   └── route-store.js      # CRUD table notification_routes (modèle seul, aucun moteur d'évaluation)
└── utils/
    └── crypto.js           # chiffrement AES-256-GCM des secrets au repos

lib/routes/notifications.js   # routeur Express (/api/notifications/…), aucune logique métier dedans
lib/db/migrations/006_notifications.js   # tables notification_providers, notification_routes, notification_history
docs/notifications/providers/   # un fichier par provider (configuration, sécurité, tests, erreurs)
```

Même découpage que `lib/services/alerts/` et `lib/services/events/` :
`lib/services/notifications/index.js` exporte un singleton (`registry`,
`manager`, `providerStore`, `routeStore`, `historyStore`) partagé par
`lib/routes/notifications.js` — un seul registry en mémoire pour tout le
process.

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

| Provider  | Fichier                     | Doc                                                       | `healthCheck()` |
|-----------|------------------------------|------------------------------------------------------------|--------------------|
| Email/SMTP | `providers/email.js`          | [providers/email.md](./providers/email.md)                  | Oui (`verify()`)     |
| Discord    | `providers/discord.js`         | [providers/discord.md](./providers/discord.md)               | Oui (GET webhook)     |
| Telegram   | `providers/telegram.js`         | [providers/telegram.md](./providers/telegram.md)              | Oui (`getMe()`)         |
| Slack      | `providers/slack.js`             | [providers/slack.md](./providers/slack.md)                     | Non (webhook Slack sans introspection GET utile) |
| Webhook générique | `providers/webhook.js`    | [providers/webhook.md](./providers/webhook.md)                  | Non (dépend du système externe) |

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

Notification envoyée par `send(notification, config)` : objet libre
`{ title, message, severity, url? }` — le format exact (routing par
règles, templates) est prévu en Phase 5C ; cette phase se contente de le
transmettre tel quel au format attendu par chaque fournisseur.

## Modèle de configuration de provider

Table `notification_providers`. Plusieurs configurations du même `type`
sont supportées (ex : "Discord Production" + "Discord Staging", "SMTP
Admin" + "SMTP Developers") — pas de contrainte d'unicité sur `type`.

| Champ           | Type                    | Description                                                        |
|------------------|--------------------------|------------------------------------------------------------------------|
| `name`            | string (requis)           | Nom lisible, ex. "Discord Production".                                |
| `type`            | string (requis)           | Doit correspondre à un provider du registry (validé côté manager/routes, pas par le store lui-même). |
| `enabled`         | bool (défaut `true`)      | Non exploité côté orchestration (routing/queue, Phase 5C) — un provider `enabled: false` peut toujours être appelé directement via `send()`/`test()`. |
| `configuration`   | objet JSON                | Champs publics du provider (ex. `fromEmail`, `username`).             |
| `secrets`         | objet JSON, **chiffré**   | Champs sensibles (mot de passe SMTP, webhook, bot token…). Jamais retourné en clair — voir [Secrets](#secrets). |

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

## Modèle de routing (à venir)

Table `notification_routes` (`routing/route-store.js`) — modèle de
données seul, **aucun moteur d'évaluation ne lit encore cette table**.

| Champ          | Type                     | Description                                                    |
|-----------------|----------------------------|--------------------------------------------------------------------|
| `name`           | string (requis)             | Nom lisible.                                                       |
| `enabled`        | bool (défaut `true`)        |                                                                      |
| `conditions`     | objet JSON                  | Libre : `{ severity?, alertType?, process?, server?, tag? }`, chacun un tableau (vide/absent = toutes valeurs). |
| `providerIds`    | tableau d'ids               | Ids de `notification_providers`. Pas de FK SQL — validation applicative, pour ne pas empêcher de désactiver un provider référencé par une règle. |

## Modèle d'historique (à venir)

Table `notification_history` (`history-store.js`) — modèle de données
seul, rien n'y écrit encore automatiquement (écriture automatique liée à
l'orchestration `NotificationManager.send()`, prévue en Phase 5C).

| Champ            | Type    | Description                                                        |
|--------------------|-----------|-------------------------------------------------------------------------|
| `providerId`         | int, nullable | `ON DELETE SET NULL` — supprimer une config de provider ne fait pas disparaître l'historique déjà écrit. |
| `alertId`            | int, nullable | `ON DELETE SET NULL` vers `alerts` — relie une notification à l'alerte qui l'a déclenchée, sans dépendance dure. |
| `status`             | string (requis) | Ex. `success`, `failed`.                                              |
| `timestamp`          | int          |                                                                          |
| `responseTimeMs`     | int, optionnel |                                                                        |
| `errorCode`          | string, optionnel |                                                                     |
| `metadata`           | objet JSON   | Détails d'exécution uniquement — jamais de credentials.                |

## API REST

Toutes les routes sont sous `/api/notifications`. Depuis la Phase 5C, le
CRUD complet des providers et le test HTTP d'une configuration sont
exposés. L'historique détaillé (`GET /history`) et le routing (CRUD
`/routes`) restent prévus en Phase 5D/5E.

| Méthode | Route                                       | Permission              | Description |
|----------|---------------------------------------------|--------------------------|----------------|
| GET      | `/api/notifications/provider-types`         | `notifications_read`      | Catalogue des types de providers connus (`type`, `label`, `implemented: true`). |
| GET      | `/api/notifications/providers`              | `notifications_read`      | Liste les configurations enregistrées. `?type=` filtre par type (`400` si type inconnu du registry). Ne renvoie jamais les secrets (`hasSecrets` uniquement). |
| GET      | `/api/notifications/providers/:id`          | `notifications_read`      | Détail d'une configuration (`404` si absente). Mêmes garanties que la liste : jamais de secret en clair. |
| POST     | `/api/notifications/providers`              | `notifications_create`    | Crée une configuration. Body : `{ name, type, enabled?, fields }` — `fields` fusionne champs publics et secrets, scindés côté serveur via `provider.secretFields` (voir [Secrets](#secrets)). `400` si `type` inconnu ou si la configuration ne passe pas `validateConfig()` du provider. |
| PATCH    | `/api/notifications/providers/:id`          | `notifications_update`    | Modification partielle. `fields` omis = configuration/secrets inchangés ; un champ secret absent de `fields` = credential conservé (case "Keep existing credential" côté UI) ; présent (même vide) = remplacé. Le `type` ne peut pas être changé (`400`). `404` si absente. |
| PUT      | `/api/notifications/providers/:id`          | `notifications_update`    | Même contrat que PATCH (remplacement complet recommandé côté appelant : fournir tous les `fields`). |
| DELETE   | `/api/notifications/providers/:id`          | `notifications_delete`    | Supprime la configuration. `404` si absente. |
| POST     | `/api/notifications/providers/:id/test`     | `notifications_test`      | Envoie réellement une notification de test avec la configuration stockée (secrets déchiffrés en mémoire pour cet appel uniquement). Réponse = résultat normalisé du provider (`success`, `safeMessage`/`errorCode`…, jamais de secret). `404` si absente. |

## Permissions

Réutilise le système existant (`lib/permissions.js`, `hasPermission()`),
sans nouveau mécanisme. Action **globale** (pas liée à une app précise),
même raisonnement que `alerts_*`/`events_read` :

| Action                    | Description                                                | Vérifiée par une route à ce stade ? |
|-----------------------------|------------------------------------------------------------|------------------------------------------|
| `notifications_read`          | Voir les providers, leurs types et l'historique d'envoi.     | Oui                                        |
| `notifications_create`        | Créer une configuration de provider.                         | Oui (Phase 5C)                             |
| `notifications_update`        | Modifier une configuration de provider.                      | Oui (Phase 5C)                             |
| `notifications_delete`        | Supprimer une configuration de provider.                     | Oui (Phase 5C)                             |
| `notifications_test`          | Envoyer une notification de test avec une configuration.     | Oui (Phase 5C)                             |
| `notifications_history`       | Voir l'historique détaillé des notifications envoyées.       | Non — prévu Phase 5D/5E                    |
| `notifications_manage`        | Gérer les règles de routing des notifications.               | Non — prévu Phase 5D                       |

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
rollback : node bin/migrate.js down            # annule 006_notifications seule
           node bin/migrate.js down --steps 6  # annule aussi 001 à 005
```

`up` est idempotent (`CREATE TABLE IF NOT EXISTS`) : relancer `node
bin/migrate.js up` sur une base déjà à jour ne fait rien. `down` est
destructif (perte des configurations de providers et de tout historique
déjà écrit) — à réserver au développement/tests.

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

## Limites connues de cette phase

- L'orchestration multi-provider (`NotificationManager.send()`) reste
  hors scope : appeler un provider se fait directement
  (`registry.getProvider(type).send(notification, config)`), sans
  passer par le routing/la queue — prévus en Phase 5C.
- Le routing (`notification_routes`) et l'historique
  (`notification_history`) ne sont que des modèles de données — rien ne
  les lit ni n'y écrit automatiquement.
- Aucune route HTTP n'expose encore `test()`/`send()` : les providers
  sont opérationnels au niveau du code (Phase 5B), mais rien n'est
  configurable via l'UI ou l'API pour l'instant (CRUD providers, test
  HTTP, prévus Phase 5C).
- Le champ `to` du provider email (destinataire(s)) est une extension
  pragmatique de cette phase — hors de la liste stricte des champs de la
  tâche (host/port/security/username/password/fromName/fromEmail) mais
  indispensable pour qu'un envoi SMTP soit possible ; le routing par
  règles qui déterminera dynamiquement les destinataires reste prévu en
  Phase 5C.
- Le gabarit `payload` du webhook générique est une simple substitution
  de chaînes (`{{title}}`, `{{message}}`, `{{severity}}`, `{{timestamp}}`,
  `{{url}}`) — pas un moteur de templates avancé (hors scope).
- `type` sur `notification_providers` n'est pas contraint par une clé
  étrangère vers le registry (contrôle applicatif uniquement) : une
  configuration peut techniquement référencer un type qui n'est plus
  enregistré si un provider est retiré du code — traité comme absent du
  catalogue, pas comme une erreur bloquante.
- `providerIds` sur une route n'a pas de contrainte FK SQL (même raison
  que `alert_rules.target_value`) : supprimer un provider référencé par
  une règle ne bloque pas la suppression, ne casse pas la règle non plus
  (le routing engine, absent ici, devra ignorer les ids invalides le
  moment venu).
