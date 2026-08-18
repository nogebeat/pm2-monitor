# Provider Telegram

Fichier : `lib/services/notifications/providers/telegram.js`. Envoi via
la [Bot API Telegram](https://core.telegram.org/bots/api#sendmessage)
(`sendMessage`) — aucune dépendance supplémentaire (utilise `fetch`).

## Configuration

| Champ      | Requis | Type / valeurs      | Description                                                    |
| ---------- | ------ | ------------------- | -------------------------------------------------------------- |
| `botToken` | Oui    | string (**secret**) | Token du bot, obtenu via [@BotFather](https://t.me/BotFather). |
| `chatId`   | Oui    | string ou nombre    | Identifiant du salon/utilisateur/canal cible.                  |
| `timeout`  | Non    | nombre (ms)         | Délai avant abandon. Défaut : 10000, plafonné à 60000.         |

## Prérequis

- Créer un bot via [@BotFather](https://t.me/BotFather) → récupérer le
  token.
- Ajouter le bot au salon/canal cible, ou démarrer une conversation
  privée avec lui.
- Récupérer le `chatId` (ex. via `https://api.telegram.org/bot<TOKEN>/getUpdates`
  après avoir envoyé un message au bot).

## Sécurité

- `botToken` fait partie de l'URL appelée
  (`api.telegram.org/bot<TOKEN>/…`) — jamais loggé, jamais renvoyé dans
  une erreur. Les erreurs réseau (`fetch()`) ne sont jamais exposées
  telles quelles pour cette raison précise (leur message peut contenir
  l'URL complète).
- Un token de bot compromis permet de poster en son nom dans tous les
  salons où il a été ajouté : à traiter avec la même rigueur qu'un mot
  de passe.

## Test

- `test(config)` (hérité, voir `types.js`) : envoie un message de test
  standard au `chatId` configuré.
- `healthCheck(config)` : appelle `getMe()` — vérifie que le token est
  valide et le bot joignable **sans envoyer de message**.
- Tests automatisés : `test/unit/notifications-providers.test.js`,
  section "provider telegram" — `global.fetch` est mocké, aucun appel
  réel à l'API Telegram en CI.

## Erreurs communes

| `errorCode`          | Cause probable                                                                | À vérifier                                                                       |
| -------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `INVALID_CONFIG`     | `botToken` ou `chatId` manquant.                                              | Config du provider.                                                              |
| `AUTH_ERROR`         | Token invalide/révoqué.                                                       | Régénérer le token via BotFather (`/revoke`).                                    |
| `NOT_FOUND`          | `chatId` inconnu, ou bot jamais démarré par l'utilisateur/salon.              | Envoyer un message au bot au préalable, ou vérifier l'ajout au salon.            |
| `NETWORK_ERROR`      | Telegram injoignable (bloqué dans certains pays/réseaux).                     | Connectivité sortante vers `api.telegram.org`.                                   |
| `TIMEOUT`            | Pas de réponse dans le délai imparti.                                         | `timeout`, connectivité réseau.                                                  |
| `MALFORMED_RESPONSE` | Réponse JSON illisible.                                                       | Signalement à investiguer — ne devrait pas arriver en usage normal.              |
| `PROVIDER_ERROR`     | `ok: false` sans catégorie plus précise (ex. chat non trouvé selon Telegram). | Description Telegram non exposée par sécurité — vérifier `chatId`/droits du bot. |
