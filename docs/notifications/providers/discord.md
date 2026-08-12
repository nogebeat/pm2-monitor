# Provider Discord

Fichier : `lib/services/notifications/providers/discord.js`. Envoi via
[Webhook Discord](https://support.discord.com/hc/fr/articles/228383668) —
pas de bot, aucune dépendance supplémentaire (utilise `fetch`, déjà
disponible nativement).

## Configuration

| Champ         | Requis | Type / valeurs | Description |
|---------------|--------|-------------------|---------------|
| `webhookUrl`  | Oui    | string (**secret**) | URL complète du webhook, format `https://discord.com/api/webhooks/<id>/<token>` (ou `discordapp.com`). |
| `username`    | Non    | string               | Nom affiché du bot pour ce message (surcharge le nom configuré côté Discord). |
| `timeout`     | Non    | nombre (ms)          | Délai avant abandon de la requête. Défaut : 10000, plafonné à 60000. |

## Prérequis

- Un salon Discord avec un webhook créé (Paramètres du salon →
  Intégrations → Webhooks).

## Sécurité

- `webhookUrl` contient un token d'accès complet : quiconque le connaît
  peut poster dans le salon. Jamais loggé, jamais renvoyé dans une
  erreur ou une réponse API.
- Les erreurs réseau (`fetch()`) ne sont jamais exposées telles quelles
  — leur message peut contenir l'URL appelée (donc le token). Seule une
  catégorie d'erreur générique (`errorCode`/`safeMessage`) est renvoyée.

## Test

- `test(config)` (hérité, voir `types.js`) : envoie une notification de
  test standard sur le salon.
- `healthCheck(config)` : `GET` sur le `webhookUrl` — renvoie les
  métadonnées du webhook (nom, salon) **sans poster de message**, utile
  pour valider une configuration silencieusement.
- Astuce d'implémentation : l'envoi utilise `?wait=true` pour que
  Discord renvoie le message créé (sinon 204 sans corps), ce qui permet
  d'exposer un `messageId` dans le résultat normalisé.
- Tests automatisés : `test/unit/notifications-providers.test.js`,
  section "provider discord" — `global.fetch` est mocké, aucun appel
  réel à Discord en CI.

## Erreurs communes

| `errorCode`     | Cause probable | À vérifier |
|-------------------|------------------|--------------|
| `INVALID_CONFIG`   | `webhookUrl` absent ou ne correspondant pas au format Discord. | Copier l'URL complète du webhook depuis Discord. |
| `AUTH_ERROR`         | 401/403 — webhook supprimé ou token invalide. | Recréer le webhook côté Discord. |
| `NOT_FOUND`            | 404 — webhook inexistant. | URL du webhook. |
| `RATE_LIMITED`           | 429 — trop de messages envoyés. | Réduire la fréquence d'envoi. |
| `NETWORK_ERROR`            | Discord injoignable. | Connectivité sortante de l'hôte PM2 Monitor. |
| `TIMEOUT`                    | Pas de réponse dans le délai imparti. | `timeout`, connectivité réseau. |
| `PROVIDER_ERROR`               | Erreur 5xx côté Discord. | Réessayer plus tard. |
