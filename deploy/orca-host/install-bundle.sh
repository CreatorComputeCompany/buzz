#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: sudo $0 MAIN_ARCHIVE MAIN_SHA256 WEB_ARCHIVE WEB_SHA256" >&2
  exit 2
}

[[ $# -eq 4 ]] || usage
[[ ${EUID} -eq 0 ]] || {
  echo "Run this installer as root." >&2
  exit 1
}

MAIN_ARCHIVE=$1
MAIN_SHA256=$2
WEB_ARCHIVE=$3
WEB_SHA256=$4
APP_OUT=/opt/orca/orca-extracted/resources/app.asar.unpacked/out

[[ "$MAIN_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || usage
[[ "$WEB_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || usage
[[ -f "$MAIN_ARCHIVE" && -f "$WEB_ARCHIVE" ]] || {
  echo "Both release archives must exist." >&2
  exit 1
}
[[ -d "$APP_OUT/main" && -d "$APP_OUT/web" ]] || {
  echo "Expected extracted Orca application is missing under $APP_OUT." >&2
  exit 1
}

printf '%s  %s\n' "$MAIN_SHA256" "$MAIN_ARCHIVE" | sha256sum --check --status
printf '%s  %s\n' "$WEB_SHA256" "$WEB_ARCHIVE" | sha256sum --check --status

validate_archive() {
  archive=$1
  root=$2
  tar tzf "$archive" | awk -v root="$root" '
    BEGIN { found = 0; invalid = 0 }
    /^\// || /(^|\/)\.\.($|\/)/ { invalid = 1; next }
    $0 == root || $0 == root "/" || index($0, root "/") == 1 { found = 1; next }
    { invalid = 1 }
    END { exit invalid || !found }
  '
  # Release bundles should contain regular files and directories only. In
  # particular, reject links before extraction so they cannot escape staging.
  tar tvzf "$archive" | awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }'
}

validate_archive "$MAIN_ARCHIVE" main
validate_archive "$WEB_ARCHIVE" web

STAGING=$(mktemp -d /opt/orca/.buzz-bundle.XXXXXX)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
MAIN_BACKUP="$APP_OUT/main.before-$STAMP"
WEB_BACKUP="$APP_OUT/web.before-$STAMP"
INSTALLED=0
SERVICES_STOPPED=0

# Invoked through the EXIT trap.
# shellcheck disable=SC2329
recover() {
  status=$?
  trap - EXIT
  set +e
  rm -rf -- "$STAGING"
  if ((status != 0 && INSTALLED)); then
    systemctl stop buzz-orca-agent.service orca-serve.service
    if [[ -d "$MAIN_BACKUP" ]]; then
      rm -rf -- "$APP_OUT/main"
      mv "$MAIN_BACKUP" "$APP_OUT/main"
    fi
    if [[ -d "$WEB_BACKUP" ]]; then
      rm -rf -- "$APP_OUT/web"
      mv "$WEB_BACKUP" "$APP_OUT/web"
    fi
  fi
  if ((status != 0 && SERVICES_STOPPED)); then
    systemctl reset-failed orca-serve.service buzz-orca-agent.service
    systemctl start orca-serve.service buzz-orca-agent.service
  fi
  exit "$status"
}
trap recover EXIT

tar xzf "$MAIN_ARCHIVE" --no-same-owner --no-same-permissions -C "$STAGING"
tar xzf "$WEB_ARCHIVE" --no-same-owner --no-same-permissions -C "$STAGING"
[[ -f "$STAGING/main/index.js" && -f "$STAGING/web/web-index.html" ]] || {
  echo "Release archives do not contain the expected Orca entry points." >&2
  exit 1
}
chown -R boxd:boxd "$STAGING/main" "$STAGING/web"

SERVICES_STOPPED=1
systemctl stop buzz-orca-agent.service orca-serve.service
[[ ! -e "$MAIN_BACKUP" && ! -e "$WEB_BACKUP" ]]
INSTALLED=1
mv "$APP_OUT/main" "$MAIN_BACKUP"
mv "$APP_OUT/web" "$WEB_BACKUP"
mv "$STAGING/main" "$APP_OUT/main"
mv "$STAGING/web" "$APP_OUT/web"

systemctl reset-failed orca-serve.service buzz-orca-agent.service
systemctl start orca-serve.service buzz-orca-agent.service

for _ in {1..45}; do
  if curl -fsS https://runtime.buzz-orca-host.boxd.sh/ >/dev/null 2>&1; then
    systemctl is-active --quiet orca-serve.service
    systemctl is-active --quiet buzz-orca-agent.service
    SERVICES_STOPPED=0
    trap - EXIT
    rm -rf -- "$STAGING"
    echo "Installed Orca bundle; retained rollback directories:"
    echo "  $MAIN_BACKUP"
    echo "  $WEB_BACKUP"
    exit 0
  fi
  sleep 2
done

echo "Runtime did not recover within 90 seconds; restoring the previous bundle." >&2
exit 1
