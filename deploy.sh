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
#   ./deploy.sh uninstall [--purge]
#
# Options d'installation :
#   --port <n>          Port d'écoute (défaut : 4200)
#   --user <nom>         Identifiant de connexion (défaut : admin)
#   --pass <motdepasse>  Mot de passe (défaut : généré aléatoirement)
#   --domain <domaine>   Domaine pour nginx + HTTPS (ex: pm2.mondomaine.fr)
#   --email <email>      Email pour Let's Encrypt (requis si --domain)
#   --no-nginx           Ne pas configurer nginx (accès direct par IP:port)
#   --no-firewall        Ne pas toucher au pare-feu
#   --no-startup         Ne pas configurer le démarrage automatique au boot
#   --yes                Mode non-interactif (répond "oui" aux confirmations)
#   -h, --help           Affiche cette aide
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
# Étapes d'installation
# ---------------------------------------------------------------------

ensure_nodejs() {
  title "Node.js"
  if command -v node >/dev/null 2>&1; then
    local ver major
    ver="$(node -v)"
    major="$(echo "$ver" | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "$major" -ge 16 ]; then
      ok "Node.js $ver déjà présent."
      return 0
    fi
    warn "Node.js $ver trouvé, mais version < 16 : mise à jour recommandée."
  else
    info "Node.js absent, installation en cours…"
  fi

  case "$PKG_MANAGER" in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash - >/dev/null
      pkg_install nodejs
      ;;
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash - >/dev/null
      pkg_install nodejs
      ;;
    *)
      error "Installe Node.js >= 16 manuellement puis relance ce script."
      exit 1
      ;;
  esac
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

ensure_dependencies() {
  title "Dépendances du projet"
  cd "$SCRIPT_DIR"
  if [ -d node_modules ] && [ -f node_modules/.deploy-installed ]; then
    ok "Dépendances déjà installées."
  else
    info "npm install…"
    npm install --omit=dev
    touch node_modules/.deploy-installed
    ok "Dépendances installées."
  fi
}

ensure_frontend_build() {
  title "Frontend (Vue 3 + Vite)"
  cd "$SCRIPT_DIR"
  info "Installation des dépendances frontend et build de production…"
  npm --prefix frontend install --no-audit --no-fund >/dev/null
  npm --prefix frontend run build
  ok "Frontend construit dans public/."
}

random_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 20
  else
    tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20
  fi
}

write_env() {
  title "Configuration (.env)"

  if [ -f "$ENV_FILE" ] && [ -z "$AUTH_PASS" ]; then
    ok "Fichier .env déjà présent, conservé tel quel."
    # On récupère le port déjà configuré pour la suite du script (nginx, firewall…)
    PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
    PORT="${PORT:-4200}"
    return 0
  fi

  [ -z "$AUTH_PASS" ] && AUTH_PASS="$(random_password)"

  cat > "$ENV_FILE" <<EOF
PORT=${PORT}
PM2_MONITOR_USER=${AUTH_USER}
PM2_MONITOR_PASS=${AUTH_PASS}
EOF
  chmod 600 "$ENV_FILE"
  ok "Fichier .env généré."
  echo -e "   ${c_bold}Identifiant :${c_reset} ${AUTH_USER}"
  echo -e "   ${c_bold}Mot de passe :${c_reset} ${AUTH_PASS}"
  echo -e "   ${c_yellow}Note ces identifiants, ils ne seront plus réaffichés en clair.${c_reset}"
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
  detect_privileges
  detect_pkg_manager
  ensure_nodejs
  ensure_pm2
  ensure_dependencies
  ensure_frontend_build
  write_env
  start_app
  setup_startup
  setup_nginx
  setup_firewall
  print_summary
}

cmd_update() {
  detect_privileges
  cd "$SCRIPT_DIR"
  title "Mise à jour"
  if [ -d .git ]; then
    info "Dépôt git détecté, git pull…"
    git pull --ff-only
  else
    info "Pas de dépôt git : remplace les fichiers du projet manuellement avant de relancer."
  fi
  npm install --omit=dev
  ensure_frontend_build
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env
    ok "Application redémarrée."
  else
    warn "Aucun process PM2 '$APP_NAME' trouvé, lance : ./deploy.sh install"
  fi
}

cmd_status() { pm2 describe "$APP_NAME" 2>/dev/null || { error "Application non démarrée. Lance ./deploy.sh install"; exit 1; }; }
cmd_logs()   { pm2 logs "$APP_NAME"; }
cmd_restart(){ pm2 restart "$APP_NAME" --update-env; ok "Redémarré."; }
cmd_stop()   { pm2 stop "$APP_NAME"; ok "Arrêté."; }

cmd_uninstall() {
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
  sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------
# Parsing des arguments
# ---------------------------------------------------------------------

COMMAND="${1:-}"
[ $# -gt 0 ] && shift || true

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --user) AUTH_USER="$2"; shift 2 ;;
    --pass) AUTH_PASS="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --no-nginx) USE_NGINX="0"; shift ;;
    --no-firewall) USE_FIREWALL="0"; shift ;;
    --no-startup) USE_STARTUP="0"; shift ;;
    --purge) PURGE="--purge"; shift ;;
    --yes) NON_INTERACTIVE="1"; shift ;;
    -h|--help) print_help; exit 0 ;;
    *) error "Option inconnue : $1"; print_help; exit 1 ;;
  esac
done

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
