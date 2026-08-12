# Provider Email / SMTP

Fichier : `lib/services/notifications/providers/email.js`. Utilise
[`nodemailer`](https://www.npmjs.com/package/nodemailer) (seule nouvelle
dépendance ajoutée en Phase 5B — aucune lib SMTP n'existait déjà dans le
projet).

## Configuration

| Champ       | Requis | Type / valeurs                      | Description |
|-------------|--------|--------------------------------------|--------------|
| `host`      | Oui    | string                                | Hôte du serveur SMTP. |
| `port`      | Oui    | nombre, 1–65535                       | Port SMTP (25, 465, 587…). |
| `security`  | Non    | `None` \| `STARTTLS` \| `SSL/TLS`     | Défaut : `None`. Insensible à la casse et aux variantes (`ssl`, `tls`, `ssl_tls` sont tous acceptés). |
| `username`  | Non    | string (**secret**)                   | Doit être fourni avec `password`, ou aucun des deux. |
| `password`  | Non    | string (**secret**)                   | Idem. |
| `fromName`  | Non    | string                                 | Nom affiché de l'expéditeur. |
| `fromEmail` | Oui    | string (adresse email valide)          | Adresse d'expédition. |
| `to`        | Non\*   | string ou tableau de strings            | Destinataire(s). Voir note ci-dessous. |

\* `to` n'est pas dans la liste stricte de champs de la tâche mais est
indispensable pour qu'un envoi SMTP soit possible du tout : sans lui,
`send()` échoue avec `INVALID_CONFIG` / *"Aucun destinataire (to)
fourni."*. Une notification peut aussi porter son propre `to`
(`notification.to`), qui a alors priorité sur `config.to` — utile pour
un futur routing dynamique (Phase 5C) sans changer la config du
provider.

### `security` et connexion

| Valeur       | Comportement nodemailer                          |
|---------------|----------------------------------------------------|
| `None`         | Connexion en clair, pas de TLS forcé (`secure: false`, `requireTLS: false`). |
| `STARTTLS`     | Connexion en clair puis upgrade TLS obligatoire (`requireTLS: true`). Port typique : 587. |
| `SSL/TLS`      | TLS dès la connexion (`secure: true`). Port typique : 465. |

## Prérequis

- Un serveur SMTP joignable depuis l'hôte qui exécute PM2 Monitor
  (aucun relai SaaS obligatoire — tout serveur SMTP self-hosted ou
  fournisseur convient).
- `NOTIFICATIONS_ENCRYPTION_KEY` défini si `username`/`password` doivent
  être stockés de façon persistante (voir
  [docs/notifications/README.md#secrets](../README.md#secrets)).

## Sécurité

- `password` n'est **jamais** loggé ni renvoyé dans une erreur.
- Aucune erreur nodemailer brute n'est exposée : les erreurs sont
  classifiées uniquement par `err.code` (`EAUTH`, `ECONNECTION`,
  `ESOCKET`, `ETIMEDOUT`, `EENVELOPE`…) → message générique fixe. Le
  message brut d'une erreur SMTP peut contenir la réponse du serveur
  (parfois le host interne) — jamais transmis tel quel.
- `to`/`fromEmail` ne sont pas des secrets (adresses email), mais ne
  sont jamais utilisés pour construire un message d'erreur : seule la
  catégorie d'erreur (`errorCode`) est exposée.

## Test

- `test(config)` (hérité de `NotificationProvider`, voir `types.js`) :
  valide la config puis envoie un e-mail de test standard à `config.to`.
- `healthCheck(config)` : appelle `transporter.verify()` — vérifie la
  connexion et l'authentification SMTP **sans envoyer d'e-mail**. Utile
  pour valider une configuration avant de déclencher un vrai test.
- Tests automatisés : `test/unit/notifications-providers.test.js`,
  section "provider email" — `nodemailer.createTransport` est mocké
  (`node:test` `t.mock.method`), aucune vraie connexion SMTP en CI.

## Erreurs communes

| `errorCode`     | Cause probable | À vérifier |
|-------------------|------------------|--------------|
| `INVALID_CONFIG`   | Champ requis manquant, ou `to` absent. | `host`, `port`, `fromEmail`, `to`. |
| `AUTH_ERROR`         | Identifiants SMTP refusés (`EAUTH`). | `username`/`password`, ou mot de passe applicatif requis par le fournisseur (Gmail, etc.). |
| `NETWORK_ERROR`       | Hôte/port injoignable (`ECONNECTION`, `ESOCKET`, `ECONNREFUSED`, `EDNS`). | `host`, `port`, pare-feu sortant. |
| `TIMEOUT`               | Le serveur ne répond pas dans le délai imparti (`ETIMEDOUT`). | Connectivité réseau, `timeout` trop court. |
| `HTTP_ERROR`              | Expéditeur/destinataire refusé par le serveur (`EENVELOPE`). | `fromEmail`, `to`. |
| `PROVIDER_ERROR`           | Toute autre erreur SMTP. | Consulter les logs du serveur SMTP lui-même (jamais exposés par PM2 Monitor). |
