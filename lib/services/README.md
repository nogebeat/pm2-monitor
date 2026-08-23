# lib/services/

Ce dossier regroupe les services applicatifs du monitor : des modules
autonomes, testables indépendamment, qui ne connaissent pas Express ni
Socket.IO (contrairement à `server.js` et `lib/routes/`/`lib/realtime/`, qui
restent la couche de transport HTTP/WebSocket — voir
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) pour le détail de ce
découpage, décidé en Phase 1).

## Services existants

- **`queue/`** — file d'attente persistante générique (jobs stockés en base,
  survivent à un redémarrage). Brique réutilisée telle quelle par
  `notifications/` (retry/backoff des envois). Voir
  [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).
- **`alerts/`** — moteur d'alertes configurable (CPU/RAM/disque/
  température/restarts/statut, par process ou système), seuils, durée avant
  déclenchement, cooldown anti-spam, déduplication. Voir
  [`docs/alerts/README.md`](../../docs/alerts/README.md).
- **`process-history/`** — historique CPU/RAM/restarts par process,
  multi-résolution (`raw`/`medium`/`long`) avec purge automatique. Voir
  la section dédiée du [README principal](../../README.md).
- **`events/`** — timeline d'événements/crashs PM2 (start, stop, restart,
  crash, changement de statut), rétention configurable. Voir
  [`docs/events/README.md`](../events/README.md).
- **`notifications/`** — providers Email/Discord/Telegram/Slack/Webhook,
  routing par règles depuis l'Alert Engine, file d'attente fiable
  (retry/backoff/rate limiting/dédup), secrets chiffrés au repos
  (AES-256-GCM). Voir [`docs/notifications/README.md`](../notifications/README.md).
- **`health-checks/`** — sondes HTTP/TCP/Command indépendantes du statut
  PM2, alimentent l'Alert Engine existant sans code de dispatch dupliqué.
  Voir [`docs/health-checks/README.md`](../health-checks/README.md).
- **`auto-healing/`** — redémarrage automatique déclenché par une transition
  d'alerte ou un crash PM2, garde-fous (cooldown, limite de tentatives,
  état "bloqué"), désactivé par défaut en base. Voir
  [`docs/auto-healing/README.md`](../auto-healing/README.md).
- **`audit/`** — journal d'audit append-only des actions sensibles
  (start/stop/restart/delete, modification d'env/config, actions daemon
  PM2, connexions...), sanitization des secrets, rétention optionnelle. Voir
  [`docs/audit/README.md`](../audit/README.md).
- **`dashboard/`** — vue globale (`GET /api/dashboard`), fonctions pures de
  calcul de statut composant les services ci-dessus, aucune nouvelle source
  de données ni nouveau canal temps réel. Voir
  [`docs/dashboard/README.md`](../dashboard/README.md).
- **`incidents/`** — corrélation déterministe des alertes en incidents
  suivis (cycle de vie, timeline fusionnée sans duplication) et silences de
  notification (règle/process/tag/environnement/groupe), branché sur
  l'Alert Engine et le routing des notifications sans les modifier. Voir
  [`docs/incidents/README.md`](../incidents/README.md).

## Comment un service se branche au reste de l'app

Chaque service :

- expose un singleton (ou une classe instanciée une fois dans `server.js`
  si son constructeur a un état/lit `process.env`) depuis son `index.js` ;
- est consommé par un routeur dédié dans `lib/routes/` (aucune logique
  métier dans les routeurs, uniquement validation + appel au service) ;
- si le service a besoin d'être notifié en continu (nouveau relevé système,
  transition d'alerte, événement PM2...), il est branché depuis
  `lib/polling.js` (boucles `setInterval`), `lib/realtime/pm2-bus.js` (bus
  de logs/événements PM2) ou `lib/alert-dispatch.js` (fan-out d'une
  transition d'alerte) — jamais un second poller/listener dédié pour la
  même source ;
- reste configurable/désactivable via `.env` (voir `.env.example`) sans
  changer de code.

`server.js` lui-même ne fait qu'orchestrer : charger la config, instancier
les services, monter les routeurs et le temps réel, démarrer. Voir la
structure du dépôt dans le [README principal](../../README.md).
