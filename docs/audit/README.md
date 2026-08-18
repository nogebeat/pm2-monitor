# Audit Log

Phase 9 du projet : un journal d'audit **append-only** des actions
sensibles effectuées sur le monitor — connexions, actions sur les process
PM2, changements de configuration/environnement, actions PM2 daemon,
alertes, notifications, health checks, et actions Auto-Healing
administratives.

Ce n'est **pas** un doublon d'un système de logs existant :

- [`docs/events/README.md`](../events/README.md) (`process_events`) trace
  la **timeline technique** des crashs/restarts/changements de statut PM2
  (indépendante de tout utilisateur — un crash n'est l'action de personne).
- [`docs/auto-healing/README.md`](../auto-healing/README.md)
  (`auto_healing_audit`) trace les **tentatives automatiques** de
  redémarrage décidées par le moteur Auto-Healing (pas une action humaine).
- L'**Audit Log** (ce document, table `audit_log`) trace les actions
  **humaines/administratives** sensibles : qui a fait quoi, quand, avec
  quel résultat.

## Sommaire

- [Architecture](#architecture)
- [Événements audités](#événements-audités)
- [Structure d'une entrée](#structure-dune-entrée)
- [Sécurité — contrainte absolue](#sécurité--contrainte-absolue)
- [Sanitization](#sanitization)
- [API REST](#api-rest)
- [Permissions](#permissions)
- [Interface](#interface)
- [Rétention](#rétention)
- [Migration](#migration)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Architecture

```
lib/services/audit/
├── sanitize.js     # sanitizeAuditMetadata() — point d'entrée central,
│                      denylist de clés + détection de forme (JWT/PEM/Bearer/webhook)
├── audit-store.js  # persistance de la table audit_log (create/getById/list, pagination)
└── index.js        # recordEvent() — SEUL point d'entrée pour écrire une entrée,
                       force systématiquement le passage par sanitizeAuditMetadata()

lib/routes/audit.js  # GET /api/audit, GET /api/audit/:id, GET /api/audit/catalog
lib/db/migrations/011_audit_log.js  # table audit_log
```

`recordEvent()` est **tolérant aux pannes** : une erreur d'écriture de
l'audit (ex: DB temporairement indisponible) est loggée sur `stderr` et
**n'interrompt jamais** l'action métier qu'elle est censée tracer — un
`restart` de process qui réussit ne doit jamais se transformer en erreur
500 parce que l'insertion de la ligne d'audit a échoué.

## Événements audités

| Catégorie        | Actions (`ACTIONS` dans `lib/services/audit/index.js`)                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentification | `login`, `logout`                                                                                                                                                                                            |
| Process          | `process.start`, `process.stop`, `process.restart`, `process.reload`, `process.delete`, `process.env_change`, `process.config_change`                                                                        |
| PM2 (daemon)     | `pm2.save`, `pm2.resurrect`, `pm2.kill`                                                                                                                                                                      |
| Alertes          | `alert.rule_create`, `alert.rule_update`, `alert.rule_delete`, `alert.acknowledge`                                                                                                                           |
| Notifications    | `notification.config_change` (providers **et** règles de routing — voir `lib/routes/notifications.js`)                                                                                                       |
| Health checks    | `health_check.change`                                                                                                                                                                                        |
| Auto-Healing     | `auto_healing.action` (actions humaines/administratives — activer/désactiver, changer la config, débloquer un process ; les tentatives _automatiques_ restent dans `auto_healing_audit`, pas de doublon ici) |

Les actions de **lecture** (`GET`) ne sont volontairement **pas**
journalisées : seules les actions qui créent, modifient, suppriment, ou
exécutent quelque chose le sont. `GET /api/audit/catalog` expose ce
catalogue tel quel au frontend (construit le filtre "Action" sans
dupliquer la liste).

## Structure d'une entrée

```json
{
  "id": 42,
  "timestamp": 1737000000000,
  "userId": 1,
  "username": "admin",
  "action": "process.restart",
  "target": "api",
  "targetType": "process",
  "server": "host-1",
  "status": "success",
  "ip": "127.0.0.1",
  "metadata": { "op": "restart" },
  "createdAt": 1737000000012
}
```

- `status` : `success` | `failed` | `denied` (refus de permission).
- `target` / `targetType` : identifiant et type de la cible (nom de
  process, id de règle d'alerte, id de provider…). Absents si non
  applicable (ex: `login`).
- `metadata` : contexte additionnel, **toujours** passé par
  `sanitizeAuditMetadata()` avant stockage (voir plus bas).

## Sécurité — contrainte absolue

**Aucun secret n'est jamais enregistré, même dans `metadata`** :

- mots de passe (y compris SMTP)
- JWT
- clés API
- webhooks Discord/Slack
- tokens Telegram
- secrets d'environnement (variables `env` des process)
- clés privées
- headers `Authorization`

Cette contrainte ne repose **pas uniquement sur la discipline des
développeurs** : elle est appliquée mécaniquement par
`sanitizeAuditMetadata()`, qui est le seul chemin par lequel une
`metadata` peut atteindre la table `audit_log` (voir `recordEvent()` dans
`lib/services/audit/index.js`).

Zone la plus sensible : `lib/routes/notifications.js` (providers avec mot
de passe SMTP, webhooks Discord/Slack, tokens Telegram). Cette route
applique une règle supplémentaire, **en amont** du sanitizer : `metadata`
ne contient jamais une valeur de champ, seulement les **clés** (noms) des
champs modifiés ou fournis (`changedFieldKeys()`), qu'ils soient publics
(`name`, `url`) ou secrets (`webhookUrl`, `smtpPassword`, `apiKey`). Le
sanitizer reste le filet de sécurité final, mais ce module ne s'appuie pas
dessus pour décider quoi journaliser.

## Sanitization

`sanitizeAuditMetadata()` (`lib/services/audit/sanitize.js`) applique deux
mécanismes complémentaires, systématiquement, à n'importe quelle
profondeur d'objet/tableau imbriqué :

1. **Denylist de clés** : toute clé dont le nom (normalisé —
   camelCase/snake_case/kebab-case) correspond à un motif connu de secret
   (`password`, `secret`, `token`, `jwt`, `apiKey`, `privateKey`,
   `webhook`, `authorization`, `credential`, `cookie`…) est remplacée par
   `"[REDACTED]"`, quelle que soit sa valeur.
2. **Détection de forme** (filet de sécurité indépendant du nommage) : même
   sous une clé au nom anodin, une valeur qui _ressemble_ à un JWT, une clé
   privée PEM, un header `Authorization: Bearer/Basic …`, ou une URL de
   webhook Discord/Slack connue, est masquée.

Garde-fous additionnels : structures trop profondes (récursion cyclique)
redactées par prudence, objets non sérialisables ou non "plain" (instances
de classe internes) rejetés plutôt que stockés partiellement, et
`metadata` démesurée (> 8000 caractères JSON) tronquée.

## API REST

| Méthode | Route                | Description                          |
| ------- | -------------------- | ------------------------------------ |
| `GET`   | `/api/audit`         | Liste paginée, filtrable             |
| `GET`   | `/api/audit/:id`     | Détail d'une entrée                  |
| `GET`   | `/api/audit/catalog` | Catalogue des actions/statuts connus |

Filtres disponibles sur `GET /api/audit` : `user` (id), `username`,
`action`, `status`, `target`, `targetType`, `start`/`end` (timestamp ms,
date range), `limit`/`offset` (pagination — défaut 50, max 200).

**Aucun filtre ne permet de contourner la permission `audit_read`** :
`GET /api/audit` est protégé dans son ensemble, il n'y a pas de filtrage
"par app" à côté duquel un utilisateur pourrait passer — l'audit log n'est
pas décomposé par app, exactement comme la timeline d'événements ou
l'historique des alertes.

## Permissions

- `audit_read` : seule permission liée à l'audit log — **lecture seule**.
  L'audit log lui-même n'est jamais modifiable via l'API (append-only,
  aucun endpoint `PUT`/`PATCH`/`DELETE`).
- Les logs d'audit respectent les permissions générales de l'application :
  un utilisateur sans `audit_read` ne peut ni lister, ni consulter le
  détail, ni voir le catalogue.

Voir [Multi-utilisateurs & permissions](../../README.md#multi-utilisateurs--permissions)
dans le README principal.

## Interface

`Settings → 🧾 Audit Log` :

- **Liste** : Date, User, Action, Target, Status — filtrable (utilisateur,
  action, statut, cible, date range) et paginée.
- **Détail** : clic sur une entrée → affiche les champs complets et la
  `metadata` sanitisée telle que stockée côté serveur (le frontend
  n'applique aucun masquage supplémentaire : la donnée n'a de toute façon
  jamais quitté le serveur sous forme non sanitisée).

## Rétention

Purge automatique **optionnelle, désactivée par défaut** (`AUDIT_RETENTION_MS=0`,
comportement historique) — le choix le plus sûr pour un journal de
conformité/sécurité est de ne rien supprimer tant que l'opérateur n'a pas
explicitement défini une politique de rétention. Même découpage que
[`docs/events/README.md`](../events/README.md) (`EVENTS_RETENTION_MS`) :

- `AUDIT_RETENTION_MS` (ms) : durée de conservation avant purge. `0` (défaut)
  = purge désactivée.
- `AUDIT_MAINTENANCE_INTERVAL_MS` (ms, défaut `3600000` = 1h) : fréquence du
  cycle de purge, si `AUDIT_RETENTION_MS` est défini.

`AuditRetentionService` (`lib/services/audit/index.js`) tourne sur son
propre intervalle (`start()`/`stop()`), instancié par `server.js` après
chargement du `.env` — même mécanisme que `EventsService`. `purgeOnce()`
est exposé pour les tests et un éventuel appel manuel, et est un no-op tant
que `AUDIT_RETENTION_MS` vaut `0`. La purge (`audit-store.js#purgeOlderThan`)
est le **seul** mécanisme de suppression d'entrées d'audit : aucune route
API n'expose de suppression manuelle (append-only).

## Migration

`lib/db/migrations/011_audit_log.js` — table `audit_log` (SQLite et
MySQL), indexée sur `ts`, `user_id`, `action`, `status`, `target`.

## Tests

- `test/unit/audit-sanitize.test.js` — `sanitizeAuditMetadata()` : denylist
  de clés, détection de forme, imbrication, troncature, résilience
  (référence circulaire, profondeur excessive).
- `test/unit/audit-store.test.js` — `audit-store.js` : create/getById,
  pagination, filtres (username/action/status/target/date range).
- `test/integration/audit-api.test.js` — API complète : permissions
  (`audit_read`, refus impossible à contourner via un filtre), actions
  enregistrées (`success`/`failed`/`denied`), pagination, filtres, **et le
  test de sécurité obligatoire** : injection de `password`/`token`/
  `apiKey`/`authorization`/`webhook` (y compris via un vrai flux
  `POST /api/notifications/providers`) et vérification qu'ils
  n'apparaissent **jamais** dans la base, la réponse API, ou les logs
  process.

```bash
node --test test/unit/audit-sanitize.test.js test/unit/audit-store.test.js test/integration/audit-api.test.js
```

## Limites connues

- `server` est le hostname local par défaut (pas de vraie notion
  multi-serveur dans cette phase — même limite que le reste du monitor).
- Un `action` inconnu du catalogue `ACTIONS` est quand même accepté à
  l'écriture (mieux vaut un événement mal étiqueté qu'un événement perdu),
  mais toute nouvelle action **devrait** être ajoutée au catalogue pour
  rester documentée et filtrable.
