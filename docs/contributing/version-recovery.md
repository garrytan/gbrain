# Version consistency and merge recovery

Read [release rules](../RELEASING.md) before shipping.

### Mandatory version-consistency audit (run after EVERY merge or commit that touches VERSION, package.json, or CHANGELOG)

**The trio MUST agree.** Every merge from master will hit conflicts on
VERSION + package.json + CHANGELOG.md because master ships its own
version bumps. Auto-merge sometimes resolves these silently in unexpected
ways. After any merge, branch update, or version-related edit, run this
audit. It's three lines and never lies:

```bash
echo "VERSION:     $(cat VERSION)"
echo "package.json: $(node -e 'process.stdout.write(require("./package.json").version)')"
grep -E "^## \[" CHANGELOG.md | head -1
```

All three MUST show the same `MAJOR.MINOR.PATCH.MICRO`. If any one
disagrees, you have not finished the merge. Fix it before pushing or
shipping. There is no situation in which "I'll fix it next push" is OK,
because:

- A green local test run with mismatched VERSION/package.json still
  fails the CI version-gate.
- A green CHANGELOG entry under the wrong version header silently lies
  to release-notes consumers.
- /ship's Step 12 idempotency check classifies a mismatch as
  `DRIFT_UNEXPECTED` and HALTS — but only if you remember to run /ship
  before pushing. Manual `git push` skips the check.

### Merge-conflict recovery procedure (memorize this)

When `git merge origin/master` reports conflicts on VERSION,
package.json, or CHANGELOG.md, resolve in this exact order:

1. **VERSION** — overwrite with the wave's version (`echo -n "X.Y.Z.W"
   > VERSION`). Highest semver wins; do NOT take master's lower version.
2. **package.json** — strip the conflict markers, keep the wave's
   version line. Sed pattern:
   `sed -i.bak '/^<<<<<<< HEAD$/d; /^=======$/,/^>>>>>>> /d' package.json && rm package.json.bak`
   (assumes ours is above the `=======`).
3. **CHANGELOG.md** — strip ALL three conflict markers; both your entry
   and master's entry stay. Sed pattern:
   `sed -i.bak '/^<<<<<<< HEAD$/d; /^=======$/d; /^>>>>>>> origin\/master$/d' CHANGELOG.md && rm CHANGELOG.md.bak`
   Then verify your entry is the topmost `## [X.Y.Z.W]` and master's
   newer-than-yours entries (if any) sit below.
4. **Run the 3-line audit above.** If it doesn't show your version on
   all three lines, you missed a marker.
5. **Run `bun install`** to refresh `bun.lock` against the resolved
   `package.json`. Stage and commit if it changed.
6. **Run `bun run typecheck`** before committing the merge.
7. Only THEN run `git commit` for the merge.

If the audit shows drift after step 4, do NOT proceed to step 5. Re-run
steps 1-3 against the actual file content; you missed a marker or
resolved one in the wrong direction.

**Anti-pattern to avoid:** Resolving via `git checkout --ours package.json`
and `git checkout --theirs scripts/test-shard.sh` mixed in the same
commit. The selective directional resolution is fine, but on
VERSION/package.json/CHANGELOG specifically, ALWAYS use the explicit
`echo > VERSION` + sed-strip-markers pattern above. The directional
checkout flags have bitten us when the conflict shape was unexpected
(e.g. master stripped a section we expected to keep).

### Pre-push gate (manual; tighten when you remember to)

Before any `git push` of a merge commit, run the audit one more time:

```bash
echo "VERSION:     $(cat VERSION)"
echo "package.json: $(node -e 'process.stdout.write(require("./package.json").version)')"
grep -E "^## \[" CHANGELOG.md | head -1
```

If you've been editing the branch via `/ship` you can rely on Step 12's
idempotency check. If you've been editing manually (merge resolution,
conflict fix, version bump), the audit is the last line of defense
before CI yells at you.
