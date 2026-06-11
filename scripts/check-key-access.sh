#!/usr/bin/env bash
# CI guard: the per-workspace secret columns (late_api_key_encrypted, ai_api_key)
# may only be referenced from lib/workspace-keys.ts (the single accessor that
# enforces encrypt-on-write / decrypt-and-fail-closed-on-read) and the generated
# database types. Any other reference is a custody regression.
set -euo pipefail
cd "$(dirname "$0")/.."

violations=$(grep -rn --include='*.ts' --include='*.tsx' -E 'late_api_key_encrypted|ai_api_key' app components lib \
  | grep -v '^lib/workspace-keys.ts:' \
  | grep -v '^lib/types/database.ts:' || true)

if [ -n "$violations" ]; then
  echo "FAIL: direct key-column access outside lib/workspace-keys.ts:"
  echo "$violations"
  exit 1
fi

echo "OK: key columns are only accessed via lib/workspace-keys.ts"
