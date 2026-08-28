#!/usr/bin/env bash
#
# deploy.sh — Script de déploiement complet pour PM2 Monitor
#
# Gère : installation de Node.js/PM2 si absents, config .env avec mot de
# passe généré, démarrage via PM2, persistance au reboot (pm2 startup),
# reverse proxy nginx + HTTPS (Let's Encrypt) optionnel, pare-feu (ufw)
# optionnel, mise à jour, statut, logs et désinstallation.
#
# Conçu pour être idempotent : on peut le relancer sans casser une
# installation existante. Testé pour Ubuntu/Debian (apt) et
# CentOS/RHEL/Rocky/AlmaLinux (dnf/yum). Fonctionne en root ou via sudo.
#
# Usage :
#   ./deploy.sh install [options]
#   ./deploy.sh update
#   ./deploy.sh status | logs | restart | stop
#   ./deploy.sh users <list|create|passwd|delete|grant|revoke|promote|demote|role> [args…]
#   ./deploy.sh migrate <up|down|status> [--to <version>] [--steps <n>]
#   ./deploy.sh uninstall [--purge]
#
# Options d'installation :
#   --port <n>            Port d'écoute (défaut : 4200)
#   --user <nom>           Identifiant du compte admin créé au premier démarrage (défaut : admin)
#   --pass <motdepasse>    Mot de passe de ce compte admin (défaut : généré aléatoirement)
#   --env-file <chemin>    Charge un fichier .env déjà prêt (copié tel quel comme .env du
#                           projet) au lieu de générer la config à partir des autres options.
#                           Prioritaire sur --port/--user/--pass/--db-* : ces options sont
#                           ignorées si --env-file est fourni (édite le fichier source à la
#                           place). Le fichier doit exister et être lisible ; il est copié
#                           avec des permissions restreintes (600).
#   --domain <domaine>     Domaine pour nginx + HTTPS (ex: pm2.mondomaine.fr)
#   --email <email>        Email pour Let's Encrypt (requis si --domain)
#   --no-nginx             Ne pas configurer nginx (accès direct par IP:port)
#   --no-firewall          Ne pas toucher au pare-feu
#   --no-startup           Ne pas configurer le démarrage automatique au boot
#   --db-driver <driver>   sqlite (défaut, zéro-config) ou mysql
#   --db-host <host>       Hôte MySQL (si --db-driver mysql, défaut : 127.0.0.1)
#   --db-port <port>       Port MySQL (défaut : 3306)
#   --db-user <user>       Utilisateur MySQL
#   --db-pass <pass>       Mot de passe MySQL
#   --db-name <name>       Base MySQL (défaut : pm2_monitor)
#   --yes                  Mode non-interactif (répond "oui" aux confirmations)
#   -h, --help             Affiche cette aide
#
# Variables d'environnement :
#   DEPLOY_SKIP_TESTS=1        Ignore l'étape de tests avant démarrage (déconseillé) —
#                               install/update refusent sinon de continuer si un test échoue.
#   DEPLOY_SKIP_HEALTHCHECK=1  Ignore la vérification que l'app répond après démarrage
#                               (déconseillé — c'est ce qui permet le rollback automatique
#                               en cas d'update cassé).
#   HEALTH_TIMEOUT=<secondes>  Délai max d'attente de cette vérification (défaut : 30).
#
# install/update écrivent aussi un journal complet dans logs/deploy-*.log, et
# refusent de tourner en parallèle (verrou .deploy.lock).
#
# Gestion des comptes / permissions (users/roles multi-utilisateurs, par app
# et par action) : une fois installé, utilise `./deploy.sh users …`, qui
# délègue à `node bin/manage-users.js` — voir le README pour le détail des
# actions disponibles (view, restart, stop, logs, env, config, scale…).
#
set -euo pipefail

# ---------------------------------------------------------------------
# Configuration / constantes
# ---------------------------------------------------------------------

APP_NAME="pm2-monitor"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

PORT="4200"
AUTH_USER="admin"
AUTH_PASS=""
DOMAIN=""
EMAIL=""
USE_NGINX="1"
USE_FIREWALL="1"
USE_STARTUP="1"
NON_INTERACTIVE="0"

DB_DRIVER="sqlite"
DB_HOST="127.0.0.1"
DB_PORT="3306"
DB_USER=""
DB_PASS=""
DB_NAME="pm2_monitor"

# ---------------------------------------------------------------------
# Utilitaires d'affichage
# ---------------------------------------------------------------------

c_reset="\033[0m"; c_bold="\033[1m"
c_green="\033[32m"; c_red="\033[31m"; c_yellow="\033[33m"; c_blue="\033[36m"

info()  { echo -e "${c_blue}➜${c_reset} $*"; }
ok()    { echo -e "${c_green}✔${c_reset} $*"; }
warn()  { echo -e "${c_yellow}⚠${c_reset} $*"; }
error() { echo -e "${c_red}✘${c_reset} $*" >&2; }
title() { echo -e "\n${c_bold}$*${c_reset}"; }

confirm() {
  # confirm "question" -> 0 si oui
  [ "$NON_INTERACTIVE" = "1" ] && return 0
  read -r -p "$1 [o/N] " reply
  [[ "$reply" =~ ^([oO]|[yY])$ ]]
}

# ---------------------------------------------------------------------
# Détection environnement
# ---------------------------------------------------------------------

SUDO=""
detect_privileges() {
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
  elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    error "Ce script nécessite les droits root ou sudo pour installer des paquets."
    exit 1
  fi
}

PKG_MANAGER=""
detect_pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    PKG_MANAGER="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PKG_MANAGER="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PKG_MANAGER="yum"
  else
    warn "Gestionnaire de paquets non reconnu (ni apt, ni dnf, ni yum)."
    warn "Node.js et nginx devront être installés manuellement si absents."
    PKG_MANAGER="none"
  fi
}

pkg_install() {
  # pkg_install paquet1 paquet2 ...
  case "$PKG_MANAGER" in
    apt) $SUDO apt-get update -qq && $SUDO apt-get install -y "$@" ;;
    dnf) $SUDO dnf install -y "$@" ;;
    yum) $SUDO yum install -y "$@" ;;
    *)   error "Impossible d'installer automatiquement : $* (gestionnaire de paquets inconnu)"; return 1 ;;
  esac
}

# ---------------------------------------------------------------------
# Verrou de concurrence
# ---------------------------------------------------------------------
#
# Empêche deux exécutions simultanées de deploy.sh (ex: install lancé deux
# fois par erreur, ou update déclenché pendant qu'un install tourne encore)
# de se marcher dessus sur les mêmes fichiers (.env, node_modules, public/,
# état PM2…). Utilise flock sur un fichier dédié ; si flock est absent
# (rare), on continue sans verrou plutôt que de bloquer le script.
LOCK_FD=""
acquire_lock() {
  local lock_file="$SCRIPT_DIR/.deploy.lock"
  if ! command -v flock >/dev/null 2>&1; then
    warn "flock indisponible : impossible de garantir qu'une seule exécution de deploy.sh tourne à la fois."
    return 0
  fi
  exec {LOCK_FD}>"$lock_file"
  if ! flock -n "$LOCK_FD"; then
    error "Une autre exécution de deploy.sh (install/update/uninstall) semble déjà en cours."
    error "Si ce n'est pas le cas (crash précédent), supprime $lock_file puis relance."
    exit 1
  fi
}

# ---------------------------------------------------------------------
# Étapes d'installation
# ---------------------------------------------------------------------

ensure_nodejs() {
  title "Node.js"
  # La version minimale requise vient de "engines.node" dans package.json
  # (actuellement >=20) : on la lit dynamiquement au lieu de la dupliquer en
  # dur ici, pour ne plus jamais désynchroniser deploy.sh du package.json
  # (c'est exactement ce qui s'était produit : ce script acceptait encore
  # Node 16/18 alors que le projet exige >=20 depuis un moment — un
  # "déploiement réussi" pouvait donc tourner sur une version non supportée,
  # avec des plantages difficiles à diagnostiquer plus tard).
  local required_major
  required_major="$(grep -oE '"node"[[:space:]]*:[[:space:]]*"[^"]*"' "$SCRIPT_DIR/package.json" \
    | grep -oE '[0-9]+' | head -1)"
  [ -z "$required_major" ] && required_major=22 # filet de sécurité si le champ change de format

  if command -v node >/dev/null 2>&1; then
    local ver major
    ver="$(node -v)"
    major="$(echo "$ver" | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "$major" -ge "$required_major" ]; then
      ok "Node.js $ver déjà présent (>= v${required_major} requis)."
      return 0
    fi
    warn "Node.js $ver trouvé, mais le projet requiert >= v${required_major} : mise à jour en cours."
  else
    info "Node.js absent, installation en cours…"
  fi

  case "$PKG_MANAGER" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${required_major}.x" | $SUDO bash - >/dev/null
      pkg_install nodejs
      ;;
    dnf|yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${required_major}.x" | $SUDO bash - >/dev/null
      pkg_install nodejs
      ;;
    *)
      error "Installe Node.js >= v${required_major} manuellement puis relance ce script."
      exit 1
      ;;
  esac

  local installed_major
  installed_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  if [ "$installed_major" -lt "$required_major" ]; then
    error "Node.js $(node -v) installé, mais toujours < v${required_major} requis."
    error "Le paquet système disponible est trop ancien : mets à jour Node.js manuellement (nvm, nodesource...) puis relance."
    exit 1
  fi
  ok "Node.js $(node -v) installé."
}

ensure_pm2() {
  title "PM2"
  if command -v pm2 >/dev/null 2>&1; then
    ok "PM2 déjà installé ($(pm2 -v))."
  else
    info "Installation de PM2 (npm global)…"
    $SUDO npm install -g pm2 >/dev/null
    ok "PM2 installé."
  fi
}

ensure_build_tools() {
  # better-sqlite3 fournit des binaires précompilés pour la plupart des plateformes
  # courantes, mais sur une archi/distribution rare npm doit compiler depuis les
  # sources : on installe alors les outils nécessaires pour que ça ne casse pas.
  title "Outils de compilation natifs (au besoin)"
  case "$PKG_MANAGER" in
    apt) pkg_install build-essential python3 >/dev/null 2>&1 || true ;;
    dnf|yum) pkg_install gcc-c++ make python3 >/dev/null 2>&1 || true ;;
    *) : ;;
  esac
  ok "Prêt (utilisés seulement si aucun binaire précompilé n'est disponible)."
}

ensure_dependencies() {
  title "Dépendances du projet"
  cd "$SCRIPT_DIR"
  ensure_build_tools
  if [ -d node_modules ] && [ -f node_modules/.deploy-installed ]; then
    ok "Dépendances déjà installées."
  else
    info "npm install… (inclut la base de données locale SQLite par défaut)"
    npm install --omit=dev
    if [ "$DB_DRIVER" = "mysql" ]; then
      info "DB_DRIVER=mysql : installation de la dépendance mysql2…"
      npm install mysql2 --omit=dev --no-save || warn "Échec d'installation de mysql2, vérifie ta connexion npm."
    fi
    touch node_modules/.deploy-installed
    ok "Dépendances installées."
  fi
  ensure_native_modules_rebuilt
}

# `npm install` seul NE recompile PAS les modules natifs (better-sqlite3...)
# quand seule la version de Node a changé sous le capot (ex: ce script vient
# de passer de Node 20 à 22 dans ensure_nodejs) : package.json et le
# lockfile n'ont pas bougé, donc npm considère tout "up to date" alors que le
# binaire .node reste compilé pour l'ancien NODE_MODULE_VERSION — ce qui fait
# planter le démarrage (ERR_DLOPEN_FAILED) une fois l'app relancée sur le
# nouveau Node. On compare la version de Node utilisée à la dernière
# installation à la version actuelle, et on force `npm rebuild` si elles
# diffèrent (no-op sinon, donc sans coût sur les runs suivants).
ensure_native_modules_rebuilt() {
  local stamp="node_modules/.deploy-node-version" current_version
  current_version="$(node -v)"
  if [ -f "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$current_version" ]; then
    return 0
  fi
  info "Version de Node différente de la dernière installation (ou première installation) : recompilation des modules natifs (better-sqlite3...)…"
  npm rebuild --omit=dev
  echo "$current_version" > "$stamp"
  ok "Modules natifs à jour pour Node $current_version."
}

ensure_frontend_build() {
  title "Frontend (Vue 3 + Vite)"
  cd "$SCRIPT_DIR"
  info "Installation des dépendances frontend et build de production…"
  npm --prefix frontend install --no-audit --no-fund >/dev/null
  npm --prefix frontend run build
  ok "Frontend construit dans public/."
}

# Applique les migrations DB avant de démarrer/redémarrer l'application, pour
# ne jamais servir du trafic sur un schéma obsolète. `migrate up` est
# idempotent (il ne rejoue que les migrations réellement en attente), donc
# relancer deploy.sh plusieurs fois de suite (install ou update) est sans
# risque : aucune migration n'est appliquée deux fois. En cas d'échec d'une
# migration, `set -euo pipefail` interrompt immédiatement le déploiement
# (le service en cours, s'il tournait déjà, n'est pas redémarré sur un état
# invalide).
run_migrations() {
  title "Migrations de base de données"
  cd "$SCRIPT_DIR"
  info "Vérification et application des migrations en attente…"
  node bin/migrate.js up
  ok "Base de données à jour."
}

# Exécute la suite de tests (node --test, voir test/unit/ et test/integration/)
# avant de démarrer/redémarrer l'application. Toutes les dépendances utilisées
# par les tests (express, better-sqlite3…) sont des dépendances de production
# normales (pas devDependencies), donc déjà installées par ensure_dependencies
# à ce stade — pas d'installation supplémentaire nécessaire ici.
# `set -euo pipefail` fait échouer tout le script (donc refuse le déploiement)
# si un test échoue : DEPLOY_SKIP_TESTS=1 permet de le contourner explicitement
# (ex: environnement sans écriture disque pour SQLite temporaire), à utiliser
# en connaissance de cause seulement.
run_tests() {
  title "Tests (node --test)"
  cd "$SCRIPT_DIR"
  if [ "${DEPLOY_SKIP_TESTS:-0}" = "1" ]; then
    warn "DEPLOY_SKIP_TESTS=1 : tests ignorés (déconseillé)."
    return 0
  fi
  info "Exécution de la suite de tests (unit + integration)…"
  npm test
  ok "Tous les tests passent."
}

ensure_mysql_config() {
  [ "$DB_DRIVER" = "mysql" ] || return 0
  title "Configuration MySQL"
  if [ -z "$DB_USER" ] && [ "$NON_INTERACTIVE" != "1" ]; then
    read -r -p "Utilisateur MySQL : " DB_USER
  fi
  if [ -z "$DB_PASS" ] && [ "$NON_INTERACTIVE" != "1" ]; then
    read -r -s -p "Mot de passe MySQL : " DB_PASS
    echo ""
  fi
  if [ -z "$DB_USER" ]; then
    error "DB_DRIVER=mysql requiert --db-user (et --db-pass) en mode --yes."
    exit 1
  fi
  ok "Connexion MySQL configurée : ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  info "Assure-toi que cette base et cet utilisateur existent déjà (le script ne crée pas la base MySQL elle-même, seulement ses tables au premier démarrage)."
}

random_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 20
  else
    tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20
  fi
}

# ---------------------------------------------------------------------
# Config depuis un .env existant (idempotence install/update)
# ---------------------------------------------------------------------
#
# Sans ça : sur une réinstallation (`install` relancé sans flags) ou une
# `update`, les étapes suivantes (ensure_mysql_config, ensure_dependencies,
# nginx via $PORT…) voyaient les valeurs par défaut du script ("sqlite",
# port 4200…) au lieu de la config réellement choisie au premier install —
# silencieux mais faux : un `./deploy.sh update` sur une install MySQL, par
# exemple, ne réinstallait jamais mysql2 et pouvait dériver de la config
# réelle. On relit donc le .env existant ici, AVANT le parsing des options
# CLI, pour que ces dernières restent prioritaires si explicitement passées
# (--port, --db-driver, etc. continuent de gagner).
env_file_get() {
  # env_file_get CLE [défaut]
  local key="$1" default="${2:-}" val
  [ -f "$ENV_FILE" ] || { echo "$default"; return; }
  val="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  [ -n "$val" ] && echo "$val" || echo "$default"
}

load_env_defaults() {
  [ -f "$ENV_FILE" ] || return 0
  PORT="$(env_file_get PORT "$PORT")"
  AUTH_USER="$(env_file_get PM2_MONITOR_USER "$AUTH_USER")"
  DB_DRIVER="$(env_file_get DB_DRIVER "$DB_DRIVER")"
  DB_HOST="$(env_file_get DB_HOST "$DB_HOST")"
  DB_PORT="$(env_file_get DB_PORT "$DB_PORT")"
  DB_USER="$(env_file_get DB_USER "$DB_USER")"
  DB_PASS="$(env_file_get DB_PASS "$DB_PASS")"
  DB_NAME="$(env_file_get DB_NAME "$DB_NAME")"
  # AUTH_PASS n'est volontairement JAMAIS relu ici : write_env() ne réécrit
  # de toute façon pas le .env s'il existe déjà et qu'aucun --pass n'est
  # fourni. Le relire romprait cette détection ("--pass fourni ?") et
  # déclencherait une régénération involontaire du mot de passe admin.
}

write_env() {
  title "Configuration (.env)"

  if [ -f "$ENV_FILE" ] && [ -z "$AUTH_PASS" ]; then
    ok "Fichier .env déjà présent, conservé tel quel."
    # PORT/DB_DRIVER/etc. déjà rechargés depuis ce même fichier par
    # load_env_defaults() avant le parsing des options CLI (voir plus bas) :
    # rien à refaire ici.
    return 0
  fi

  [ -z "$AUTH_PASS" ] && AUTH_PASS="$(random_password)"
  local session_secret
  session_secret="$(random_password)"

  {
    echo "PORT=${PORT}"
    echo ""
    echo "# Compte admin créé automatiquement au tout premier démarrage (voir README ->"
    echo "# section Multi-utilisateurs). Peut être retiré du .env une fois ce compte créé."
    echo "PM2_MONITOR_USER=${AUTH_USER}"
    echo "PM2_MONITOR_PASS=${AUTH_PASS}"
    echo ""
    echo "SESSION_SECRET=${session_secret}"
    echo ""
    echo "DB_DRIVER=${DB_DRIVER}"
    if [ "$DB_DRIVER" = "mysql" ]; then
      echo "DB_HOST=${DB_HOST}"
      echo "DB_PORT=${DB_PORT}"
      echo "DB_USER=${DB_USER}"
      echo "DB_PASS=${DB_PASS}"
      echo "DB_NAME=${DB_NAME}"
    fi
  } > "$ENV_FILE"

  chmod 600 "$ENV_FILE"
  ok "Fichier .env généré (base de données : ${DB_DRIVER})."
  echo -e "   ${c_bold}Identifiant admin :${c_reset} ${AUTH_USER}"
  echo -e "   ${c_bold}Mot de passe :${c_reset} ${AUTH_PASS}"
  echo -e "   ${c_yellow}Note ces identifiants, ils ne seront plus réaffichés en clair.${c_reset}"
  echo -e "   Gère ensuite les comptes/permissions via le menu \"Utilisateurs\" (admin) ou :"
  echo -e "   ${c_bold}./deploy.sh users list${c_reset}"
}

validate_port() {
  # Valide $PORT une bonne fois avant de générer le .env / nginx / ufw avec.
  # Auparavant une valeur vide ou non numérique (typo sur --port) n'était
  # détectée qu'au moment très tardif où node.js refuse de "listen" dessus —
  # ou pire, passait silencieusement dans le .env, la conf nginx et les
  # règles ufw sans jamais être vérifiée.
  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    error "Port invalide : '${PORT}' (attendu : un entier entre 1 et 65535)."
    exit 1
  fi
}

# Vérifie que l'application répond réellement après (re)démarrage, au lieu de
# se fier au seul code de retour de `pm2 start/restart` (qui réussit même si
# le process crash-loop juste après — mauvais port déjà utilisé, erreur de
# config, migration oubliée…). Sans ça, le script pouvait afficher
# "C'est en ligne 🎉" sur un service en réalité mort.
# Accepte n'importe quel code HTTP < 500 (y compris 401/302 dus à l'auth) :
# on vérifie que le serveur répond, pas que la requête est autorisée.
wait_for_health() {
  local timeout="${HEALTH_TIMEOUT:-30}" waited=0 code
  if [ "${DEPLOY_SKIP_HEALTHCHECK:-0}" = "1" ]; then
    warn "DEPLOY_SKIP_HEALTHCHECK=1 : vérification de démarrage ignorée (déconseillé)."
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl indisponible : impossible de vérifier que l'application répond réellement."
    return 0
  fi
  info "Vérification que l'application répond sur le port ${PORT}…"
  while [ "$waited" -lt "$timeout" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${PORT}/" || echo "000")"
    if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then
      ok "Application UP (HTTP ${code} sur 127.0.0.1:${PORT})."
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  error "L'application ne répond toujours pas sur 127.0.0.1:${PORT} après ${timeout}s."
  error "Dernières lignes de logs PM2 :"
  pm2 logs "$APP_NAME" --lines 30 --nostream 2>&1 | sed 's/^/    /' >&2 || true
  return 1
}

start_app() {
  title "Démarrage de l'application"
  cd "$SCRIPT_DIR"
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    info "Process PM2 existant détecté, redémarrage avec la config à jour…"
    pm2 restart "$APP_NAME" --update-env >/dev/null
  else
    pm2 start server.js --name "$APP_NAME" >/dev/null
  fi

  if ! wait_for_health; then
    error "Déploiement interrompu : l'application ne démarre pas correctement."
    error "Le process PM2 '${APP_NAME}' reste en l'état pour inspection (./deploy.sh logs)."
    error "Corrige le problème puis relance ./deploy.sh install (ou update)."
    exit 1
  fi

  pm2 save >/dev/null
  ok "Application démarrée sous PM2 (nom: $APP_NAME)."
}

setup_startup() {
  [ "$USE_STARTUP" = "1" ] || { warn "Démarrage automatique au boot ignoré (--no-startup)."; return 0; }
  title "Démarrage automatique au reboot"
  local out
  if out="$(pm2 startup 2>&1)"; then
    local cmd
    cmd="$(echo "$out" | grep -E '^sudo ' || true)"
    if [ -n "$cmd" ]; then
      info "Exécution de la commande générée par PM2…"
      eval "$cmd" >/dev/null 2>&1 && ok "Démarrage automatique configuré." \
        || warn "Impossible d'exécuter automatiquement la commande pm2 startup. Lance-la manuellement :\n   $cmd"
    else
      ok "pm2 startup déjà configuré ou aucune action nécessaire."
    fi
  else
    warn "pm2 startup a échoué (systemd absent ? conteneur minimal ?)."
    warn "L'appli reste gérée par PM2 mais ne redémarrera pas seule après un reboot."
  fi
}

setup_nginx() {
  [ "$USE_NGINX" = "1" ] || { info "Configuration nginx ignorée (--no-nginx)."; return 0; }
  if [ -z "$DOMAIN" ]; then
    info "Pas de --domain fourni : nginx ignoré, accès direct via http://<IP-du-serveur>:${PORT}"
    return 0
  fi

  title "Reverse proxy nginx (${DOMAIN})"

  if ! command -v nginx >/dev/null 2>&1; then
    info "nginx absent, installation…"
    pkg_install nginx
  fi

  local conf_path="/etc/nginx/sites-available/${APP_NAME}.conf"
  local conf_dir_style="1"
  if [ ! -d /etc/nginx/sites-available ]; then
    # CentOS/RHEL : pas de sites-available par défaut
    conf_dir_style="0"
    conf_path="/etc/nginx/conf.d/${APP_NAME}.conf"
  fi

  $SUDO tee "$conf_path" >/dev/null <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  if [ "$conf_dir_style" = "1" ]; then
    $SUDO ln -sf "$conf_path" "/etc/nginx/sites-enabled/${APP_NAME}.conf"
  fi

  if $SUDO nginx -t >/dev/null 2>&1; then
    $SUDO systemctl reload nginx
    ok "nginx configuré et rechargé pour ${DOMAIN} → 127.0.0.1:${PORT}."
  else
    error "Configuration nginx invalide, vérifie $conf_path"
    $SUDO nginx -t || true
    return 1
  fi

  setup_certbot
}

setup_certbot() {
  title "HTTPS (Let's Encrypt)"
  if [ -z "$EMAIL" ]; then
    warn "Pas de --email fourni : certificat HTTPS ignoré."
    warn "Relance avec --domain ${DOMAIN} --email toi@exemple.com pour l'activer,"
    warn "ou lance manuellement : sudo certbot --nginx -d ${DOMAIN}"
    return 0
  fi

  if ! command -v certbot >/dev/null 2>&1; then
    info "certbot absent, installation…"
    case "$PKG_MANAGER" in
      apt) pkg_install certbot python3-certbot-nginx ;;
      dnf|yum) pkg_install certbot python3-certbot-nginx ;;
      *) warn "Installe certbot manuellement pour activer HTTPS."; return 0 ;;
    esac
  fi

  info "Demande du certificat pour ${DOMAIN}…"
  if $SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
    ok "HTTPS activé : https://${DOMAIN}"
  else
    warn "certbot a échoué (le domaine pointe-t-il bien vers ce serveur ? port 80 ouvert ?)."
    warn "Réessaie plus tard avec : sudo certbot --nginx -d ${DOMAIN}"
  fi
}

setup_firewall() {
  [ "$USE_FIREWALL" = "1" ] || { info "Configuration du pare-feu ignorée (--no-firewall)."; return 0; }

  if ! command -v ufw >/dev/null 2>&1; then
    info "ufw non présent, étape pare-feu ignorée (rien à faire ou pare-feu géré autrement)."
    return 0
  fi

  title "Pare-feu (ufw)"
  $SUDO ufw allow OpenSSH >/dev/null 2>&1 || true

  if [ -n "$DOMAIN" ] && [ "$USE_NGINX" = "1" ]; then
    $SUDO ufw allow 'Nginx Full' >/dev/null 2>&1 || $SUDO ufw allow 80,443/tcp >/dev/null 2>&1
    ok "Ports 80/443 autorisés (accès via nginx)."
    if $SUDO ufw status | grep -q "${PORT}/tcp"; then
      $SUDO ufw delete allow "${PORT}/tcp" >/dev/null 2>&1 || true
    fi
    info "Port ${PORT} laissé fermé côté extérieur (accès uniquement via nginx en local)."
  else
    $SUDO ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
    ok "Port ${PORT}/tcp autorisé."
  fi

  if $SUDO ufw status | grep -qi "inactive"; then
    if confirm "ufw est inactif. L'activer maintenant (SSH restera autorisé) ?"; then
      $SUDO ufw --force enable
      ok "ufw activé."
    else
      warn "ufw reste inactif : les règles ci-dessus ne prendront effet qu'après activation."
    fi
  else
    ok "ufw déjà actif, règles appliquées."
  fi
}

print_summary() {
  title "C'est en ligne 🎉"
  if [ -n "$DOMAIN" ] && [ "$USE_NGINX" = "1" ]; then
    if $SUDO test -e "/etc/letsencrypt/live/${DOMAIN}" 2>/dev/null; then
      echo -e "   URL : ${c_bold}https://${DOMAIN}${c_reset}"
    else
      echo -e "   URL : ${c_bold}http://${DOMAIN}${c_reset} (HTTPS non activé)"
    fi
  else
    local ip
    ip="$(curl -s -4 ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "<IP-du-serveur>")"
    echo -e "   URL : ${c_bold}http://${ip}:${PORT}${c_reset}"
  fi
  echo -e "   Statut : ${c_bold}./deploy.sh status${c_reset}   Logs : ${c_bold}./deploy.sh logs${c_reset}"
  echo ""
}

# ---------------------------------------------------------------------
# Commandes
# ---------------------------------------------------------------------

cmd_install() {
  acquire_lock
  validate_port
  detect_privileges
  detect_pkg_manager
  ensure_mysql_config
  ensure_nodejs
  ensure_pm2
  ensure_dependencies
  ensure_frontend_build
  write_env
  run_tests
  run_migrations
  start_app
  setup_startup
  setup_nginx
  setup_firewall
  print_summary
}


# Revient au commit d'avant l'update et redémarre dessus. Best-effort : on
# prévient toujours clairement l'utilisateur plutôt que de prétendre avoir
# réparé silencieusement (ex: si les migrations de la nouvelle version ne
# sont pas réversibles, rollback du code seul ≠ retour à un état 100% sain).
rollback_update() {
  local prev_commit="$1"
  error "La nouvelle version ne démarre pas correctement. Tentative de rollback vers ${prev_commit}…"
  if ! git reset --hard "$prev_commit"; then
    error "Rollback git impossible. Le service est peut-être dans un état cassé : ./deploy.sh logs"
    exit 1
  fi
  npm install --omit=dev || true
  ensure_native_modules_rebuilt || true
  ensure_frontend_build || true
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env >/dev/null 2>&1 || true
  fi
  if wait_for_health; then
    warn "Rollback effectué : le service tourne à nouveau sur l'ancienne version (${prev_commit})."
    warn "N'applique pas le même update tant que le problème sur la nouvelle version n'est pas corrigé."
  else
    error "Le rollback n'a pas rétabli un service qui répond. Intervention manuelle nécessaire (./deploy.sh logs)."
  fi
  exit 1
}

cmd_update() {
  acquire_lock
  detect_privileges
  cd "$SCRIPT_DIR"
  title "Mise à jour"
  local prev_commit=""
  if [ -d .git ]; then
    prev_commit="$(git rev-parse HEAD 2>/dev/null || echo "")"
    info "Dépôt git détecté, git pull…"

    # public/ est un dossier de build versionné dans le repo mais régénéré par
    # `npm run build` juste après : on le vide avant de tirer pour éviter tout
    # conflit avec des fichiers déjà présents localement (ex: builds précédents).
    rm -rf public

    # `chmod +x deploy.sh` (fait une fois à l'installation) change le mode du
    # fichier : git le voit alors comme "modifié" même sans changement de
    # contenu, et bloque le pull. On ignore ces diffs de permission…
    git config core.fileMode false

    # …et s'il reste de vraies modifications locales (contenu, pas juste le
    # mode), on les met de côté plutôt que de planter la mise à jour.
    if ! git diff --quiet -- . 2>/dev/null || ! git diff --quiet --cached -- . 2>/dev/null; then
      warn "Modifications locales détectées, mises de côté (git stash) avant la mise à jour."
      git stash push -m "deploy.sh: mis de côté avant update $(date +%F_%T)" || true
    fi

    if ! git pull --ff-only; then
      error "git pull a échoué (historique divergent ?). Résous manuellement (git status / git log) puis relance."
      exit 1
    fi
  else
    info "Pas de dépôt git : remplace les fichiers du projet manuellement avant de relancer."
  fi
  npm install --omit=dev
  if [ "$DB_DRIVER" = "mysql" ]; then
    info "DB_DRIVER=mysql (.env) : vérification de la dépendance mysql2…"
    npm install mysql2 --omit=dev --no-save || warn "Échec d'installation de mysql2, vérifie ta connexion npm."
  fi
  ensure_native_modules_rebuilt
  ensure_frontend_build
  run_tests
  run_migrations
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env
    if wait_for_health; then
      pm2 save >/dev/null
      ok "Application redémarrée."
    elif [ -n "$prev_commit" ]; then
      rollback_update "$prev_commit"
    else
      error "L'application ne répond pas après la mise à jour, et aucun commit git précédent n'est disponible pour un rollback automatique."
      error "Corrige le problème (./deploy.sh logs) ou restaure les fichiers manuellement."
      exit 1
    fi
  else
    warn "Aucun process PM2 '$APP_NAME' trouvé, lance : ./deploy.sh install"
  fi
}

cmd_status() { pm2 describe "$APP_NAME" 2>/dev/null || { error "Application non démarrée. Lance ./deploy.sh install"; exit 1; }; }
cmd_logs()   { pm2 logs "$APP_NAME"; }
cmd_restart(){ pm2 restart "$APP_NAME" --update-env; ok "Redémarré."; }
cmd_stop()   { pm2 stop "$APP_NAME"; ok "Arrêté."; }

cmd_users() {
  cd "$SCRIPT_DIR"
  if [ ! -d node_modules ]; then
    error "Dépendances non installées. Lance d'abord ./deploy.sh install"
    exit 1
  fi
  node bin/manage-users.js "$@"
}

cmd_migrate() {
  cd "$SCRIPT_DIR"
  if [ ! -d node_modules ]; then
    error "Dépendances non installées. Lance d'abord ./deploy.sh install"
    exit 1
  fi
  node bin/migrate.js "$@"
}

cmd_uninstall() {
  acquire_lock
  detect_privileges
  title "Désinstallation"
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 delete "$APP_NAME" >/dev/null
    pm2 save >/dev/null
    ok "Process PM2 retiré."
  fi

  if [ -n "${1:-}" ] && [ "$1" = "--purge" ]; then
    if confirm "Supprimer aussi .env, node_modules et le build frontend (irréversible) ?"; then
      rm -rf "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/frontend/node_modules" "$SCRIPT_DIR/public" "$ENV_FILE"
      ok "Fichiers locaux supprimés."
    fi
    if [ -f "/etc/nginx/sites-available/${APP_NAME}.conf" ] || [ -f "/etc/nginx/conf.d/${APP_NAME}.conf" ]; then
      if confirm "Supprimer aussi la configuration nginx associée ?"; then
        $SUDO rm -f "/etc/nginx/sites-available/${APP_NAME}.conf" "/etc/nginx/sites-enabled/${APP_NAME}.conf" "/etc/nginx/conf.d/${APP_NAME}.conf"
        $SUDO systemctl reload nginx 2>/dev/null || true
        ok "Config nginx supprimée."
      fi
    fi
  fi

  ok "Désinstallation terminée. Le dossier du projet lui-même n'a pas été supprimé."
}

print_help() {
  sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------
# Parsing des arguments
# ---------------------------------------------------------------------
#
# Tout ce qui suit est dans main(), appelée seulement si le script est
# exécuté directement (pas si on le "source" — voir tout en bas). Ça permet
# à la suite de tests (test/deploy/*.bats) de sourcer deploy.sh pour tester
# unitairement les fonctions pures (validate_port, env_file_get,
# random_password…) sans déclencher le parsing des arguments ni aucune
# commande.
main() {

COMMAND="${1:-}"
[ $# -gt 0 ] && shift || true

if [ "$COMMAND" = "users" ]; then
  cmd_users "$@"
  exit $?
fi

if [ "$COMMAND" = "migrate" ]; then
  cmd_migrate "$@"
  exit $?
fi

# --env-file <chemin> : permet d'installer en fournissant un .env déjà prêt
# (généré ailleurs, restauré depuis un secret manager, copié d'une autre
# machine…) plutôt qu'en passant --port/--user/--pass/--db-* un par un.
#
# Pré-scan AVANT load_env_defaults() : ce dernier lit $ENV_FILE (le .env du
# projet) pour préremplir PORT/DB_DRIVER/etc., donc un --env-file externe doit
# être copié à cet emplacement avant cet appel pour être pris en compte. Le
# scan ne consomme pas "$@" : --env-file reste géré normalement par la boucle
# d'options juste après (elle se contente de le "sauter", déjà appliqué ici).
ENV_FILE_SRC=""
_args=("$@")
for ((_i = 0; _i < ${#_args[@]}; _i++)); do
  if [ "${_args[$_i]}" = "--env-file" ]; then
    ENV_FILE_SRC="${_args[$((_i + 1))]:-}"
    break
  fi
done

if [ -n "$ENV_FILE_SRC" ]; then
  if [ ! -f "$ENV_FILE_SRC" ]; then
    error "--env-file : fichier introuvable : $ENV_FILE_SRC"
    exit 1
  fi
  if [ ! -r "$ENV_FILE_SRC" ]; then
    error "--env-file : fichier non lisible : $ENV_FILE_SRC"
    exit 1
  fi
  title "Configuration (.env)"
  if [ -f "$ENV_FILE" ]; then
    ENV_BACKUP_FILE="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
    cp "$ENV_FILE" "$ENV_BACKUP_FILE"
    chmod 600 "$ENV_BACKUP_FILE"
    warn ".env existant sauvegardé avant remplacement : $ENV_BACKUP_FILE"
  fi
  cp "$ENV_FILE_SRC" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "Fichier .env chargé depuis : $ENV_FILE_SRC"
  if ! grep -qE '^PM2_MONITOR_(USER|PASS)=' "$ENV_FILE"; then
    warn "Ce fichier ne contient pas PM2_MONITOR_USER/PM2_MONITOR_PASS : le compte" \
         "admin ne sera créé automatiquement que si ces variables existent au" \
         "premier démarrage — sinon crée-le ensuite via ./deploy.sh users create."
  fi
  if ! grep -qE '^SESSION_SECRET=.+' "$ENV_FILE"; then
    warn "Ce fichier ne définit pas SESSION_SECRET : un secret aléatoire sera" \
         "généré à chaque redémarrage du process, ce qui déconnecte tout le" \
         "monde à chaque restart. Ajoute SESSION_SECRET dans ton .env source."
  fi
fi

# Recharge PORT/DB_DRIVER/etc. depuis un .env existant avant de parser les
# flags CLI, pour que install/update sur une install existante réutilisent
# la config déjà en place (voir commentaire de load_env_defaults()).
load_env_defaults

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --user) AUTH_USER="$2"; shift 2 ;;
    --pass) AUTH_PASS="$2"; shift 2 ;;
    --env-file) shift 2 ;; # déjà appliqué ci-dessus (avant load_env_defaults)
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --no-nginx) USE_NGINX="0"; shift ;;
    --no-firewall) USE_FIREWALL="0"; shift ;;
    --no-startup) USE_STARTUP="0"; shift ;;
    --db-driver) DB_DRIVER="$2"; shift 2 ;;
    --db-host) DB_HOST="$2"; shift 2 ;;
    --db-port) DB_PORT="$2"; shift 2 ;;
    --db-user) DB_USER="$2"; shift 2 ;;
    --db-pass) DB_PASS="$2"; shift 2 ;;
    --db-name) DB_NAME="$2"; shift 2 ;;
    --purge) PURGE="--purge"; shift ;;
    --yes) NON_INTERACTIVE="1"; shift ;;
    -h|--help) print_help; exit 0 ;;
    *) error "Option inconnue : $1"; print_help; exit 1 ;;
  esac
done

if [ "$DB_DRIVER" != "sqlite" ] && [ "$DB_DRIVER" != "mysql" ]; then
  error "--db-driver invalide : ${DB_DRIVER} (valeurs acceptées : sqlite, mysql)"
  exit 1
fi

# --env-file est prioritaire sur --port/--user/--pass/--db-* : si d'autres
# options de config ont aussi été passées, elles sont ignorées ici (recharge
# depuis le .env copié, et AUTH_PASS forcé vide pour que write_env() garde ce
# fichier tel quel au lieu d'en régénérer un avec un --pass fourni en plus).
if [ -n "$ENV_FILE_SRC" ]; then
  load_env_defaults
  AUTH_PASS=""
fi

# Journalisation persistante : pour install/update/uninstall (les commandes
# qui changent réellement l'état du système), toute la sortie est aussi
# écrite dans logs/deploy-*.log, pour pouvoir relire après coup ce qui s'est
# passé lors d'un déploiement (utile en particulier si un cron ou un CI
# déclenche `deploy.sh update` sans surveillance humaine directe).
case "$COMMAND" in
  install|update|uninstall)
    mkdir -p "$SCRIPT_DIR/logs"
    DEPLOY_LOG="$SCRIPT_DIR/logs/deploy-$(date +%Y%m%d-%H%M%S)-${COMMAND}.log"
    exec > >(tee -a "$DEPLOY_LOG") 2>&1
    info "Journal de ce déploiement : $DEPLOY_LOG"
    ;;
esac

case "$COMMAND" in
  install)   cmd_install ;;
  update)    cmd_update ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  restart)   cmd_restart ;;
  stop)      cmd_stop ;;
  uninstall) cmd_uninstall "${PURGE:-}" ;;
  ""|-h|--help) print_help ;;
  *) error "Commande inconnue : $COMMAND"; print_help; exit 1 ;;
esac

} # fin de main()

# N'exécute main() que si le script est lancé directement (./deploy.sh …),
# pas s'il est "sourcé" (ex: par la suite de tests bats, qui a besoin des
# fonctions sans déclencher de vraie commande).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
