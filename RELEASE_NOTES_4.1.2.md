# v4.1.2

Ajoute le monitoring Docker en lecture seule (onglet « Docker », logs en
direct) et corrige la console de logs (historique stdout/stderr dans l'ordre
réel, bouton « Vider » qui vide vraiment, auto-scroll qui ne se fige plus)
ainsi que le responsive de toute l'interface. Tout ce qui suit était
jusqu'ici sous « [Non publié] » dans le CHANGELOG, sans tag ni release.

## [4.1.2] - 2026-11-08

### Ajouté

- **Docker Monitoring (Phase 22)** — monitoring en lecture seule des
  conteneurs Docker (état, CPU, RAM, réseau, I/O, PIDs, logs stdout/stderr
  en direct) dans un nouvel onglet « Docker », via le socket Docker local,
  sans nouvelle dépendance npm. Permissions `docker_read` / `docker_logs`,
  métriques Prometheus `pm2_monitor_docker_*`, variables
  `DOCKER_MONITORING_ENABLED`, `DOCKER_SOCKET_PATH`, `DOCKER_POLL_INTERVAL_MS`.
  Voir `docs/docker/README.md` (dont la section sécurité sur l'accès au
  socket Docker).
- `LogStore#tail()` : lecture des N **dernières** lignes (stdout + stderr,
  horodatées, dans leur ordre réel) d'une instance de process. Sert
  l'historique affiché à la sélection d'un process.
- Vue Process sur mobile (≤ 820 px) : un seul volet à la fois — liste des
  process **ou** logs en plein écran, avec un bouton « ← Processus ».
- Logs Docker : l'abonnement `docker:subscribe-logs` accepte `since` et
  l'événement `docker:log-error` porte `ended` (flux interrompu par un
  arrêt/redémarrage du conteneur).

### Modifié

- `GET /api/processes/:id/logs/tail` : l'historique est lu depuis le
  LogStore (ordre réel stdout/stderr, une heure par ligne) et complété par
  les fichiers natifs PM2 uniquement pour ce qui est plus ancien, sans
  doublon. La réponse gagne `source` (`store` | `native`) et `at` par ligne.
  Sans données du LogStore, repli sur les fichiers natifs (chronologique si
  PM2 écrit les horodatages, sinon stdout puis stderr, séparés par un
  libellé).
- Bouton « Vider » de la console de logs : il appelle désormais
  `POST /api/processes/:id/flush` (après confirmation) et supprime les
  fichiers de log PM2 **et** l'historique du Log Explorer pour ce process.
  Sans la permission `flush`, il vide l'affichage seul et le signale. Côté
  Docker (lecture seule), il vide l'affichage et retient l'instant du
  vidage pour ne plus recharger l'historique antérieur.
- Interface responsive : barre du haut refondue (onglets sur leur propre
  ligne, actions réduites à leur icône sous 1700 px, défilement horizontal
  sur petit écran), menu PM2 ancré sous son bouton, `100dvh`, grille de la
  vue Process à largeur souple, barres d'outils de logs défilantes sur
  mobile.
- README mis à jour : arborescence complète du dépôt (22 migrations, tous les
  services, routes, composants), nouvelle référence des variables
  d'environnement, section Tests, logs (historique, « Vider »), Docker et
  responsive ; liens vers des fichiers supprimés retirés, ajout d'un index
  de la documentation par fonctionnalité.

### Corrigé

- Console de logs : l'historique plaçait tout stderr après tout stdout, si
  bien que la fin de liste (où l'auto-scroll se positionne) n'était que des
  erreurs, parfois très anciennes — impression de ne voir que les erreurs.
- Console de logs (PM2 et Docker) : l'auto-scroll se figeait une fois le
  plafond de 4000 lignes atteint (il surveillait `logs.length`, constante à
  partir de là) ; il suit désormais le compteur de lignes.
- Bouton « Vider » : il ne vidait que la liste en mémoire du navigateur ;
  les lignes revenaient à la re-sélection du process.
- Logs Docker : le flux ne reprenait pas après un redémarrage du conteneur,
  et des lignes pouvaient être perdues entre la lecture de l'historique et
  l'ouverture du flux.
- File d'attente de pause des logs non bornée (croissance mémoire du
  navigateur sur une app bavarde laissée en pause) ; plafonnée comme
  l'affichage.
- Interface : la page débordait horizontalement (jusqu'à ~1580 px de large)
  à toutes les largeurs d'écran à cause de la barre du haut ; plus aucun
  débordement sur les vues testées (390, 820 et 1280 px).

**Full Changelog**: https://github.com/nogebeat/pm2-monitor/compare/v4.0.0...v4.1.2
