#!/bin/bash
# Recreate the zernflow prod container from the freshly built zernflow:prod
# image, preserving the running container's environment, network and port
# binding. Secrets never touch stdout: the env is copied into a root-only
# temp file on this host and deleted after the new container starts.
#
# Usage (on the prod host, after `docker build -t zernflow:prod .`):
#   bash scripts/redeploy.sh
#
# Rollback (tag taken by the operator before the build):
#   docker rm -f zernflow && bash scripts/redeploy.sh zernflow:rollback-<tag>
set -euo pipefail
umask 077

IMAGE="${1:-zernflow:prod}"
NAME="zernflow"
NETWORK="lygge-onboard"
PORT="127.0.0.1:3001:3000"
ENVTMP="/root/.zf-env-tmp"

cleanup() { rm -f "$ENVTMP"; }
trap cleanup EXIT

docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' > "$ENVTMP"
chmod 600 "$ENVTMP"
docker rm -f "$NAME" >/dev/null
docker run -d --name "$NAME" --network "$NETWORK" -p "$PORT" \
  --env-file "$ENVTMP" "$IMAGE" >/dev/null

sleep 8
docker ps --filter "name=$NAME" --format '{{.Names}} {{.Status}} {{.Image}}'
curl -s -o /dev/null -w 'local http: %{http_code}\n' "http://127.0.0.1:3001/" || true
