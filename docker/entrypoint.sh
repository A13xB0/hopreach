#!/bin/sh
set -eu

: "${HOPREACH_CONFIG:=/config/config.yaml}"
export HOPREACH_CONFIG

mkdir -p /data/dem-cache /data/shared-plans

# Renders config.js, nginx's site config, and the cron file from
# config.yaml (see cmd/hopreach's -prepare mode) — replaces the old
# envsubst-based templating now that config.yaml, not four dozen env vars,
# is the single source of truth.
/app/hopreach -prepare

touch /var/log/fetch.log /var/log/prune.log
cron -f &
tail -F /var/log/fetch.log /var/log/prune.log &

# The terrain-aware coverage computation can take minutes on first run (DEM
# tile download + path analysis), so it must not block nginx from starting —
# the frontend needs nginx up immediately to poll progress.json. Run it in
# the background instead; the page shows a progress bar until it's done.
(/app/hopreach || echo "Initial fetch failed; check /var/log/fetch.log") &

# Always-on share API, proxied by nginx at /api/plans (see docker/default.conf).
(/app/hopreach-shareapi) &

exec nginx -g "daemon off;"
