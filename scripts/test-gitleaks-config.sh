#!/usr/bin/env bash
# Prove the configured detector is active and fixture exceptions stay narrow.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT
mkdir -p "$fixture_root/test"
cd "$fixture_root"
printf "const clientSecret = '%s%s';\n" 'gbrain_cs_' 'secret456' > "$fixture_root/test/auth-register-client-output-pin.test.ts"
gitleaks dir . --config "$repo_root/.gitleaks.toml" --redact --no-banner --log-level error
python3 - "$fixture_root/test/auth-register-client-output-pin.test.ts" <<'PY'
import hashlib, sys
with open(sys.argv[1], 'a') as fixture:
    fixture.write('const api_key = "' + hashlib.sha256(b'synthetic-gitleaks-canary').hexdigest() + '";\n')
PY
set +e
gitleaks dir . --config "$repo_root/.gitleaks.toml" --redact --no-banner --log-level error
result=$?
set -e
if [ "$result" -ne 1 ]; then
  echo "gitleaks configuration failed its synthetic detection canary (exit $result)" >&2
  exit 1
fi
echo "gitleaks configuration: fixture accepted; independent synthetic secret detected"
