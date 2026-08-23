#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ORCA_ENV=/etc/orca-serve.env
BUZZ_ENV=/etc/buzz-orca-agent.env

for env_file in "$ORCA_ENV" "$BUZZ_ENV"; do
  if [[ ! -f "$env_file" ]]; then
    echo "Required secret environment file is missing: $env_file" >&2
    exit 1
  fi
  owner=$(stat -c %U "$env_file")
  mode=$(stat -c %a "$env_file")
  if [[ "$owner" != root || "$mode" != 600 ]]; then
    echo "$env_file must be owned by root with mode 600." >&2
    exit 1
  fi
done

install -o root -g root -m 0644 \
  "$SCRIPT_DIR/orca-serve.service" \
  /etc/systemd/system/orca-serve.service
install -o root -g root -m 0644 \
  "$SCRIPT_DIR/buzz-orca-agent.service" \
  /etc/systemd/system/buzz-orca-agent.service
install -o root -g root -m 0644 \
  "$SCRIPT_DIR/buzz-orca-update.service" \
  /etc/systemd/system/buzz-orca-update.service
install -o root -g root -m 0644 \
  "$SCRIPT_DIR/buzz-orca-update.timer" \
  /etc/systemd/system/buzz-orca-update.timer
install -d -o root -g root -m 0755 /usr/local/libexec/buzz-orca
install -o root -g root -m 0755 \
  "$SCRIPT_DIR/install-bundle.sh" \
  /usr/local/libexec/buzz-orca/install-bundle.sh
install -o root -g root -m 0755 \
  "$SCRIPT_DIR/update-from-github.sh" \
  /usr/local/libexec/buzz-orca/update-from-github.sh

# Remove production-era drop-ins whose settings now live in the complete unit.
rm -f \
  /etc/systemd/system/orca-serve.service.d/buzz-identity.conf \
  /etc/systemd/system/buzz-orca-agent.service.d/logging.conf \
  /etc/systemd/system/buzz-orca-agent.service.d/runtime-lifecycle.conf

systemctl daemon-reload
systemctl enable \
  orca-serve.service \
  buzz-orca-agent.service \
  buzz-orca-update.timer
systemctl restart orca-serve.service

# PartOf= propagates a restart transaction, but an independently inactive agent
# is intentionally recovered here as well.
systemctl start buzz-orca-agent.service
systemctl start buzz-orca-update.timer
systemctl is-active --quiet orca-serve.service
systemctl is-active --quiet buzz-orca-agent.service
systemctl is-active --quiet buzz-orca-update.timer

echo "Orca runtime, Buzz listener, and commit-addressed updater are active."
