# Backup & Restore (Phase 19)

Export/validation/restauration versionnés de la **configuration** de PM2
Monitor (utilisateurs, permissions, règles d'alerte, notifications, health
checks, auto-healing, tags/environnements/groupes, silences actifs,
serveurs, dépendances de service) — **jamais** les données runtime/
temporaires (métriques, logs, historique de process, incidents, statut des
serveurs…), qui se reconstituent naturellement au prochain cycle de
collecte et n'ont pas leur place dans un backup de configuration.

Toute la logique vit dans `lib/services/backup/` :

- `format.js` — enveloppe versionnée (`format`, `formatVersion`,
  `metadata`, `data`) et sa validation structurelle.
- `sections.js` — un module par domaine de configuration : export +
  restauration par **fusion sur clé naturelle** (jamais par id numérique).
- `crypto.js` — chiffrement dédié (AES-256-GCM) des secrets optionnellement
  embarqués dans un backup.
- `export.js` / `restore.js` — orchestration (assemblage des sections à
  l'export, transaction unique + agrégation des résultats à la restauration).

## Sommaire

- [Ce qui est sauvegardé](#ce-qui-est-sauvegardé)
- [Ce qui n'est jamais sauvegardé (ou jamais tel quel)](#ce-qui-nest-jamais-sauvegardé-ou-jamais-tel-quel)
- [Format du fichier](#format-du-fichier)
- [Secrets](#secrets)
- [Restauration : fusion, conflits, transaction](#restauration--fusion-conflits-transaction)
- [API REST](#api-rest)
- [CLI](#cli)
- [UI](#ui)
- [Compatibilité des versions](#compatibilité-des-versions)
- [Permissions](#permissions)
- [Audit](#audit)
- [Migration](#migration)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Ce qui est sauvegardé

| Section (`id`)        | Contenu                                                                                          | Inclus par défaut |
| --------------------- | ------------------------------------------------------------------------------------------------ | ----------------- |
| `users`               | `username`, `isAdmin`, `role`. **Jamais** `password_hash`.                                       | oui               |
| `permissions`         | Triplets `(username, appName, action)`.                                                          | oui               |
| `processOrganization` | Tags, environnements, groupes + leurs assignations par process.                                  | oui               |
| `healthChecks`        | Configuration des sondes HTTP/TCP/Command.                                                       | oui               |
| `alertRules`          | Règles du moteur d'alertes.                                                                      | oui               |
| `notifications`       | Providers (config, jamais les secrets par défaut) + règles de routing/templates.                 | oui               |
| `autoHealing`         | Réglages globaux (`maxAttempts`, `backoffSeconds`) — **pas** `enabled`, voir plus bas.           | oui               |
| `alertSilences`       | Silences **actifs uniquement** (ni annulés, ni expirés).                                         | **non** (opt-in)  |
| `servers`             | Registre multi-serveurs (nom, hostname, environnement, activé) + accès utilisateur↔serveur.      | oui               |
| `serviceDependencies` | Carte de dépendances de service (source/target/type/description), liées par nom de health check. | oui               |
| `apiKeys`             | **Informatif uniquement** (nom, préfixe, scopes, dates) — jamais restaurable, voir plus bas.     | oui               |

`incidents` (au sens strict : les incidents eux-mêmes, avec leur timeline)
n'est **volontairement pas une section** : un incident référence des
alertes runtime (`alerts.id`), qui ne sont elles-mêmes pas de la
configuration et ne font pas partie d'un backup — restaurer un incident
sans les alertes qu'il référence produirait des enregistrements orphelins
et trompeurs. Seuls les **silences actifs**, auto-suffisants (aucune
référence à une alerte), sont couverts.

## Ce qui n'est jamais sauvegardé (ou jamais tel quel)

- **Tout état runtime** : `status`, `last_seen_at`, `last_snapshot`,
  compteurs de tentatives d'auto-healing, etc. — se resynchronise seul.
- **Tout `created_by`/`updated_by`/`acknowledged_by`** référençant un
  utilisateur en dehors de la section `users` elle-même : l'id numérique
  d'origine n'a aucune raison d'exister sur l'instance cible ; ces colonnes
  sont mises à `NULL` à la restauration plutôt que de deviner un mauvais
  mapping.
- **`password_hash`** (users) : jamais exporté. Un utilisateur recréé à la
  restauration reçoit un **mot de passe temporaire généré**, renvoyé **une
  seule fois** dans la réponse de restauration (voir
  [Restauration](#restauration--fusion-conflits-transaction)) — même
  logique que la révélation d'un secret de clé API à sa création.
- **`token_hash`** (servers) : jamais exporté. Un serveur restauré doit être
  ré-approvisionné avec un nouveau token (voir Multi-server).
- **`key_hash`** (api_keys) : jamais exporté, jamais restaurable — voir
  [API keys](#ce-qui-est-sauvegardé) ci-dessus.
- **`autoHealing.enabled`** : exporté pour référence, mais **jamais
  réappliqué** à la restauration — redémarrer des process automatiquement
  est une action à risque, une restauration ne doit jamais la réactiver
  silencieusement sur une instance où elle était éteinte.

## Format du fichier

```jsonc
{
  "format": "pm2-monitor-backup",
  "formatVersion": 1,
  "metadata": {
    "monitorVersion": "3.9.0",
    "createdAt": 1735689600000,
    "createdBy": { "id": 1, "username": "admin" },
    "driver": "sqlite",
    "sections": ["users", "permissions", "..."],
    "secrets": { "included": false, "encrypted": false, "algorithm": null },
  },
  "data": {
    "users": [{ "username": "admin", "isAdmin": true, "role": "admin" }],
    "...": "...",
  },
}
```

`formatVersion` est un entier, incrémenté uniquement si la **forme** de
l'enveloppe change (pas à chaque nouvelle section : `data` absorbe ça
nativement, une section inconnue d'une version antérieure est simplement
ignorée à l'import, jamais fatale — voir `unknownSections` dans la réponse
de `/validate`).

## Secrets

Par défaut, **aucun secret en clair** n'est jamais présent dans un backup :

- Les providers de notification exportent leur `configuration` (non
  sensible) mais pas leurs `secrets` (mot de passe SMTP, webhook, bot
  token…), sauf si `includeSecrets: true` est explicitement demandé à
  l'export.
- Quand `includeSecrets: true` est demandé, les secrets sont déchiffrés
  (clé `NOTIFICATIONS_ENCRYPTION_KEY`, déjà en mémoire côté serveur) puis
  **re-chiffrés avec une clé dédiée au backup**
  (`BACKUP_ENCRYPTION_KEY`, AES-256-GCM — voir
  `lib/services/backup/crypto.js`), jamais stockés en clair, jamais avec la
  même clé que la base de données source. Sans `BACKUP_ENCRYPTION_KEY`
  configurée, une demande `includeSecrets: true` échoue explicitement
  (aucun repli silencieux, aucune clé éphémère générée en mémoire — un
  backup doit rester exploitable après un redémarrage, contrairement au
  chiffrement au repos des providers).
- À la restauration, les secrets sont déchiffrés avec
  `BACKUP_ENCRYPTION_KEY` puis re-chiffrés normalement avec
  `NOTIFICATIONS_ENCRYPTION_KEY` de l'instance cible (via
  `provider-store.js#create`/`update`, code déjà existant, inchangé).
- **Aucune cryptographie maison** : le module `lib/services/backup/crypto.js`
  réutilise exactement l'algorithme déjà documenté et utilisé pour les
  secrets de providers de notification (AES-256-GCM, IV aléatoire par
  valeur), avec une clé dédiée.

## Restauration : fusion, conflits, transaction

La restauration **fusionne** (merge) le backup dans l'état actuel, elle ne
remplace jamais destructivement :

- Chaque enregistrement est identifié par une **clé naturelle**
  (`username`, `name`, `server_key`, triplet `(source, target, type)`…),
  jamais par son id numérique — un id n'a aucune raison de coïncider entre
  deux instances.
- S'il n'existe pas localement → **créé**.
- S'il existe déjà localement → selon `onConflict` :
  - `"skip"` (défaut) : laissé **tel quel**, signalé en conflit.
  - `"overwrite"` : mis à jour avec le contenu du backup.
- **`permissions` fait exception** : fusion **toujours additive**, jamais
  affectée par `onConflict` — une permission absente du backup n'est jamais
  révoquée automatiquement (éviter qu'une restauration partielle ne retire
  silencieusement des droits).
- Si plusieurs enregistrements locaux partagent la même clé "naturelle"
  quand celle-ci n'est pas contrainte `UNIQUE` en base (ex : deux règles
  d'alerte du même nom), la restauration ne devine pas : elle **signale un
  conflit et ignore** cette entrée plutôt que de choisir arbitrairement.

Toute la restauration s'exécute dans **une seule transaction DB**
(`db.beginTransaction()`/`commit()`/`rollback()`, déjà utilisée par
`lib/db/migrator.js`) : si une section échoue en cours de route (donnée
invalide rejetée par le store du domaine, cycle détecté dans les
dépendances de service…), **toutes** les écritures déjà faites — y compris
celles de sections précédentes dans le même appel — sont annulées. Aucune
restauration partiellement appliquée.

`POST /api/backup/validate` exécute exactement le même code que la
restauration réelle, mais en mode **dry-run** (aucune écriture) : le résumé
retourné (créés/mis à jour/ignorés + conflits, par section) est donc fiable
pour décider `onConflict` et confirmer en connaissance de cause avant
`POST /api/backup/restore`.

## API REST

| Méthode | Route                  | Permission                        | Description                                                                                                            |
| ------- | ---------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET     | `/api/backup/sections` | `backup_export`                   | Catalogue des sections disponibles + `formatVersion` + `secretsAvailable` (si `BACKUP_ENCRYPTION_KEY` est configurée). |
| POST    | `/api/backup/export`   | `backup_export`                   | `{ sections?, includeSecrets? }` → l'enveloppe de backup complète.                                                     |
| POST    | `/api/backup/validate` | `backup_restore`                  | `{ backup, onConflict? }` → résumé dry-run (aucune écriture).                                                          |
| POST    | `/api/backup/restore`  | `backup_restore` **+ `is_admin`** | `{ backup, onConflict?, confirm: true }` → restauration réelle, transactionnelle.                                      |

`POST /api/backup/restore` exige en plus `req.user.isAdmin` (même
garde-fou que `manage_users`) : une restauration peut recréer des
comptes/permissions, ce n'est jamais une action réservée à une simple
permission déléguée. `POST /api/backup/validate`, en lecture seule,
n'a pas cette exigence.

## CLI

Même style que `bin/migrate.js` / `bin/manage-users.js` (charge le `.env`
de la racine, appelle directement le service — pas de requête HTTP,
utilisable en SSH sans que le serveur web tourne) :

```bash
# Export vers un fichier
node bin/backup.js export --out backup.json

# Export d'un sous-ensemble de sections, secrets inclus (chiffrés)
node bin/backup.js export --sections alertRules,notifications --include-secrets --out backup.json

# Aperçu (dry-run) : résumé + conflits, sans rien écrire
node bin/backup.js validate backup.json --on-conflict skip

# Restauration : affiche le résumé, demande confirmation ("OUI"), puis restaure
node bin/backup.js restore backup.json --on-conflict skip

# Sans confirmation interactive (scripts d'automatisation)
node bin/backup.js restore backup.json --yes
```

Raccourcis npm : `npm run backup` (export stdout), `npm run backup:validate
-- <fichier>`, `npm run backup:restore -- <fichier>`.

## UI

Un bouton **💾 Backup** apparaît dans la barre supérieure pour tout
utilisateur ayant `backup_export` et/ou `backup_restore` (confort d'UI
uniquement, la vérité est revalidée côté API à chaque requête — voir
`frontend/src/components/modals/BackupModal.vue`) :

- **Export** : sélection des sections à cocher, option "inclure les secrets"
  (visible seulement si `BACKUP_ENCRYPTION_KEY` est configurée côté
  serveur), téléchargement direct du fichier `.json`.
- **Restore** : chargement de fichier ou collage du JSON → bouton
  **Valider (aperçu)** (appelle `/validate`, affiche le résumé et les
  conflits) → bouton **Confirmer la restauration** (n'apparaît qu'après
  validation, appelle `/restore`) → les mots de passe temporaires générés
  sont affichés une seule fois, à copier/transmettre immédiatement.

## Compatibilité des versions

- `formatVersion` supérieure à celle connue de l'instance → refus explicite
  ("mets à jour PM2 Monitor avant de restaurer ce backup").
- `formatVersion` inférieure à celle attendue → refus explicite (aucune
  migration de format n'existe encore, une seule version à ce jour).
- Une **section inconnue** présente dans le fichier (backup produit par une
  version future ayant ajouté une section) n'est **jamais fatale** : elle
  est listée dans `unknownSections` (réponse de `/validate`) et simplement
  ignorée à l'import.

## Permissions

Deux actions globales (voir
[Multi-utilisateurs & permissions](../../README.md#multi-utilisateurs--permissions)) :

- `backup_export` — export uniquement (peut inclure des secrets si demandé
  et si `BACKUP_ENCRYPTION_KEY` est configurée).
- `backup_restore` — validation (lecture seule) **et** restauration réelle ;
  la restauration réelle exige en plus `is_admin` (voir
  [API REST](#api-rest)).

Ni l'une ni l'autre n'est incluse dans les rôles prédéfinis
Operator/Viewer/Auditor (voir
[RBAC avancé & Clés API](../rbac-api-keys/README.md#rôles-prédéfinis)) —
seul un compte administrateur (ou explicitement doté de ces permissions par
un administrateur) y a accès par défaut.

## Audit

Nouveaux types d'événements (`lib/services/audit/index.js#ACTIONS`) :
`backup.export`, `backup.restore` — tracés à chaque appel, succès **et**
échec. Les secrets embarqués et les mots de passe temporaires générés ne
sont **jamais** écrits dans une entrée d'audit, même sanitizés — ils ne
transitent que dans la réponse HTTP de l'appel qui les a produits.

## Migration

Aucune migration de schéma n'était nécessaire pour cette phase : le backup
lit/écrit exclusivement des tables déjà créées par des migrations
antérieures (`001_initial_schema` → `020_rbac_api_keys`).

## Tests

- `test/unit/backup-service.test.js` — format/validation d'enveloppe,
  export (sections par défaut, sous-ensemble explicite, exclusion des
  secrets par défaut, chiffrement dédié quand demandé), restauration
  (création avec mot de passe temporaire, fusion additive des permissions,
  `onConflict` skip/overwrite, résolution de `healthCheckName` →
  `healthCheckId` entre sections, non-restauration des clés API, conflit
  sur nom ambigu, rollback transactionnel sur erreur en cours de
  restauration, `validateBackup()` réellement dry-run), et le module
  `crypto.js` dédié (round-trip, absence de clé → erreur explicite).
- `test/integration/backup-api.test.js` — permissions par route
  (`backup_export`/`backup_restore`), exigence `is_admin` sur la
  restauration réelle uniquement, `confirm=true` requis, erreurs 400
  explicites sur un backup mal formé.

## Limites connues

- Les incidents (avec leur timeline) ne sont pas couverts — voir
  [Ce qui est sauvegardé](#ce-qui-est-sauvegardé) pour la justification.
- Un serveur multi-server restauré doit être ré-approvisionné avec un
  nouveau token (`token_hash` jamais exporté) — voir
  [docs/multi-server/README.md](../multi-server/README.md).
- Les clés API ne sont jamais restaurées telles quelles (secret
  non récupérable) : la section `apiKeys` du backup est strictement
  informative, à recréer manuellement si besoin.
- La limite de taille du corps de requête HTTP pour `/api/backup`
  (`BACKUP_MAX_BODY_SIZE`, 20 Mo par défaut) est distincte de la limite
  globale d'Express (100 Ko, inchangée pour toutes les autres routes) —
  voir `server.js`. Un backup qui dépasserait quand même cette limite dédiée
  peut toujours être restauré sans limite via le CLI (`bin/backup.js`).
- La fusion par clé naturelle sur une table sans contrainte `UNIQUE` en base
  (ex : `alert_rules.name`, `health_checks.name`) ne peut pas distinguer
  deux enregistrements locaux homonymes : signalé en conflit, restauration
  de cette entrée ignorée plutôt que de deviner.
