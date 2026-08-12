# Provider Webhook générique

Fichier : `lib/services/notifications/providers/webhook.js`. Pensé pour
connecter n'importe quel système externe (self-hosted ou non) qui
accepte une requête HTTP — aucune dépendance supplémentaire (utilise
`fetch`).

## Configuration

| Champ     | Requis | Type / valeurs                    | Description |
|-----------|--------|--------------------------------------|---------------|
| `url`     | Oui    | string (URL `http://` ou `https://`) | Destination de la requête. |
| `method`  | Non    | `GET` \| `POST` \| `PUT` \| `PATCH`   | Défaut : `POST`. |
| `headers` | Non    | objet clé/valeur (**secret**)          | En-têtes personnalisés, ex. `{ "Authorization": "Bearer …" }`. |
| `timeout` | Non    | nombre (ms)                              | Délai avant abandon. Défaut : 10000, plafonné à 60000. |
| `payload` | Non    | objet ou chaîne JSON-sérialisable          | Gabarit du corps envoyé (méthodes non-`GET` uniquement). Voir ci-dessous. |

### Gabarit `payload`

Sans `payload`, le corps par défaut envoyé est :

```json
{ "title": "...", "message": "...", "severity": "...", "timestamp": "...", "url": "..." }
```

Avec `payload`, toute chaîne contenant `{{title}}`, `{{message}}`,
`{{severity}}`, `{{timestamp}}` ou `{{url}}` est remplacée par la
valeur correspondante de la notification — y compris dans des objets ou
tableaux imbriqués. Exemple :

```json
{
  "payload": {
    "text": "{{severity}} — {{title}} : {{message}}",
    "meta": { "source": "pm2-monitor" }
  }
}
```

C'est une simple substitution de chaînes, pas un moteur de templates
avancé (conditions, boucles… hors scope de cette phase).

## Prérequis

- Un endpoint HTTP joignable depuis l'hôte qui exécute PM2 Monitor,
  acceptant la méthode configurée.

## Sécurité

- `headers` peut contenir un `Authorization`/une clé d'API — jamais
  loggé, jamais renvoyé dans une erreur ou une réponse API.
- `url` complète n'est jamais incluse dans un message d'erreur (peut
  elle-même contenir un token en query string) — uniquement une
  catégorie d'erreur générique.
- Aucune protection SSRF au-delà de la validation `http(s)://` de base :
  comme pour toute intégration webhook sortante, ne pas exposer cette
  fonctionnalité à des utilisateurs non fiables sans restriction réseau
  supplémentaire côté infrastructure (hors scope applicatif).

## Test

- `test(config)` (hérité, voir `types.js`) : envoie une notification de
  test standard avec le gabarit configuré.
- Pas de `healthCheck()` dédié : la notion de "santé" dépend entièrement
  du système externe connecté, qui n'a pas de contrat standard — `test()`
  reste le seul moyen de vérifier une configuration.
- Tests automatisés : `test/unit/notifications-providers.test.js`,
  section "provider webhook" — `global.fetch` est mocké, aucun appel
  réel en CI.

## Erreurs communes

| `errorCode`     | Cause probable | À vérifier |
|-------------------|------------------|--------------|
| `INVALID_CONFIG`   | `url` absente/invalide, `method` non supportée, `headers` pas un objet, `timeout` non numérique. | Config du provider. |
| `AUTH_ERROR`         | 401/403 côté système externe. | `headers.Authorization` ou équivalent. |
| `NOT_FOUND`            | 404 — endpoint invalide. | `url`. |
| `RATE_LIMITED`           | 429. | Fréquence d'envoi. |
| `NETWORK_ERROR`            | Endpoint injoignable. | Connectivité sortante, `url`. |
| `TIMEOUT`                    | Pas de réponse dans le délai imparti. | `timeout`, latence du système externe. |
| `PROVIDER_ERROR`               | Erreur 5xx côté système externe. | Logs du système externe (hors périmètre PM2 Monitor). |
