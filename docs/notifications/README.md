# Notification system — Phase 5A (fondations)

Phase 5A du projet : architecture, modèles de données et registry des
providers du futur système de notifications (Email/Discord/Telegram/
Slack/Webhook générique). **Aucun envoi réel n'existe encore dans cette
phase** — les providers sont des placeholders qui valident une
configuration mais lèvent une erreur explicite sur `send()`/`test()`. Le
routing par règles (`notification_routes`), l'historique automatique
(`notification_history`), la file d'attente et l'intégration avec le
moteur d'alertes (`lib/services/alerts/`) sont prévus pour les
sous-phases suivantes (5B : providers réels, 5C : CRUD complet, secrets,
routing engine).

## Sommaire

- [Architecture](#architecture)
- [Provider Registry](#provider-registry)
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
├── types.js               # classe abstraite NotificationProvider (validateConfig/test/send)
├── provider-store.js      # CRUD table notification_providers, secrets chiffrés
├── history-store.js       # CRUD table notification_history (modèle seul, rien n'écrit encore automatiquement)
├── providers/
│   ├── index.js            # liste des providers à enregistrer au démarrage
│   ├── email.js             # placeholder — validateConfig() seulement
│   ├── discord.js
│   ├── telegram.js
│   ├── slack.js
│   └── webhook.js
├── routing/
│   └── route-store.js      # CRUD table notification_routes (modèle seul, aucun moteur d'évaluation)
└── utils/
    └── crypto.js           # chiffrement AES-256-GCM des secrets au repos

lib/routes/notifications.js   # routeur Express (/api/notifications/…), aucune logique métier dedans
lib/db/migrations/006_notifications.js   # tables notification_providers, notification_routes, notification_history
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
type            # identifiant unique, ex: "discord"
validateConfig() # retourne un tableau d'erreurs (jamais d'exception)
test()           # non implémenté en Phase 5A — prévu en Phase 5C
send()           # non implémenté en Phase 5A — prévu en Phase 5C
```

Cinq providers sont déjà enregistrés comme placeholders : `email`,
`discord`, `telegram`, `slack`, `webhook`. Seul `validateConfig()` est
opérationnel pour l'instant.

## Modèle de configuration de provider

Table `notification_providers`. Plusieurs configurations du même `type`
sont supportées (ex : "Discord Production" + "Discord Staging", "SMTP
Admin" + "SMTP Developers") — pas de contrainte d'unicité sur `type`.

| Champ           | Type                    | Description                                                        |
|------------------|--------------------------|------------------------------------------------------------------------|
| `name`            | string (requis)           | Nom lisible, ex. "Discord Production".                                |
| `type`            | string (requis)           | Doit correspondre à un provider du registry (validé côté manager/routes, pas par le store lui-même). |
| `enabled`         | bool (défaut `true`)      | Non exploité tant que l'envoi n'existe pas (Phase 5B/5C).             |
| `configuration`   | objet JSON                | Champs publics du provider (ex. `fromEmail`, `username`).             |
| `secrets`         | objet JSON, **chiffré**   | Champs sensibles (mot de passe SMTP, webhook, bot token…). Jamais retourné en clair — voir [Secrets](#secrets). |

`provider-store.js` reste indépendant du `ProviderRegistry` (pas de
dépendance circulaire store ↔ providers/) : la validation "ce type
existe bien" se fait plus haut (manager, routes), pas dans le store.

## Secrets

Le projet n'avait jusqu'ici que du hachage à sens unique (bcrypt, mots
de passe utilisateurs). Inadapté ici : ces secrets doivent être
déchiffrables pour être effectivement utilisés par un provider (Phase
5B/5C). `lib/services/notifications/utils/crypto.js` introduit donc
AES-256-GCM (confidentialité + intégrité, IV aléatoire par valeur
chiffrée), utilisé uniquement pour ce besoin.

- Clé : `NOTIFICATIONS_ENCRYPTION_KEY` (voir [Configuration](#configuration-env)), dérivée en 32 octets via SHA-256.
- Si absente, une clé aléatoire est générée **en mémoire** au démarrage (même repli que `SESSION_SECRET`), avec un avertissement au démarrage — mais contrairement aux sessions, un redémarrage sans clé explicite rend **tous les secrets déjà stockés définitivement indéchiffrables**.
- `GET /api/notifications/providers` ne renvoie jamais les secrets : uniquement `hasSecrets` (booléen).
- `getDecryptedSecrets(id)` existe dans `provider-store.js` mais n'est exposé par aucune route en Phase 5A (usage interne réservé à l'envoi réel, Phase 5B/5C).
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
seul, rien n'y écrit encore automatiquement (Phase 5B branchera
l'écriture réelle au moment de l'envoi).

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

Toutes les routes sont sous `/api/notifications`. **Seuls deux GET
existent dans cette phase** — le CRUD complet des providers
(POST/PUT/DELETE), le test de configuration (`POST
/providers/:id/test`), l'historique détaillé (`GET /history`) et le
routing (CRUD `/routes`) sont prévus en Phase 5B/5C. Les permissions
correspondantes existent déjà dans `lib/permissions.js` pour éviter une
migration de permissions supplémentaire à ce moment-là.

| Méthode | Route                                | Permission            | Description |
|----------|-----------------------------------------|--------------------------|----------------|
| GET      | `/api/notifications/provider-types`       | `notifications_read`      | Catalogue des types de providers connus (`type`, `label`, `implemented: false` en Phase 5A). |
| GET      | `/api/notifications/providers`             | `notifications_read`      | Liste les configurations enregistrées. `?type=` filtre par type (`400` si type inconnu du registry). Ne renvoie jamais les secrets (`hasSecrets` uniquement). |

## Permissions

Réutilise le système existant (`lib/permissions.js`, `hasPermission()`),
sans nouveau mécanisme. Action **globale** (pas liée à une app précise),
même raisonnement que `alerts_*`/`events_read` :

| Action                    | Description                                                | Vérifiée par une route en Phase 5A ? |
|-----------------------------|------------------------------------------------------------|------------------------------------------|
| `notifications_read`          | Voir les providers, leurs types et l'historique d'envoi.     | Oui                                        |
| `notifications_create`        | Créer une configuration de provider.                         | Non — prévu Phase 5C                       |
| `notifications_update`        | Modifier une configuration de provider.                      | Non — prévu Phase 5C                       |
| `notifications_delete`        | Supprimer une configuration de provider.                     | Non — prévu Phase 5C                       |
| `notifications_test`          | Envoyer une notification de test avec une configuration.     | Non — prévu Phase 5C                       |
| `notifications_history`       | Voir l'historique détaillé des notifications envoyées.       | Non — prévu Phase 5B/5C                    |
| `notifications_manage`        | Gérer les règles de routing des notifications.               | Non — prévu Phase 5B/5C                    |

Toutes déclarées dès maintenant pour que le jeu de permissions complet
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
# configurer un vrai provider (Phase 5C) — cette phase ne fait qu'établir
# l'abstraction, aucun provider n'est encore configurable via l'UI.
NOTIFICATIONS_ENCRYPTION_KEY=
```

Voir `.env.example` à la racine du projet. Contrairement à
`SESSION_SECRET`, cette variable n'a aucun impact tant qu'aucune
configuration de provider n'existe réellement (pas de CRUD exposé en
Phase 5A) — mais mieux vaut la fixer dès maintenant plutôt que d'oublier
au moment de la Phase 5C.

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
   étendant `NotificationProvider` (`types.js`), au minimum
   `validateConfig()`.
2. L'ajouter à `lib/services/notifications/providers/index.js`.
3. Rien d'autre à modifier : le registry, le manager et les routes
   restent inchangés (voir [Provider Registry](#provider-registry)).

`test()`/`send()` restent volontairement non implémentés tant que la
Phase 5B (providers réels) n'est pas en cours.

## Limites connues de cette phase

- Aucun envoi réel de notification n'existe : `NotificationManager.send()`
  lève une erreur explicite si appelé.
- Le routing (`notification_routes`) et l'historique
  (`notification_history`) ne sont que des modèles de données — rien ne
  les lit ni n'y écrit automatiquement.
- `type` sur `notification_providers` n'est pas contraint par une clé
  étrangère vers le registry (contrôle applicatif uniquement) : une
  configuration peut techniquement référencer un type qui n'est plus
  enregistré si un provider est retiré du code — traité comme
  `implemented: false` côté catalogue, pas comme une erreur bloquante.
- `providerIds` sur une route n'a pas de contrainte FK SQL (même raison
  que `alert_rules.target_value`) : supprimer un provider référencé par
  une règle ne bloque pas la suppression, ne casse pas la règle non plus
  (le routing engine, absent ici, devra ignorer les ids invalides le
  moment venu).
