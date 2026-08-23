#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID} -eq 0 ]] || {
  echo "Run this updater as root." >&2
  exit 1
}

ORCA_REPOSITORY=CreatorComputeCompany/orca
RELEASE_PREFIX=buzz-host-
GH_USER=boxd
GH_HOME=/home/boxd
GH_CONFIG_DIR=/home/boxd/.config/gh
INSTALLER=/usr/local/libexec/buzz-orca/install-bundle.sh
STATE_DIR=/var/lib/buzz-orca-updater
INSTALLED_SHA_FILE=$STATE_DIR/installed-sha

exec 9>/run/lock/buzz-orca-update.lock
if ! flock --nonblock 9; then
  echo "Another Buzz Orca update is already running."
  exit 0
fi

[[ -x "$INSTALLER" ]] || {
  echo "Bundle installer is missing: $INSTALLER" >&2
  exit 1
}

github_as_boxd() {
  runuser -u "$GH_USER" -- env \
    HOME="$GH_HOME" \
    GH_CONFIG_DIR="$GH_CONFIG_DIR" \
    gh "$@"
}

main_sha=$(github_as_boxd api \
  "repos/$ORCA_REPOSITORY/commits/main" \
  --jq .sha)
[[ "$main_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "GitHub returned an invalid main commit SHA." >&2
  exit 1
}

if [[ -f "$INSTALLED_SHA_FILE" ]] &&
  [[ $(<"$INSTALLED_SHA_FILE") == "$main_sha" ]]; then
  echo "Buzz Orca host already runs $main_sha."
  exit 0
fi

release_tag=$RELEASE_PREFIX$main_sha
release_json=$(github_as_boxd release view "$release_tag" \
  --repo "$ORCA_REPOSITORY" \
  --json assets,isDraft,isPrerelease,tagName,targetCommitish) || {
  echo "The bundle for current main ($main_sha) is not published yet." >&2
  exit 1
}

jq -e \
  --arg tag "$release_tag" \
  --arg commit "$main_sha" \
  '
    .isDraft == false and
    .isPrerelease == true and
    .tagName == $tag and
    .targetCommitish == $commit and
    ([.assets[].name] | sort) ==
      ["manifest.json", "orca-main.tgz", "orca-web.tgz"]
  ' <<<"$release_json" >/dev/null || {
  echo "Release metadata does not match the current main commit." >&2
  exit 1
}

download_dir=$(mktemp -d /var/tmp/buzz-orca-update.XXXXXX)
trap 'rm -rf -- "$download_dir"' EXIT
chown "$GH_USER:$GH_USER" "$download_dir"
chmod 0700 "$download_dir"

github_as_boxd release download "$release_tag" \
  --repo "$ORCA_REPOSITORY" \
  --dir "$download_dir" \
  --pattern manifest.json \
  --pattern orca-main.tgz \
  --pattern orca-web.tgz

manifest=$download_dir/manifest.json
jq -e \
  --arg commit "$main_sha" \
  '
    (keys | sort) == ["commit", "main", "schemaVersion", "web"] and
    .schemaVersion == 1 and
    .commit == $commit and
    (.main | keys | sort) == ["asset", "sha256"] and
    .main.asset == "orca-main.tgz" and
    (.main.sha256 | test("^[0-9a-f]{64}$")) and
    (.web | keys | sort) == ["asset", "sha256"] and
    .web.asset == "orca-web.tgz" and
    (.web.sha256 | test("^[0-9a-f]{64}$"))
  ' "$manifest" >/dev/null || {
  echo "Release manifest is invalid." >&2
  exit 1
}

main_sha256=$(jq -r .main.sha256 "$manifest")
web_sha256=$(jq -r .web.sha256 "$manifest")
printf '%s  %s\n' "$main_sha256" "$download_dir/orca-main.tgz" |
  sha256sum --check --status
printf '%s  %s\n' "$web_sha256" "$download_dir/orca-web.tgz" |
  sha256sum --check --status

"$INSTALLER" \
  "$download_dir/orca-main.tgz" "$main_sha256" \
  "$download_dir/orca-web.tgz" "$web_sha256"

install -d -o root -g root -m 0755 "$STATE_DIR"
new_state=$(mktemp "$STATE_DIR/.installed-sha.XXXXXX")
printf '%s\n' "$main_sha" >"$new_state"
chmod 0644 "$new_state"
mv -f -- "$new_state" "$INSTALLED_SHA_FILE"
echo "Recorded Buzz Orca host deployment $main_sha."
