#!/bin/bash
# Build zernflow:prod WITH the NEXT_PUBLIC_* build args Next.js bakes in at
# build time (basePath, public Supabase URL + anon key, app URL). Values are
# read from the RUNNING container and passed as build args via subshells -
# they never touch stdout. All four are browser-exposed public config by
# design (NEXT_PUBLIC_*), not secrets.
#
# The prod container is SUPERVISED BY SYSTEMD (zernflow.service, Restart=always):
# never docker rm/run it by hand - systemd recreates its own zernflow:prod
# within seconds and wins. Deploy = this build, then: systemctl restart zernflow
#
# Usage (on the prod host, repo root):  bash scripts/build-prod.sh
set -euo pipefail
cd "$(dirname "$0")/.."

arg() { docker exec zernflow sh -c "printf %s \"\$$1\""; }

docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$(arg NEXT_PUBLIC_SUPABASE_URL)" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$(arg NEXT_PUBLIC_SUPABASE_ANON_KEY)" \
  --build-arg NEXT_PUBLIC_APP_URL="$(arg NEXT_PUBLIC_APP_URL)" \
  --build-arg NEXT_PUBLIC_BASE_PATH="$(arg NEXT_PUBLIC_BASE_PATH)" \
  -q -t zernflow:prod .

echo "built. deploy with: systemctl restart zernflow"
