#!/usr/bin/env bash
set -euo pipefail

OUT="${1:-bin/gbrain}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${OUT}.tmp.$$"
mkdir -p "$(dirname "$OUT")"

if bun build --compile --outfile "$TMP" "$ROOT/src/cli.ts" >/tmp/gbrain-build-bin.log 2>&1 && "$TMP" --version >/dev/null 2>&1; then
  mv "$TMP" "$OUT"
  chmod +x "$OUT"
  echo "built compiled binary: $OUT"
else
  rm -f "$TMP"
  cat > "$OUT" <<EOF
#!/usr/bin/env bash
set -euo pipefail
ROOT="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
exec bun run "\$ROOT/src/cli.ts" "\$@"
EOF
  chmod +x "$OUT"
  echo "bun --compile failed or produced a non-runnable binary; wrote Bun-source shim: $OUT" >&2
  if [ -s /tmp/gbrain-build-bin.log ]; then
    tail -40 /tmp/gbrain-build-bin.log >&2 || true
  fi
fi
