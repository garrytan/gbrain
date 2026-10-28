#!/bin/sh
# Seeds a company-brainify eval task: sh seed.sh <variant>. Every repo is a fresh git repository in the work dir.
. "$(dirname "$0")/../_lib/eval.sh"
FIX="$(cd "$(dirname "$0")" && pwd)"
personal_repo() { cp -R "$FIX/personal" ./personal && git_repo personal "personal brain"; }
shared_repo() {
  cp -R "$FIX/personal" ./shared && rm -rf shared/conversations && git_repo shared "import from personal brain"
  rm -rf shared/* && cp -R "$FIX/shared-now/." shared/ && git_commit shared "partial cleanup"
  git init -q --bare shared.git && git -C shared remote add origin "$PWD/shared.git" && git -C shared push -q origin main
}
brain_new
case "$1" in
  personal)
    personal_repo && brain_add_repo personal personal ;;
  shared)
    shared_repo && brain_add_repo shared shared ;;
  both)
    personal_repo && brain_add_repo personal personal && shared_repo ;;
  staging)
    personal_repo && brain_add_repo personal personal
    cp -R "$FIX/staging" ./staging && git init -q --bare team.git ;;
  acme)
    personal_repo && brain_add_repo personal personal
    cp -R "$FIX/acme-brain" ./acme-brain && git_repo acme-brain "company handbook" ;;
  repoless)
    mkdir -p .pages && cp -R "$FIX/personal/." .pages/ && rm -rf .pages/conversations && brain_import ./.pages && rm -rf .pages ;;
  team-home)
    personal_repo && brain_add_repo personal personal
    mkdir -p team-home && HOME="$PWD/team-home" gbrain init --pglite --no-embedding >/dev/null 2>&1
    HOME="$PWD/team-home" gbrain import "$FIX/staging/people" --no-embed >/dev/null 2>&1 ;;
  *) echo "unknown variant $1" >&2; exit 2 ;;
esac
mkdir -p .seed
for r in personal shared acme-brain; do [ -d "$r" ] && { git_state "$r" > ".seed/$r.git"; tree_sum "$r" > ".seed/$r.tree"; }; done
[ -d shared.git ] && git -C shared.git rev-parse main > .seed/shared.git.main
[ -d shared ] && git -C shared rev-list --max-parents=0 HEAD > .seed/shared.root
[ -d personal ] && git -C personal rev-list --all > .seed/personal.commits
[ "$1" = repoless ] && remember_state brain_dump
true
