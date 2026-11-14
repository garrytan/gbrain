# Shared helpers for skill-eval seed.sh and check.sh scripts (sourced, POSIX sh).
# The working directory is the eval session's work dir. Its brain lives at ./.home/.gbrain, the HOME the
# adapter gives the agent, so setup, the agent and the check all see the same brain. Every brain is keyless
# (--no-embedding) and starts repo-less; tasks that need git create their own repositories.
set -eu

gbh() { HOME="$PWD/.home" gbrain "$@"; }

brain_new() {
  mkdir -p .home
  gbh init --pglite --no-embedding >/dev/null 2>&1 || { echo "brain init failed" >&2; exit 1; }
}

brain_import() {
  gbh import "$1" --no-embed >/dev/null 2>&1 || { echo "import $1 failed" >&2; exit 1; }
}

# Register a git checkout as a source, sync it and make it sync.repo_path (the shape of a repo brain).
brain_add_repo() {
  gbh sources add "$1" --path "$PWD/$2" >/dev/null 2>&1 || { echo "sources add $1 failed" >&2; exit 1; }
  gbh sync --source "$1" >/dev/null 2>&1 || { echo "sync $1 failed" >&2; exit 1; }
  gbh config set sync.repo_path "$PWD/$2" >/dev/null 2>&1
}

git_repo() {
  ( cd "$1" && git init -q -b main && git add -A && git -c user.email=eval@example.com -c user.name=eval commit -qm "${2:-initial}" )
}

git_commit() {
  ( cd "$1" && git add -A && git -c user.email=eval@example.com -c user.name=eval commit -qm "$2" )
}

# Every page's slug and body, one block per page, sorted: compare it before and after to prove nothing changed.
brain_dump() {
  rm -rf .eval-dump && gbh export --dir "$PWD/.eval-dump" >/dev/null 2>&1
  find .eval-dump -name '*.md' | sort | while read -r f; do echo "=== $f"; cat "$f"; done
}

brain_has() { brain_dump | grep -q -i -E "$1"; }

tree_sum() { ( cd "$1" && find . -path ./.git -prune -o -type f -print | sort | xargs sha256sum ) | sha256sum | cut -c1-16; }

git_state() { ( cd "$1" && echo "$(git rev-list --all --count) $(git rev-parse HEAD) $(git rev-list --max-parents=0 HEAD)" ); }

remember_state() { mkdir -p .seed && "$@" > ".seed/$(echo "$*" | tr -c 'a-zA-Z0-9' '_' | cut -c1-60)"; }

same_as_seed() { [ "$("$@")" = "$(cat ".seed/$(echo "$*" | tr -c 'a-zA-Z0-9' '_' | cut -c1-60)")" ]; }

calls() { cat .eval/calls.jsonl 2>/dev/null || true; }

answer() { cat .eval/answer.txt 2>/dev/null || true; }

ran() { calls | grep -q -E "$1"; }

fail() { echo "CHECK FAIL: $*" >&2; exit 1; }
