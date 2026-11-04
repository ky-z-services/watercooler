#!/usr/bin/env bash
# Activates a release on the server. .github/workflows/deploy.yml uploads the build to
# <app-dir>/releases/<release>.tgz and then pipes this script over SSH:
#
#   ssh server "bash -l -s -- <app-dir> <release>" < deploy/remote-deploy.sh
#
# <app-dir> may be absolute or relative to the deploy user's home (e.g. "watercooler" = ~/watercooler).
# The release's instance.env names the instance (INSTANCE, PORT, BASE_PATH) and how it is reached.
# Layout under <app-dir>:
#   releases/<release>/   unpacked builds (the newest $KEEP_RELEASES are kept)
#   current -> releases/  the release the service runs
#   shared/data/          SQLite database, survives deploys
#   shared/logs/          app log (see <instance>.sh logs)
#   shared/.env           optional settings (INVITE_CODE, ...), linked into every release
#   <instance>.sh         start/stop/restart script, refreshed from deploy/watercooler.sh on every deploy
set -euo pipefail

usage='usage: remote-deploy.sh <app-dir> <release>'
APP_DIR=${1:?$usage}
RELEASE=${2:?$usage}
# Defaults to "<app-dir>/<instance>.sh restart"; override to manage the process another way.
RESTART_CMD=${RESTART_CMD:-}
# Defaults to the instance's /api/config on 127.0.0.1.
HEALTH_URL=${HEALTH_URL:-}
KEEP_RELEASES=${KEEP_RELEASES:-5}

# Node usually comes from nvm, which a non-interactive SSH shell doesn't load by itself.
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    set +eu
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    set -eu
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "!! Node.js not found for $(whoami). Install Node 22 with nvm and run: nvm alias default 22" >&2
  exit 1
fi
# shellcheck disable=SC2016 # JavaScript, not shell
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 19)) {
    console.error(`Node.js ${process.version} is too old; need >= 20.19`);
    process.exit(1);
  }'

# shellcheck disable=SC2088 # matching a literal "~" on purpose
case $APP_DIR in
  /*) ;;
  "~") APP_DIR=$HOME ;;
  "~/"*) APP_DIR="$HOME/${APP_DIR#"~/"}" ;;
  *) APP_DIR="$HOME/$APP_DIR" ;;
esac
mkdir -p "$APP_DIR"
APP_DIR=$(cd "$APP_DIR" && pwd -P)
RELEASES="$APP_DIR/releases"
TARGET="$RELEASES/$RELEASE"

echo "==> Unpacking $RELEASE"
mkdir -p "$TARGET" "$APP_DIR/shared/data"
tar -xzf "$TARGET.tgz" -C "$TARGET"
rm -f "$TARGET.tgz"

[ -f "$TARGET/instance.env" ] || {
  echo "!! $RELEASE has no instance.env" >&2
  exit 1
}
# shellcheck source=/dev/null
. "$TARGET/instance.env"
CONTROL="$APP_DIR/$INSTANCE.sh"
RESTART_CMD=${RESTART_CMD:-"$CONTROL restart"}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:$PORT/api/config}
echo "==> Instance $INSTANCE (port $PORT, base path $BASE_PATH)"

echo "==> Installing production dependencies"
cd "$TARGET"
export CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if command -v corepack >/dev/null 2>&1; then
  corepack pnpm install --prod --frozen-lockfile --filter @watercooler/server
else
  pnpm_version=$(node -p 'require("./package.json").packageManager.split("@")[1]')
  npx --yes "pnpm@$pnpm_version" install --prod --frozen-lockfile --filter @watercooler/server
fi

# The app loads <release>/.env at startup; point it at the shared one (a missing file is ignored).
ln -sfn "$APP_DIR/shared/.env" "$TARGET/.env"
# A stable copy of the control script, so it also works for rolling back to older releases.
install -m 755 "$TARGET/deploy/watercooler.sh" "$CONTROL"

activate() {
  ln -sfn "$1" "$APP_DIR/current.tmp"
  mv -Tf "$APP_DIR/current.tmp" "$APP_DIR/current"
}

healthy() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$HEALTH_URL"
}

wait_healthy() {
  for _ in $(seq 1 30); do
    healthy && return 0
    sleep 1
  done
  return 1
}

previous=$(readlink -f "$APP_DIR/current" 2>/dev/null || true)

echo "==> Switching to $RELEASE and restarting"
activate "$TARGET"
failure=""
if ! $RESTART_CMD; then
  failure="'$RESTART_CMD' failed"
elif ! wait_healthy; then
  failure="$HEALTH_URL did not come up healthy"
fi

if [ -n "$failure" ]; then
  echo "!! $failure" >&2
  tail -n 40 "$APP_DIR/shared/logs/$INSTANCE.log" 2>/dev/null || true
  if [ -n "$previous" ] && [ -d "$previous" ] && [ "$previous" != "$TARGET" ]; then
    echo "!! Rolling back to $(basename "$previous")" >&2
    activate "$previous"
    if ! { $RESTART_CMD && wait_healthy; }; then
      echo "!! Previous release is not healthy either" >&2
    fi
  fi
  exit 1
fi

echo "==> Pruning old releases (keeping $KEEP_RELEASES)"
current=$(readlink -f "$APP_DIR/current")
# Release names start with a UTC timestamp, so name order is age order.
find "$RELEASES" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort -r | tail -n "+$((KEEP_RELEASES + 1))" | while read -r name; do
  [ "$RELEASES/$name" = "$current" ] || rm -rf -- "${RELEASES:?}/$name"
done

echo "==> Deployed $RELEASE"
