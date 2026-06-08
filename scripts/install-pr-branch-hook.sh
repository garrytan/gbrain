#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "install-pr-branch-hook: not inside a git worktree" >&2
  exit 2
fi

COMMON_DIR="$(git rev-parse --git-common-dir)"
HOOK_DIR="$COMMON_DIR/hooks"
HOOK="$HOOK_DIR/pre-push"
mkdir -p "$HOOK_DIR"

if [[ -f "$HOOK" ]] && ! grep -q "gbrain check-pr-branch-base" "$HOOK"; then
  BACKUP="$HOOK.backup.$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$HOOK" "$BACKUP"
  echo "install-pr-branch-hook: backed up existing hook to $BACKUP" >&2
fi

cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# gbrain check-pr-branch-base
# Blocks fork pushes from branches that are not based on current origin/master.
# Override only for deliberate exceptions:
#   GBRAIN_SKIP_PR_BRANCH_BASE_CHECK=1 git push ...

REMOTE_NAME="${1:-}"
case "$REMOTE_NAME" in
  fork|origin|"")
    ;;
  *)
    exit 0
    ;;
esac

if [[ "${GBRAIN_SKIP_PR_BRANCH_BASE_CHECK:-}" == "1" ]]; then
  echo "pre-push: skipped gbrain PR branch-base check" >&2
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel)"
exec "$ROOT/scripts/check-pr-branch-base.sh" --fetch
EOF

chmod +x "$HOOK"
echo "install-pr-branch-hook: installed $HOOK" >&2
