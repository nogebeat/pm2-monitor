# Idées de fonctionnalités

Backlog non engagé — rien ici n'est planifié ni priorisé, ce sont des pistes
concrètes identifiées en explorant le code actuel (`lib/services/`,
`lib/routes/`, `docs/`). Chaque entrée précise l'effort estimé, ce qui existe
déjà et peut être réutilisé, et un point de départ pour l'implémentation.

Légende effort : 🟢 rapide (quelques heures) · 🟡 moyen (un service complet,
mais pattern déjà connu) · 🔴 gros chantier (architecture nouvelle).

## Sommaire

- [Sécurité](#sécurité)
  - [Verrouillage anti brute-force sur le login](#verrouillage-anti-brute-force-sur-le-login)
  - [Authentification à deux facteurs (TOTP)](#authentification-à-deux-facteurs-totp)
  - [Tokens API personnels](#tokens-api-personnels)
- [Exploitation / Ops](#exploitation--ops)
  - [Fenêtres de maintenance](#fenêtres-de-maintenance)
  - [Suivi des déploiements](#suivi-des-déploiements)
  - [Rétention des archives de logs](#rétention-des-archives-de-logs)
  - [Export/import de configuration](#exportimport-de-configuration)
- [Observabilité](#observabilité)
  - [Endpoint Prometheus /metrics](#endpoint-prometheus-metrics)
  - [Rapports périodiques (digest)](#rapports-périodiques-digest)
  - [Page de statut publique](#page-de-statut-publique)
- [Confort utilisateur](#confort-utilisateur)
  - [Recherche globale (Cmd+K)](#recherche-globale-cmdk)
  - [Notifications web push](#notifications-web-push)
- [Ampleur / architecture](#ampleur--architecture)
  - [Multi-serveurs (fleet)](#multi-serveurs-fleet)

---

## Sécurité

### Verrouillage anti brute-force sur le login

🟢 — **Constat** : `lib/routes/auth.js#POST /login` appelle
`userStore.verifyCredentials()` sans aucune limite de tentatives. Un
attaquant avec accès réseau au port peut brute-forcer un mot de passe sans
frein (l'audit log enregistre bien chaque échec via `ACTIONS.LOGIN` /
`status: "failed"`, mais seulement _après coup_ — rien ne bloque l'attaque
en cours).

**Pistes** :

- Compteur en mémoire ou en base (`login_attempts` par IP + username),
  purgé après un login réussi ou un délai glissant.
- Réponse `429` + `Retry-After` au-delà d'un seuil (ex. 5 échecs / 5 min),
  sur le modèle du `dispatch-queue` existant (retry/backoff déjà écrit pour
  les notifications, même logique de fenêtre glissante réutilisable).
- L'audit log existant (`ACTIONS.LOGIN`, `status: "denied"`) peut servir de
  source si on préfère ne pas dupliquer le compteur en mémoire.

### Authentification à deux facteurs (TOTP)

🟡 — **Constat** : un compte admin compromis (mot de passe seul) a accès à
tout : gestion des utilisateurs, actions PM2 destructrices, Auto-Healing.
Pas de second facteur.

**Pistes** :

- Nouvelle table `user_totp` (secret chiffré avec la même clé AES-256-GCM
  déjà utilisée pour les secrets de providers de notification, voir
  `lib/services/notifications/` et `NOTIFICATIONS_ENCRYPTION_KEY` — même
  mécanisme, pas de nouvelle dépendance de chiffrement à introduire).
- Dépendance `otplib` ou équivalent pour génération/vérification TOTP + QR
  code d'enrôlement (`qrcode` npm).
- Étape supplémentaire dans `lib/routes/auth.js#POST /login` : si l'utilisateur
  a un TOTP actif, renvoyer un état intermédiaire `{ needsTotp: true }`
  plutôt que de poser `req.session.userId` directement.
- Codes de récupération (recovery codes) à usage unique, générés à
  l'activation — indispensable pour ne pas se retrouver bloqué hors du
  compte admin unique.

### Tokens API personnels

🟡 — **Constat** : toute intégration externe (script cron, CI, un second
outil qui veut lire `/api/system` ou déclencher un restart) doit aujourd'hui
passer par un cookie de session — donc un vrai login navigateur. Pas
d'authentification programmatique dédiée.

**Pistes** :

- Nouvelle table `api_tokens` (id, user_id, nom, hash du token — jamais le
  token en clair, comme les mots de passe dans `user-store.js`, `scopes`
  optionnel, `last_used_at`, `created_at`, `revoked_at`).
- Middleware alternatif à `auth.loadCurrentUser` : si l'en-tête
  `Authorization: Bearer <token>` est présent, résout l'utilisateur via le
  hash plutôt que via la session — se branche au même endroit que
  `auth.requireAuth`/`requirePermission`, donc les permissions existantes
  (`lib/permissions.js`) s'appliquent sans rien dupliquer.
- Gestion (créer/lister/révoquer) exposée uniquement à l'utilisateur
  propriétaire + admin, sur le modèle de `lib/routes/users.js`.
- Auditer la création/révocation d'un token (`lib/services/audit/`, nouvelle
  `ACTIONS.API_TOKEN_CREATE`/`REVOKE`) — un token est un moyen d'accès au
  même titre qu'un compte, doit laisser une trace.

## Exploitation / Ops

### Fenêtres de maintenance

🟡 — **Constat** : pendant un déploiement planifié (restart volontaire,
pic de CPU pendant un build), le moteur d'alertes déclenche des alertes et
des notifications "pour rien". Aujourd'hui la seule option est de couper
`ALERTS_ENABLED` globalement — trop large, et manuel.

**Pistes** :

- Nouveau service `lib/services/maintenance/` sur le pattern de
  `lib/services/auto-healing/` (settings + store) : une fenêtre a un scope
  (`system` ou un nom de process précis), un début, une fin (ou "jusqu'à
  arrêt manuel"), et un auteur.
- Point d'insertion unique : `lib/alert-dispatch.js#dispatchAlertTransition`
  — vérifier la fenêtre active _avant_ de dispatcher vers notifications/
  websocket/auto-healing. L'alerte continue d'être évaluée et stockée (pour
  l'historique), seule la diffusion est coupée — comportement cohérent avec
  la doc `docs/alerts/README.md` qui distingue déjà "évaluation" et
  "notification".
- UI : bouton "Pause 30 min" sur une carte de process ou dans le TopBar pour
  une pause globale, avec le compte à rebours visible.

### Suivi des déploiements

🟡 — **Constat** : la timeline d'événements (`lib/services/events/`)
capture les crashs et redémarrages PM2, mais rien ne dit _pourquoi_ — un
déploiement n'est pas distingué d'un crash. Corréler "ça a planté juste
après le déploy de telle version" demande de croiser manuellement les logs
de déploiement et la timeline.

**Pistes** :

- Nouvel endpoint `POST /api/deployments` (protégé par token API — voir
  ci-dessus — pas par cookie de session, puisqu'il sera appelé depuis un
  pipeline CI) acceptant `{ process, version, sha, author, notes }`.
- Réutilise `lib/services/events/` : un déploiement est un type d'événement
  de plus (`type: "deployment"`) dans la même table `process_events`, pas
  une nouvelle table — voir `lib/services/events/normalizer.js` pour le
  pattern de normalisation par type.
- Frontend : marqueur vertical sur les graphes `process-history` (Chart.js)
  aux timestamps de déploiement, pour visuellement aligner un pic
  CPU/restart avec un déploiement récent.

### Rétention des archives de logs

🟢 — **Constat** : `lib/log-store.js` fait déjà de la rotation par taille
(`LOG_ROTATE_SIZE_MB`) et compresse les anciennes archives (`.jsonl.gz`),
mais **rien ne les supprime jamais** — contrairement à `process-history`,
`events` et `audit` qui ont tous une politique de rétention configurable
(`PROCESS_HISTORY_*_RETENTION_MS`, `EVENTS_RETENTION_MS`,
`AUDIT_RETENTION_MS`). Sur un serveur avec des apps bavardes, `data/logs/`
grossit indéfiniment.

**Pistes** :

- `LOG_RETENTION_MS` (env, désactivé par défaut comme `AUDIT_RETENTION_MS`
  pour ne rien casser sur les installations existantes) : purge des
  archives `.jsonl.gz` plus vieilles que ce seuil.
- Réutiliser le `_sweepTimer` déjà présent dans `LogStore` (actuellement
  dédié à `compressOldArchives()`) plutôt que d'ajouter un second timer.

### Export/import de configuration

🟡 — **Constat** : les règles d'alerte, health checks et routes de
notification se configurent uniquement via l'UI, une par une. Reproduire la
config d'un serveur vers un autre (staging → prod, ou après réinstallation)
n'a pas de raccourci.

**Pistes** :

- `GET /api/config/export` : agrège `alert_rules`, `health_checks`,
  `notification_routes` (sans les secrets chiffrés des providers — ceux-là
  restent à ressaisir volontairement, pour ne jamais faire transiter un
  secret déchiffrable dans un fichier exporté) en un seul JSON versionnable.
- `POST /api/config/import` : réutilise les mêmes validations que les routes
  `POST`/`PUT` existantes de chaque domaine (`lib/routes/alerts.js`,
  `health-checks.js`, `notifications.js`) plutôt que d'en écrire de
  nouvelles — l'import n'est qu'une boucle d'appels aux create/update déjà
  validés.
- Permission dédiée (`config_export`/`config_import`, admin uniquement) et
  entrée d'audit à chaque import — un import modifie potentiellement toutes
  les règles d'alerte d'un coup, ça doit être traçable comme n'importe
  quelle action sensible.

## Observabilité

### Endpoint Prometheus /metrics

🟢 — **Constat** : toutes les données existent déjà (`systemStats.snapshot()`,
`pm2.list()` via `fmtProcess()`, compteurs d'alertes actives) mais uniquement
en JSON, consommables que par ce dashboard. Si quelqu'un a déjà du
Grafana/Alertmanager en place, il duplique le monitoring plutôt que de le
brancher dessus.

**Pistes** :

- Nouveau `lib/routes/metrics.js`, monté sur `/metrics` (hors `/api`, pas de
  `Cache-Control: no-store` ni de session requise — Prometheus scrape sans
  cookie ; prévoir plutôt une protection par IP allowlist ou token statique
  séparé si le port est exposé).
- Réutilise `systemStats.snapshot()` et `fmtProcess()` sans y toucher —
  seule la sérialisation change (format d'exposition texte Prometheus au
  lieu de JSON).
- Pas de dépendance à ajouter : le format d'exposition est du texte brut
  simple (`# HELP`/`# TYPE`/`metric{labels} valeur`), pas besoin de la lib
  `prom-client` pour un export aussi ciblé.

### Rapports périodiques (digest)

🟡 — **Constat** : les notifications actuelles (`lib/services/notifications/`)
sont toutes déclenchées par un événement (alerte, health check). Rien ne
donne une vue d'ensemble périodique ("qu'est-ce qui s'est passé cette
semaine ?") sans aller chercher soi-même dans la timeline/l'historique.

**Pistes** :

- Nouveau job planifié (réutilise `lib/services/queue/`, la file d'attente
  persistante déjà en place pour les notifications — pas de nouveau
  scheduler à écrire) qui tourne à intervalle fixe (quotidien/hebdo,
  configurable).
- Agrège `process-history` (uptime, pics CPU/RAM), `events` (nombre de
  crashs/restarts), `alerts` (déclenchées/résolues) et `audit` (actions
  sensibles) sur la période.
- Envoi via les providers déjà écrits et opérationnels
  (`lib/services/notifications/providers/`) — aucun nouveau canal
  d'envoi à implémenter, seulement un nouveau _déclencheur_ (temporel au
  lieu d'événementiel) et un template de contenu.

### Page de statut publique

🟡 — **Constat** : pas de vue sans authentification pour un uptime "public"
(montrer à un client ou une équipe externe que le service tourne, sans leur
donner un compte).

**Pistes** :

- Route dédiée, hors du middleware `auth.requireAuth` global — nécessite de
  sortir cette route du `app.use(auth.requireAuth)` appliqué globalement
  dans `server.js`, donc à monter _avant_ ce middleware plutôt qu'après.
- Contenu strictement en lecture, agrégé et anonymisé : statut
  online/dégradé/down par process _sélectionné explicitement_ pour être
  public (nouveau flag `publicStatus` sur le process ou une liste blanche en
  config) + historique d'uptime sur 90 jours — jamais les logs, jamais les
  détails de configuration.
- Risque principal à garder en tête : une page publique est une surface
  d'information exposée sans permission — bien vérifier qu'aucune donnée
  au-delà du statut choisi ne transite (pas de `env`, pas de `script path`,
  pas de nom de host interne).

## Confort utilisateur

### Recherche globale (Cmd+K)

🟢 — **Constat** : avec suffisamment de process/alertes/événements, naviguer
entre les onglets pour retrouver "le restart de tel process hier" devient
lent. Toutes les données (process, events, alertes, audit) sont déjà
exposées en REST, il manque juste un point d'entrée unifié côté frontend.

**Pistes** :

- Purement frontend : une palette de commande (raccourci clavier) qui
  interroge en parallèle `/api/processes`, `/api/events`, `/api/alerts/active`
  côté client, sans nouvel endpoint backend.
- Filtre par permission déjà appliqué côté serveur sur chacun de ces
  endpoints — rien à refiltrer côté client.

### Notifications web push

🟡 — **Constat** : les providers existants (Email/Discord/Telegram/Slack/
Webhook) demandent tous un service tiers configuré. Rien ne permet de
recevoir une alerte directement sur le navigateur/mobile de la personne
connectée, sans configuration externe.

**Pistes** :

- Nouveau provider dans `lib/services/notifications/providers/` (même
  interface `validateConfig`/`test`/`send` que les autres, voir
  `lib/services/notifications/types.js`) basé sur la Web Push API
  (`web-push` npm, clés VAPID générées une fois au démarrage).
- S'intègre au routing existant sans rien changer à
  `lib/services/notifications/routing/engine.js` — un provider de plus dans
  le registre, pas un nouveau chemin de dispatch.
- Nécessite un enregistrement de souscription côté frontend (Service
  Worker) par utilisateur — plus gros travail frontend que backend ici.

## Ampleur / architecture

### Multi-serveurs (fleet)

🔴 — **Constat** : l'app suppose un seul PM2 local (`require("pm2")` se
connecte au daemon de la machine hôte). Pour qui gère plusieurs VPS, c'est
une instance de pm2-monitor par machine, sans vue consolidée.

**Pistes** (à ne considérer que si le besoin est réel — c'est le plus gros
chantier de cette liste, il change une hypothèse structurelle du projet) :

- Option agent : un petit process sur chaque machine distante expose une
  API minimale (réutilisant `fmtProcess()`, `systemStats.snapshot()`) que
  l'instance centrale interroge à intervalle régulier — pas de tunnel PM2
  distant, juste du HTTP entre agent et instance centrale.
- Registre de serveurs (nouvelle table `remote_servers` : nom, URL agent,
  clé d'auth) géré depuis l'UI, sur le modèle CRUD déjà connu
  (`lib/routes/users.js`, `health-checks.js`).
- Le dashboard global existant (`lib/services/dashboard/`,
  `GET /api/dashboard`) est déjà l'endroit qui agrège plusieurs sources en
  un instantané — l'étendre à plusieurs serveurs plutôt qu'un serveur local
  unique est le point d'extension naturel, mais touche quasiment toutes les
  vues frontend (process, système, logs) qui supposent aujourd'hui une
  seule source.
- Alternative plus légère à explorer avant de se lancer là-dedans : ce
  chantier ne vaut le coup que s'il y a vraiment plusieurs machines à
  surveiller — sinon un `deploy.sh install` par serveur avec un lien
  bookmarké par instance reste largement suffisant.
