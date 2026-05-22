---
description: Sync upstream garrytan/gbrain into this fork (the established §6.x sync process)
argument-hint: "[--repo-only]"
allowed-tools: Bash(git fetch:*), Bash(git log:*), Bash(git rev-list:*), Bash(git merge-tree:*), Bash(git diff:*), Bash(git status:*)
---

## Upstream delta (auto-gathered)

- Fork HEAD: !`git log --oneline -1`
- Working tree: !`git status --short || echo "(clean)"`
- Fetch upstream: !`git fetch upstream --tags 2>&1 | tail -3 || echo "FETCH FAILED — check the 'upstream' remote"`
- New upstream commits: !`git log --oneline master..upstream/master 2>/dev/null || echo "(none — already in sync)"`
- Conflict preview: !`git merge-tree --write-tree --name-only master upstream/master 2>&1 | tail -n +2 | head -40`

## Task

Perform a scheduled upstream sync of this fork (`garrytan/gbrain` →
`jarvis-knowledge-os-v2`).

If the upstream delta above shows no new commits, tell the user there is
nothing to sync and stop. Otherwise:

1. Read `CLAUDE.md` (fork rules) and **the most recent `## 6.NN Upstream
   … sync` story in `docs/JARVIS-ARCHITECTURE.md`** — that story is the
   authoritative, current process and evolves every sync.
2. Plan the work and get the user's sign-off on scope before executing.
   Default scope = full sync (repo + production deploy); if `--repo-only`
   was passed, skip the production deploy.

### Fork-boundary rules — never violate

- Never modify `src/*`, `skills/RESOLVER.md` outside its append-only
  `## KOS-Jarvis extensions` section, or other upstream `skills/*`.
  Fork logic lives only under `skills/kos-jarvis/`.
- After the merge, `git diff master <merge-commit> --stat -- skills/kos-jarvis/
  server/ workers/ scripts/launchd/` MUST be empty (upstream did not
  invade fork territory). If it is not, stop and investigate.

### Repo-side (always)

- Branch `sync-vX.Y.Z` (the new upstream VERSION), `git merge upstream/master`.
  Conflict defaults: `CLAUDE.md` → keep fork (`git checkout --ours`); the
  fork CLAUDE.md is fork-only and upstream's content is mirrored in
  `docs/CLAUDE-UPSTREAM.md`. `llms-full.txt` → clear markers, regenerate
  via `bun run build:llms`. Other conflicts → judge per §6.x precedent.
- Refresh `docs/CLAUDE-UPSTREAM.md` from `git show upstream/master:CLAUDE.md`
  (keep the fork wrapper header; scrub the private OpenClaw fork name →
  `openclaw-reference` so `check-privacy.sh` passes).
- `bun install` (new deps), `bun run build`, verify `bin/gbrain --version`.
- Green gate: `bun run typecheck` + `bun run check:all` + `bun test test/ai/`.
  If `check:skill-brain-first` flags a fork skill, add a canonical
  brain-first Convention callout (or `brain_first: exempt` for a genuine
  infra skill). The full `bun test` suite is non-gating (documented
  PGLite / longmemeval env-coupling).
- Commit on the sync branch — the merge, a `chore:` llms regen, any `fix:`
  fork adaptations, and a `docs:` commit with the new §6.(N+1) sync story
  + `skills/kos-jarvis/TODO.md` header + `CLAUDE.md` sync-story pointer.
  Then `git checkout master && git merge --no-ff sync-vX.Y.Z` and
  `git push origin master sync-vX.Y.Z`. Commits stay English; fork commits
  carry the `Co-Authored-By` trailer.

### Production deploy — skip if `$ARGUMENTS` contains `--repo-only`

Runs on the jarvis Mac (production Postgres + launchd):

- Backup: `pg_dump` the production DB to
  `/tmp/pg-pre-sync-vX.Y.Z-<date>.dump.gz`; copy `~/.gbrain/config.json`.
- Migrate: `bin/gbrain init --migrate-only` (schema auto-advances; idempotent
  `column already exists` NOTICEs are normal, not errors).
- Restart the daemon: `launchctl bootout` + `bootstrap`
  `com.jarvis.gbrain-serve-http`. Cron services reload source on next fire.
- Smoke: `curl` both `http://127.0.0.1:7225/health` and
  `https://kos.chenge.ink/health` (expect the new version), `bin/gbrain
  doctor`, an English keyword query + a compound-CJK query (vector path),
  and confirm the pages count holds against the prior baseline.

Finish by writing the §6.(N+1) story with the smoke evidence, in the same
shape as the previous §6.x stories, and report the result to the user.
