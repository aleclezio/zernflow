#!/bin/bash
# ⚠ DO NOT USE ON THE CURRENT PROD HOST. The prod container is supervised by
# systemd (zernflow.service, Restart=always): any container this script starts
# is killed and replaced with systemd's own zernflow:prod within seconds
# (observed live 2026-08-24 - the docker-events log shows the fight).
# On that host: build with scripts/build-prod.sh, deploy with
# `systemctl restart zernflow`, roll back by retagging zernflow:prod to the
# rollback image and restarting the unit.
#
# Kept for hosts WITHOUT a supervisor. It recreates the container from the
# given image, preserving the running container's environment, network and
# port binding. Secrets never touch stdout: the env is copied into a
# root-only temp file on this host and deleted after the new container starts.
#
# Usage:  bash scripts/redeploy.sh [image=zernflow:prod]
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
