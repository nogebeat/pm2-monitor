# lib/services/

Ce dossier regroupe les services applicatifs du monitor : des modules
autonomes, testables indépendamment, qui ne connaissent pas Express ni
Socket.IO (contrairement à `server.js`, qui reste la couche de transport
HTTP/WebSocket).

## Existant (Phase 1 — fondations)

- **`queue/`** — file d'attente persistante générique (voir
  `queue/persistent-queue.js`). Aucune logique métier dedans : c'est une
  brique réutilisable par les services listés ci-dessous, qui seront
  implémentés dans des phases ultérieures.

## Prévu pour les phases suivantes

Ces dossiers **n'existent pas encore** — ils ne sont créés que lorsque la
phase correspondante en a réellement besoin, pour éviter du code mort :

- **`alerts/`** — règles de déclenchement d'alertes (process down, seuil
  CPU/mémoire dépassé, etc.) et leur évaluation périodique.
- **`notifications/`** — envoi effectif des notifications (email, webhook,
  Slack…), consommateur typique de `queue/`.
- **`metrics/`** — agrégation/rétention des métriques process au-delà de ce
  que fait déjà `lib/history-store.js` (système, court terme).
- **`events/`** — bus d'événements applicatifs internes (ex: "process
  redémarré", "seuil dépassé"), point d'entrée commun pour `alerts/` et
  `metrics/`, indépendant du bus PM2 déjà utilisé dans `server.js`.
- **`health/`** — évaluation de l'état de santé global d'une app (au-delà du
  simple statut PM2 : ex. croiser statut + logs d'erreur récents).
- **`healing/`** — actions correctives automatiques (ex: redémarrage auto
  après N erreurs), construites sur `pm2-actions.js` existant.
- **`audit/`** — journal des actions effectuées par les utilisateurs
  (qui a redémarré quoi, quand), pour la traçabilité en environnement
  multi-utilisateurs.

Chaque service, une fois implémenté, doit rester indépendant de
`server.js` (pas de logique métier dans le serveur HTTP), documenté, testé,
et si pertinent configurable/désactivable via `.env` — voir les règles
communes du projet.
