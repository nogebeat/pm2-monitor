#!/usr/bin/env bats
#
# Tests de `deploy.sh update` : mise à jour vers une release précise (--to /
# --latest), sauvegarde de la base avant migration et retour arrière complet.
#
# Deux niveaux :
#  1. fonctions pures (format du tag, comparaison de versions…) ;
#  2. scénarios complets contre de VRAIS dépôts git temporaires (un « origin »
#     nu, un « éditeur » qui publie des releases, une « installation » qui se
#     met à jour). Seules les commandes lourdes ou dépendantes du système sont
#     remplacées par des doublures (npm, pm2, build, tests, migrations,
#     contrôle de santé, sauvegarde/restauration de la base — celles-ci sont
#     testées pour de vrai dans test/integration/db-snapshot.test.js).
#
# Ce que ces scénarios vérifient : l'ÉTAT FINAL (quel commit est installé,
# quel contenu a la base, quels appels ont eu lieu et dans quel ordre), pas
# seulement des messages.
#
# Lancer : bats test/deploy/update_release.bats

setup() {
  DEPLOY_SH="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/deploy.sh"
  # shellcheck source=/dev/null
  source "$DEPLOY_SH"
  TEST_TMPDIR="$(mktemp -d)"

  # Environnement git hermétique : aucune config utilisateur, pas de signature.
  export GIT_CONFIG_GLOBAL="$TEST_TMPDIR/gitconfig"
  export GIT_CONFIG_SYSTEM=/dev/null
  cat > "$GIT_CONFIG_GLOBAL" <<'CFG'
[user]
  name = Test
  email = test@example.com
[init]
  defaultBranch = main
[commit]
  gpgsign = false
[tag]
  gpgsign = false
CFG
  ORIGIN="$TEST_TMPDIR/origin.git"
  PUB="$TEST_TMPDIR/publisher"
  WORK="$TEST_TMPDIR/install"
}

teardown() {
  rm -rf "$TEST_TMPDIR"
}

# --- aides ---------------------------------------------------------------

# publish VERSION [annotated|light] : publie une release (commit + tag) depuis l'« éditeur ».
publish() {
  local version="$1" kind="${2:-annotated}"
  if [ ! -d "$PUB/.git" ]; then
    git init -q --bare "$ORIGIN"
    git clone -q "$ORIGIN" "$PUB" 2>/dev/null
  fi
  (
    cd "$PUB"
    printf '{\n  "name": "demo",\n  "version": "%s"\n}\n' "$version" > package.json
    echo "$version" > marker.txt
    git add -A
    git commit -q -m "release $version"
    if [ "$kind" = "light" ]; then git tag "v$version"; else git tag -a "v$version" -m "v$version"; fi
    git push -q origin HEAD:main "v$version" 2>/dev/null
  )
}

# install_at TAG : crée l'« installation » (clone de l'origin) positionnée sur ce tag, sur la branche main.
install_at() {
  git clone -q "$ORIGIN" "$WORK" 2>/dev/null
  (cd "$WORK" && git checkout -q -B main "$1" && git branch -q --set-upstream-to=origin/main main)
  mkdir -p "$WORK/data"
  echo "donnees-v1" > "$WORK/data/monitor.db"
}

# Les scénarios cmd_update tournent dans un shell FRAIS (comme en production, où
# cmd_update est appelé directement). Sous `run`, bats exécute la fonction dans une
# liste `||` : bash y désactive errexit ET le piège ERR, donc un échec simulé ne
# déclencherait aucun retour arrière et le test passerait pour de mauvaises raisons.
FRESH_VARS=(SCRIPT_DIR ENV_FILE BACKUP_DIR NON_INTERACTIVE DB_DRIVER APP_NAME CALLS HEALTH_STATE WORK PUB ORIGIN
  TEST_TMPDIR UPDATE_TO UPDATE_LATEST ALLOW_MAJOR NO_DB_BACKUP STUB_TESTS STUB_PENDING STUB_BACKUP STUB_MIGRATE STUB_HEALTH)
FRESH_FUNCS=(acquire_lock detect_privileges npm pm2 ensure_native_modules_rebuilt ensure_frontend_build run_tests
  count_pending_migrations backup_database restore_database prune_database_backups run_migrations wait_for_health confirm)

run_fresh() {
  local runner="$TEST_TMPDIR/runner.sh" v
  {
    echo '#!/usr/bin/env bash'
    echo "source \"$DEPLOY_SH\""
    for v in "${FRESH_VARS[@]}"; do
      if [ -n "${!v+x}" ]; then declare -p "$v"; fi
    done
    declare -f "${FRESH_FUNCS[@]}"
    printf '%q ' "$@"
    echo
  } > "$runner"
  run bash "$runner"
}

head_of() { git -C "$WORK" rev-parse HEAD; }
commit_of() { git -C "$ORIGIN" rev-parse "$1^{commit}"; }

# Doublures des commandes lourdes ; chaque appel significatif est journalisé.
stub_environment() {
  SCRIPT_DIR="$WORK"
  ENV_FILE="$WORK/.env"
  BACKUP_DIR="$WORK/data/backups"
  NON_INTERACTIVE="1"
  DB_DRIVER="sqlite"
  APP_NAME="demo"
  CALLS="$TEST_TMPDIR/calls.log"
  : > "$CALLS"
  HEALTH_STATE="$TEST_TMPDIR/health.count"
  echo 0 > "$HEALTH_STATE"

  acquire_lock() { :; }
  detect_privileges() { :; }
  npm() { echo "npm $*" >> "$CALLS"; }
  pm2() { echo "pm2 $*" >> "$CALLS"; return 0; }
  ensure_native_modules_rebuilt() { :; }
  ensure_frontend_build() { echo "build" >> "$CALLS"; }
  run_tests() { echo "tests" >> "$CALLS"; [ "${STUB_TESTS:-ok}" = "ok" ]; }
  count_pending_migrations() { echo "${STUB_PENDING:-1}"; }
  backup_database() {
    [ "${STUB_BACKUP:-ok}" = "ok" ] || return 1
    mkdir -p "$BACKUP_DIR"
    DB_BACKUP_FILE="$BACKUP_DIR/pre-update-v${1}-to-${2}.sqlite"
    cp "$WORK/data/monitor.db" "$DB_BACKUP_FILE"
    echo "backup" >> "$CALLS"
  }
  restore_database() { echo "restore" >> "$CALLS"; cp "$DB_BACKUP_FILE" "$WORK/data/monitor.db"; }
  prune_database_backups() { echo "prune" >> "$CALLS"; }
  run_migrations() {
    echo "migrations" >> "$CALLS"
    echo "schema-migre" >> "$WORK/data/monitor.db"
    [ "${STUB_MIGRATE:-ok}" = "ok" ]
  }
  # Santé : STUB_HEALTH = ok (défaut) | fail-then-ok (échec après la mise à jour, OK après le retour arrière) | always-fail
  wait_for_health() {
    local n
    n="$(cat "$HEALTH_STATE")"
    echo $((n + 1)) > "$HEALTH_STATE"
    echo "health" >> "$CALLS"
    case "${STUB_HEALTH:-ok}" in
      ok) return 0 ;;
      fail-then-ok) [ "$n" -ge 1 ] ;;
      always-fail) return 1 ;;
    esac
  }
}

# --- validate_release_tag -------------------------------------------------

@test "validate_release_tag accepte uniquement vMAJEUR.MINEUR.PATCH" {
  for tag in v1.2.3 v0.0.1 v4.10.0 v123456.0.0; do
    run validate_release_tag "$tag"
    [ "$status" -eq 0 ]
  done
}

@test "validate_release_tag refuse tout le reste (branches, pré-versions, injection)" {
  local bad
  for bad in "1.2.3" "v1.2" "v1.2.3-rc1" "v1.2.3+build" "latest" "main" "" "v1.2.3 " " v1.2.3" \
             "v1.2.3.4" "v-1.2.3" "v1234567.0.0" 'v1.2.3; rm -rf /' 'v1.2.3$(id)' 'v1.2.3`id`' "v1.2.3
v9.9.9" "../v1.2.3" "refs/tags/v1.2.3"; do
    run validate_release_tag "$bad"
    [ "$status" -ne 0 ] || { echo "accepté à tort : [$bad]"; return 1; }
  done
}

# --- version_cmp / release_kind ----------------------------------------

@test "version_cmp compare numériquement, pas alphabétiquement" {
  [ "$(version_cmp 4.10.0 4.9.0)" = "1" ]
  [ "$(version_cmp 4.9.0 4.10.0)" = "-1" ]
  [ "$(version_cmp 4.1.2 4.1.2)" = "0" ]
  [ "$(version_cmp v4.1.2 4.1.2)" = "0" ]
  [ "$(version_cmp 5.0.0 4.99.99)" = "1" ]
  [ "$(version_cmp 4.01.0 4.1.0)" = "0" ]
}

@test "release_kind distingue same/older/patch/minor/major" {
  [ "$(release_kind 4.1.2 v4.1.2)" = "same" ]
  [ "$(release_kind 4.1.2 v4.1.1)" = "older" ]
  [ "$(release_kind 4.1.2 v4.1.3)" = "patch" ]
  [ "$(release_kind 4.1.2 v4.2.0)" = "minor" ]
  [ "$(release_kind 4.1.2 v5.0.0)" = "major" ]
}

@test "release_kind : une pré-version est antérieure à sa version finale" {
  [ "$(release_kind 4.2.0-beta.1 v4.2.0)" = "patch" ]
  [ "$(release_kind 4.2.0-beta.1 v4.3.0)" = "minor" ]
}

@test "read_package_version lit la version du package.json du projet" {
  mkdir -p "$TEST_TMPDIR/p"
  printf '{\n  "name": "x",\n  "version": "7.8.9",\n  "engines": { "node": ">=22" }\n}\n' > "$TEST_TMPDIR/p/package.json"
  SCRIPT_DIR="$TEST_TMPDIR/p"
  [ "$(read_package_version)" = "7.8.9" ]
}

# --- lecture des tags distants --------------------------------------------

@test "latest_release_tag : dernier tag STABLE, tri numérique, ignore pré-versions et tags hors format" {
  publish 1.0.0 annotated
  publish 1.0.1 light
  publish 1.10.0 annotated
  publish 1.9.0 annotated
  (cd "$PUB" && git tag v1.2 && git tag 1.50.0 && git tag v2.0.0-rc1 && git tag nightly && git tag -a v9.9 -m x && git push -q origin v1.2 1.50.0 v2.0.0-rc1 nightly v9.9 2>/dev/null)
  git clone -q "$ORIGIN" "$WORK" 2>/dev/null
  cd "$WORK"
  [ "$(latest_release_tag)" = "v1.10.0" ]
}

@test "remote_tag_commit renvoie le COMMIT (tag annoté ou léger), vide si absent" {
  publish 1.0.0 annotated
  publish 1.0.1 light
  git clone -q "$ORIGIN" "$WORK" 2>/dev/null
  cd "$WORK"
  [ "$(remote_tag_commit v1.0.0)" = "$(commit_of v1.0.0)" ]
  [ "$(remote_tag_commit v1.0.1)" = "$(commit_of v1.0.1)" ]
  run remote_tag_commit v9.9.9
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# --- resolve_update_target : tout est refusé AVANT de modifier quoi que ce soit -----

@test "resolve : tag inexistant refusé, installation inchangée" {
  publish 1.0.0
  install_at v1.0.0
  stub_environment
  cd "$WORK"
  before="$(head_of)"
  UPDATE_TO="v9.9.9"; UPDATE_LATEST="0"
  run resolve_update_target
  [ "$status" -eq 1 ]
  [[ "$output" == *"n'existe pas"* ]]
  [ "$(head_of)" = "$before" ]
}

@test "resolve : un nom qui n'est pas un tag stable (main, injection) est refusé sans contacter git" {
  publish 1.0.0
  install_at v1.0.0
  stub_environment
  cd "$WORK"
  for bad in main "v1.0.1; touch $TEST_TMPDIR/pwned" 'v1.0.1$(touch '"$TEST_TMPDIR"'/pwned)'; do
    UPDATE_TO="$bad"; UPDATE_LATEST="0"
    run resolve_update_target
    [ "$status" -eq 1 ]
    [[ "$output" == *"Tag invalide"* ]]
  done
  [ ! -e "$TEST_TMPDIR/pwned" ]
}

@test "resolve : un tag DÉPLACÉ sur le dépôt distant est refusé (intégrité)" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  cd "$WORK"
  # 1re résolution : l'installation connaît maintenant v1.1.0
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"; ALLOW_MAJOR="0"
  run resolve_update_target
  [ "$status" -eq 0 ]
  git -C "$WORK" fetch -q origin "refs/tags/v1.1.0:refs/tags/v1.1.0"
  # L'éditeur DÉPLACE le tag sur un autre commit (ce qui s'est vu en vrai)
  (cd "$PUB" && echo evil > marker.txt && git commit -qam "autre contenu" && git tag -fa v1.1.0 -m "deplace" && git push -q -f origin v1.1.0 2>/dev/null)
  run resolve_update_target
  [ "$status" -eq 1 ]
  [[ "$output" == *"DÉPLACÉ"* ]]
}

@test "resolve : retour en arrière refusé (installation en avance sur le tag)" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.1.0
  stub_environment
  cd "$WORK"
  UPDATE_TO="v1.0.0"; UPDATE_LATEST="0"
  run resolve_update_target
  [ "$status" -eq 1 ]
  [[ "$output" == *"EN AVANCE"* ]]
}

@test "resolve : déjà sur la cible = rien à faire (succès, UPDATE_NOOP=1)" {
  publish 1.0.0
  install_at v1.0.0
  stub_environment
  cd "$WORK"
  UPDATE_TO="v1.0.0"; UPDATE_LATEST="0"; UPDATE_NOOP="0"
  resolve_update_target
  [ "$UPDATE_NOOP" = "1" ]
  [ "$TARGET_TAG" = "v1.0.0" ]
}

@test "resolve : historique local divergé refusé" {
  publish 1.0.0
  install_at v1.0.0
  (cd "$WORK" && echo local > local.txt && git add -A && git commit -qm "commit local")
  publish 1.1.0
  stub_environment
  cd "$WORK"
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  run resolve_update_target
  [ "$status" -eq 1 ]
  [[ "$output" == *"DIVERGÉ"* ]]
}

@test "resolve : version MAJEURE refusée sans --allow-major, acceptée avec" {
  publish 1.0.0
  publish 2.0.0
  install_at v1.0.0
  stub_environment
  cd "$WORK"
  UPDATE_TO="v2.0.0"; UPDATE_LATEST="0"; ALLOW_MAJOR="0"
  run resolve_update_target
  [ "$status" -eq 1 ]
  [[ "$output" == *"MAJEURE"* ]]
  ALLOW_MAJOR="1"
  resolve_update_target
  [ "$TARGET_TAG" = "v2.0.0" ]
  [ "$TARGET_COMMIT" = "$(commit_of v2.0.0)" ]
}

@test "resolve --latest choisit la dernière release stable" {
  publish 1.0.0
  publish 1.1.0
  publish 1.2.0
  (cd "$PUB" && git tag v1.9.0-rc1 && git push -q origin v1.9.0-rc1 2>/dev/null)
  install_at v1.0.0
  stub_environment
  cd "$WORK"
  UPDATE_TO=""; UPDATE_LATEST="1"; ALLOW_MAJOR="0"
  resolve_update_target
  [ "$TARGET_TAG" = "v1.2.0" ]
}

@test "resolve : installation sans git (archive) refusée" {
  mkdir -p "$TEST_TMPDIR/archive"
  cd "$TEST_TMPDIR/archive"
  UPDATE_TO="v1.0.0"; UPDATE_LATEST="0"
  run resolve_update_target
  [ "$status" -eq 1 ]
  [[ "$output" == *"installation par git"* ]]
}

@test "resolve : dépôt distant injoignable = refus explicite, rien n'est modifié" {
  publish 1.0.0
  install_at v1.0.0
  git -C "$WORK" remote set-url origin "$TEST_TMPDIR/n-existe-pas.git"
  stub_environment
  cd "$WORK"
  before="$(head_of)"
  UPDATE_TO="v1.0.0"; UPDATE_LATEST="0"
  run resolve_update_target
  [ "$status" -eq 1 ]
  [[ "$output" == *"injoignable"* ]]
  [ "$(head_of)" = "$before" ]
}

# --- db_backup_prereqs -------------------------------------------------

@test "mysql sans clients mysqldump/mysql : refus AVANT toute modification" {
  DB_DRIVER="mysql"; NO_DB_BACKUP="0"
  mkdir -p "$TEST_TMPDIR/vide"
  PATH="$TEST_TMPDIR/vide" run db_backup_prereqs
  [ "$status" -eq 1 ]
  [[ "$output" == *"mysqldump"* ]]
  [[ "$output" == *"--no-db-backup"* ]]
}

@test "mysql sans clients : --no-db-backup lève le refus" {
  DB_DRIVER="mysql"; NO_DB_BACKUP="1"
  mkdir -p "$TEST_TMPDIR/vide"
  PATH="$TEST_TMPDIR/vide" run db_backup_prereqs
  [ "$status" -eq 0 ]
}

@test "sqlite : aucun prérequis externe" {
  DB_DRIVER="sqlite"; NO_DB_BACKUP="0"
  run db_backup_prereqs
  [ "$status" -eq 0 ]
}

# --- cmd_update : scénarios complets ---------------------------------------

@test "update --to : succès — l'installation est EXACTEMENT sur le tag, base sauvegardée AVANT les migrations" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  run_fresh cmd_update
  [ "$status" -eq 0 ]
  [ "$(head_of)" = "$(commit_of v1.1.0)" ]
  [ "$(cat "$WORK/marker.txt")" = "1.1.0" ]
  # ordre : tests → sauvegarde → migrations → redémarrage → santé
  order="$(grep -E '^(tests|backup|migrations|pm2 restart|health)' "$CALLS" | tr '\n' ' ')"
  [[ "$order" == "tests backup migrations pm2 restart demo --update-env health " ]]
  [ -f "$BACKUP_DIR/pre-update-v1.0.0-to-v1.1.0.sqlite" ]
  [[ "$output" == *"Mise à jour terminée"* ]]
}

@test "update --to : santé KO après la mise à jour → retour arrière du code ET de la base" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  before="$(head_of)"
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  STUB_HEALTH="fail-then-ok"
  run_fresh cmd_update
  [ "$status" -eq 1 ]
  [ "$(head_of)" = "$before" ]
  [ "$(cat "$WORK/marker.txt")" = "1.0.0" ]
  # la base est revenue à son contenu d'AVANT la migration
  [ "$(cat "$WORK/data/monitor.db")" = "donnees-v1" ]
  # l'application est arrêtée AVANT la restauration de la base, puis relancée
  order="$(grep -E '^(pm2 stop|restore|pm2 restart)' "$CALLS" | tr '\n' ' ')"
  [[ "$order" == "pm2 restart demo --update-env pm2 stop demo restore pm2 restart demo --update-env " ]]
  [[ "$output" == *"Retour arrière effectué"* ]]
}

@test "update --to : tests en échec → code restauré, base JAMAIS touchée, application non redémarrée" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  before="$(head_of)"
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  STUB_TESTS="ko"
  run_fresh cmd_update
  [ "$status" -eq 1 ]
  [ "$(head_of)" = "$before" ]
  [ "$(cat "$WORK/data/monitor.db")" = "donnees-v1" ]
  ! grep -qE '^(backup|migrations|restore|pm2 restart)' "$CALLS"
  [[ "$output" == *"« tests »"* ]]
  [[ "$output" == *"l'ancienne version tourne toujours"* ]]
}

@test "update --to : migration en échec en cours de route → base restaurée, ancien code relancé" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  before="$(head_of)"
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  STUB_MIGRATE="ko"
  run_fresh cmd_update
  [ "$status" -eq 1 ]
  [ "$(head_of)" = "$before" ]
  [ "$(cat "$WORK/data/monitor.db")" = "donnees-v1" ]
  grep -q '^restore' "$CALLS"
  grep -q '^pm2 stop' "$CALLS"
  grep -q '^pm2 restart' "$CALLS"
}

@test "update --to : sauvegarde de la base impossible → refus, migrations jamais lancées, code restauré" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  before="$(head_of)"
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  STUB_BACKUP="ko"
  run_fresh cmd_update
  [ "$status" -eq 1 ]
  [ "$(head_of)" = "$before" ]
  ! grep -q '^migrations' "$CALLS"
  [ "$(cat "$WORK/data/monitor.db")" = "donnees-v1" ]
  [[ "$output" == *"Sauvegarde de la base impossible"* ]]
}

@test "update --to : aucune migration en attente → pas de sauvegarde, mise à jour réussie" {
  publish 1.0.0
  publish 1.0.1
  install_at v1.0.0
  stub_environment
  UPDATE_TO="v1.0.1"; UPDATE_LATEST="0"
  STUB_PENDING="0"
  run_fresh cmd_update
  [ "$status" -eq 0 ]
  [ "$(head_of)" = "$(commit_of v1.0.1)" ]
  ! grep -q '^backup' "$CALLS"
  [[ "$output" == *"pas de sauvegarde de la base nécessaire"* ]]
}

@test "update --to --no-db-backup : échec après migration → code restauré mais base NON restaurée, et c'est dit" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  before="$(head_of)"
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"; NO_DB_BACKUP="1"
  STUB_HEALTH="fail-then-ok"
  run_fresh cmd_update
  [ "$status" -eq 1 ]
  [ "$(head_of)" = "$before" ]
  ! grep -qE '^(backup|restore)' "$CALLS"
  [[ "$output" == *"AUCUNE sauvegarde"* ]]
  # la base garde la trace de la migration : c'est le risque accepté par --no-db-backup
  grep -q "schema-migre" "$WORK/data/monitor.db"
}

@test "update --to : confirmation refusée → rien n'est modifié" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  confirm() { return 1; }
  before="$(head_of)"
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  run_fresh cmd_update
  [ "$status" -eq 0 ]
  [ "$(head_of)" = "$before" ]
  [ ! -s "$CALLS" ]
  [[ "$output" == *"rien n'a été modifié"* ]]
}

@test "update --to : déjà à jour → succès sans rien exécuter" {
  publish 1.0.0
  install_at v1.0.0
  stub_environment
  UPDATE_TO="v1.0.0"; UPDATE_LATEST="0"
  run_fresh cmd_update
  [ "$status" -eq 0 ]
  [ ! -s "$CALLS" ]
  [[ "$output" == *"Déjà sur v1.0.0"* ]]
}

@test "update --latest : installe la dernière release stable" {
  publish 1.0.0
  publish 1.1.0
  publish 1.2.0
  install_at v1.0.0
  stub_environment
  UPDATE_TO=""; UPDATE_LATEST="1"
  run_fresh cmd_update
  [ "$status" -eq 0 ]
  [ "$(head_of)" = "$(commit_of v1.2.0)" ]
}

@test "update --to : les modifications locales sont mises de côté (stash) et signalées en cas de retour arrière" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  echo "ma modif" >> "$WORK/marker.txt"
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  STUB_HEALTH="fail-then-ok"
  run_fresh cmd_update
  [ "$status" -eq 1 ]
  [ -n "$(git -C "$WORK" stash list)" ]
  [[ "$output" == *"git stash list"* ]]
}

@test "update sans option (mode branche historique) : tire la branche, sauvegarde et retour arrière actifs" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  UPDATE_TO=""; UPDATE_LATEST="0"
  run_fresh cmd_update
  [ "$status" -eq 0 ]
  [ "$(head_of)" = "$(commit_of v1.1.0)" ]
  grep -q '^backup' "$CALLS"
  [[ "$output" == *"Mode branche"* ]]
}

@test "update sans option : santé KO → retour arrière complet aussi en mode branche" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  before="$(head_of)"
  UPDATE_TO=""; UPDATE_LATEST="0"
  STUB_HEALTH="fail-then-ok"
  run_fresh cmd_update
  [ "$status" -eq 1 ]
  [ "$(head_of)" = "$before" ]
  [ "$(cat "$WORK/data/monitor.db")" = "donnees-v1" ]
}

@test "update : la restauration de la base échoue → le code n'est PAS remis (cohérence), instructions manuelles" {
  publish 1.0.0
  publish 1.1.0
  install_at v1.0.0
  stub_environment
  restore_database() { return 1; }
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  STUB_HEALTH="always-fail"
  run_fresh cmd_update
  [ "$status" -eq 1 ]
  [ "$(head_of)" = "$(commit_of v1.1.0)" ]
  [[ "$output" == *"RESTAURATION DE LA BASE IMPOSSIBLE"* ]]
  [[ "$output" == *"db-snapshot.js restore"* ]]
}

@test "--to / --latest / --allow-major / --no-db-backup sont réservées à la commande update" {
  run main install --to v1.0.0
  [ "$status" -eq 1 ]
  [[ "$output" == *"ne s'appliquent qu'à « update »"* ]]
}

@test "--to sans valeur : erreur explicite" {
  run main update --to
  [ "$status" -eq 1 ]
  [[ "$output" == *"--to requiert une valeur"* ]]
}

@test "--to et --latest ensemble : refusé" {
  publish 1.0.0
  install_at v1.0.0
  stub_environment
  UPDATE_TO="v1.0.0"; UPDATE_LATEST="1"
  run_fresh cmd_update
  [ "$status" -eq 1 ]
  [[ "$output" == *"exclusifs"* ]]
}

@test "update --to depuis un HEAD détaché sur un tag : avance sur la release (aucune branche amont requise)" {
  publish 1.0.0
  publish 1.1.0
  git clone -q "$ORIGIN" "$WORK" 2>/dev/null
  (cd "$WORK" && git checkout -q --detach v1.0.0)
  mkdir -p "$WORK/data"
  echo "donnees-v1" > "$WORK/data/monitor.db"
  stub_environment
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  run_fresh cmd_update
  [ "$status" -eq 0 ]
  [ "$(head_of)" = "$(commit_of v1.1.0)" ]
}

@test "retour arrière depuis un HEAD détaché : revient exactement au commit d'origine" {
  publish 1.0.0
  publish 1.1.0
  git clone -q "$ORIGIN" "$WORK" 2>/dev/null
  (cd "$WORK" && git checkout -q --detach v1.0.0)
  mkdir -p "$WORK/data"
  echo "donnees-v1" > "$WORK/data/monitor.db"
  stub_environment
  before="$(head_of)"
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  STUB_HEALTH="fail-then-ok"
  run_fresh cmd_update
  [ "$status" -eq 1 ]
  [ "$(head_of)" = "$before" ]
  [ "$(cat "$WORK/data/monitor.db")" = "donnees-v1" ]
}

@test "retour arrière : pas de faux message « git stash » quand seul public/ (build) a bougé" {
  publish 1.0.0
  # public/ est versionné : deploy.sh le vide lui-même avant de tirer, ce n'est PAS une modification de l'utilisateur
  (cd "$PUB" && mkdir -p public && echo "<html>ui</html>" > public/index.html && git add -A && git commit -q -m "public" && git push -q origin HEAD:main 2>/dev/null)
  publish 1.1.0
  git clone -q "$ORIGIN" "$WORK" 2>/dev/null
  git -C "$WORK" checkout -q -B main "$(git -C "$PUB" rev-parse HEAD~1)"
  git -C "$WORK" branch -q --set-upstream-to=origin/main main
  mkdir -p "$WORK/data"
  echo "donnees-v1" > "$WORK/data/monitor.db"
  stub_environment
  UPDATE_TO="v1.1.0"; UPDATE_LATEST="0"
  STUB_HEALTH="fail-then-ok"
  run_fresh cmd_update
  [ "$status" -eq 1 ]
  [[ "$output" != *"git stash list"* ]]
}
