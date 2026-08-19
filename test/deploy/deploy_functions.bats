#!/usr/bin/env bats
#
# Tests des fonctions "pures" de deploy.sh (validation, parsing de .env,
# génération de mot de passe...). deploy.sh est sourcé (pas exécuté) grâce au
# garde `if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi` en bas du
# fichier : le sourcer ici ne parse aucun argument et ne lance aucune commande.
#
# Ce qui n'est volontairement PAS testé ici (nécessiterait un vrai serveur,
# root/sudo, ou un VPS) : ensure_nodejs, ensure_pm2, setup_nginx,
# setup_firewall, wait_for_health, start_app, cmd_install/update/uninstall.
# Ces chemins-là restent couverts manuellement (voir README) ou via un
# environnement de test dédié (VM/conteneur), pas par cette suite unitaire.
#
# Lancer : bats test/deploy/deploy_functions.bats

setup() {
  DEPLOY_SH="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/deploy.sh"
  # shellcheck source=/dev/null
  source "$DEPLOY_SH"
  TEST_TMPDIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TMPDIR"
}

# --- validate_port ----------------------------------------------------

@test "validate_port accepte un port valide standard" {
  PORT=4200
  run validate_port
  [ "$status" -eq 0 ]
}

@test "validate_port accepte les bornes 1 et 65535" {
  PORT=1
  run validate_port
  [ "$status" -eq 0 ]

  PORT=65535
  run validate_port
  [ "$status" -eq 0 ]
}

@test "validate_port refuse une chaîne non numérique" {
  PORT="abc"
  run validate_port
  [ "$status" -eq 1 ]
  [[ "$output" == *"invalide"* ]]
}

@test "validate_port refuse une valeur vide" {
  PORT=""
  run validate_port
  [ "$status" -eq 1 ]
}

@test "validate_port refuse 0" {
  PORT=0
  run validate_port
  [ "$status" -eq 1 ]
}

@test "validate_port refuse au-delà de 65535" {
  PORT=70000
  run validate_port
  [ "$status" -eq 1 ]
}

@test "validate_port refuse les nombres négatifs" {
  PORT="-1"
  run validate_port
  [ "$status" -eq 1 ]
}

@test "validate_port refuse une injection de commande dans --port" {
  PORT='4200; rm -rf /'
  run validate_port
  [ "$status" -eq 1 ]
}

# --- random_password ----------------------------------------------------

@test "random_password génère 20 caractères alphanumériques" {
  run random_password
  [ "$status" -eq 0 ]
  [ "${#output}" -eq 20 ]
  [[ "$output" =~ ^[A-Za-z0-9]+$ ]]
}

@test "random_password génère des valeurs différentes à chaque appel" {
  pw1="$(random_password)"
  pw2="$(random_password)"
  [ "$pw1" != "$pw2" ]
}

# --- env_file_get / load_env_defaults ----------------------------------

@test "env_file_get renvoie le défaut si le fichier .env n'existe pas" {
  ENV_FILE="$TEST_TMPDIR/inexistant.env"
  run env_file_get PORT "9999"
  [ "$status" -eq 0 ]
  [ "$output" = "9999" ]
}

@test "env_file_get lit une clé présente dans le .env" {
  ENV_FILE="$TEST_TMPDIR/.env"
  printf 'PORT=5000\nDB_DRIVER=mysql\n' > "$ENV_FILE"
  run env_file_get PORT "9999"
  [ "$output" = "5000" ]
  run env_file_get DB_DRIVER "sqlite"
  [ "$output" = "mysql" ]
}

@test "env_file_get renvoie le défaut si la clé est absente du fichier" {
  ENV_FILE="$TEST_TMPDIR/.env"
  printf 'PORT=5000\n' > "$ENV_FILE"
  run env_file_get DB_DRIVER "sqlite"
  [ "$output" = "sqlite" ]
}

@test "env_file_get prend la dernière occurrence si la clé est dupliquée" {
  ENV_FILE="$TEST_TMPDIR/.env"
  printf 'PORT=5000\nPORT=6000\n' > "$ENV_FILE"
  run env_file_get PORT "9999"
  [ "$output" = "6000" ]
}

@test "load_env_defaults recharge PORT/DB_DRIVER depuis un .env existant" {
  ENV_FILE="$TEST_TMPDIR/.env"
  printf 'PORT=8123\nDB_DRIVER=mysql\nDB_HOST=db.internal\nDB_USER=bob\n' > "$ENV_FILE"
  PORT="4200"
  DB_DRIVER="sqlite"
  load_env_defaults
  [ "$PORT" = "8123" ]
  [ "$DB_DRIVER" = "mysql" ]
  [ "$DB_HOST" = "db.internal" ]
  [ "$DB_USER" = "bob" ]
}

@test "load_env_defaults ne touche à rien si le .env n'existe pas" {
  ENV_FILE="$TEST_TMPDIR/inexistant.env"
  PORT="4200"
  load_env_defaults
  [ "$PORT" = "4200" ]
}
