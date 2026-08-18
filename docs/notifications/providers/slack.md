# Provider Slack

Fichier : `lib/services/notifications/providers/slack.js`. Envoi via
[Incoming Webhook Slack](https://api.slack.com/messaging/webhooks) —
aucune dépendance supplémentaire (utilise `fetch`).

## Configuration

| Champ        | Requis | Type / valeurs      | Description                                                              |
| ------------ | ------ | ------------------- | ------------------------------------------------------------------------ |
| `webhookUrl` | Oui    | string (**secret**) | URL du webhook, format `https://hooks.slack.com/services/<T>/<B>/<xyz>`. |
| `channel`    | Non    | string              | Surcharge le salon configuré par défaut sur le webhook.                  |
| `timeout`    | Non    | nombre (ms)         | Délai avant abandon. Défaut : 10000, plafonné à 60000.                   |

## Prérequis

- Créer une app Slack (ou réutiliser une app existante) → activer
  "Incoming Webhooks" → créer un webhook pour le salon cible.

## Sécurité

- `webhookUrl` contient un token d'accès complet — jamais loggé, jamais
  renvoyé dans une erreur.
- Les erreurs réseau ne sont jamais exposées telles quelles (le message
  peut contenir l'URL appelée).

## Test

- `test(config)` (hérité, voir `types.js`) : envoie un message de test
  standard sur le salon.
- Pas de `healthCheck()` dédié pour ce provider : un webhook Slack ne
  répond pas de façon utile à une requête `GET` (les webhooks entrants
  Slack n'acceptent que `POST`) — `test()` reste le seul moyen de
  vérifier une configuration.
- Tests automatisés : `test/unit/notifications-providers.test.js`,
  section "provider slack" — `global.fetch` est mocké, aucun appel réel
  à Slack en CI.

## Erreurs communes

Particularité Slack : les webhooks entrants renvoient presque toujours
un statut **200**, même en cas d'erreur applicative — le corps de la
réponse (`ok` en cas de succès, sinon un code d'erreur textuel type
`channel_not_found`, `invalid_payload`) doit donc être inspecté. Le
provider le fait automatiquement.

| `errorCode`          | Cause probable                                                          | À vérifier                                         |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| `INVALID_CONFIG`     | `webhookUrl` absent ou ne correspondant pas au format Slack.            | Copier l'URL complète depuis Slack.                |
| `PROVIDER_ERROR`     | Statut 200 mais corps ≠ `ok` (`channel_not_found`, `invalid_payload`…). | Salon toujours existant ? Webhook toujours actif ? |
| `NOT_FOUND`          | 404 — webhook révoqué/supprimé.                                         | Recréer le webhook.                                |
| `NETWORK_ERROR`      | Slack injoignable.                                                      | Connectivité sortante vers `hooks.slack.com`.      |
| `TIMEOUT`            | Pas de réponse dans le délai imparti.                                   | `timeout`, connectivité réseau.                    |
| `MALFORMED_RESPONSE` | Corps de réponse illisible.                                             | Signalement à investiguer.                         |
