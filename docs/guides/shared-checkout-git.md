# Committing and pushing in a brain checkout other agents share

## Goal

Many writers commit to the same brain checkout on one machine: interactive
sessions, sub-agents, cron jobs, the post-commit hook, gbrain's own page
writes and sometimes a host sync daemon. Every one of them commits and pushes
with one command, and none of them can stash, rebase, revert or ship another
writer's half-written files.

**Say to your agent:** *"Commit the meeting notes you just wrote to my brain and push them."*
Your agent runs `scripts/brain-commit-push.sh "meetings: 2026-04-03 product review" meetings/2026-04-03.md`
(or `gbrain git commit-push -m "<msg>" -- <paths>` when the brain has no helper).

**Say to your agent:** *"Bring my brain checkout up to date before you start writing."*
Your agent runs `scripts/brain-commit-push.sh --pull` (or `gbrain git commit-push --pull`).

**Say to your agent:** *"The push conflicted on people/alice-example.md. Keep the version on GitHub."*
Your agent runs `gbrain git commit-push --push-only --expect-remote <sha> --resolve people/alice-example.md=theirs`,
copying the remote commit from the conflict report.

## Why the old way broke

<!-- gbrain-allow-shared-tree-git-begin: describes the commands that caused the incidents -->
Skills used to tell each agent to run `git pull --rebase` (sometimes with
`--autostash`) and then a plain push, directly in the shared working tree. A
rebase stashes every other process's uncommitted work for as long as it runs.
When it crashes, times out, hits a busy `index.lock` or conflicts, it leaves a
`.git/rebase-merge` directory with someone else's files inside its autostash.
Every later pull then refuses, and an agent that "repairs" it by hand can
silently revert another agent's in-flight edit. A repo-wide `git add -A` or
`git commit -a` has the same problem from the other side: it commits whatever
another writer has half-written.
<!-- gbrain-allow-shared-tree-git-end -->

## The protocol in plain words

`gbrain git commit-push` does five things, in this order:

1. **Takes this checkout's commit lock, briefly.** One commit lock per
   checkout, held only while it stages and commits (and later while it
   fast-forwards the checkout), never across the network. A second writer
   waits (60 seconds by default) and then fails with `commit_lock_busy`
   instead of skipping silently. The push itself runs under a separate push
   lock, so a slow remote never blocks commits or gbrain's own page writes.
2. **Commits only the paths you name.** It stages and commits exactly those
   paths (`git add -u -- <paths>` for tracked ones, so a deletion under an
   ignored directory still commits, `git add -A -- <paths>` for new files,
   then `git commit --only -- <paths>`), each
   marked literal (`:(literal)<path>`), so a name with `*`, `?` or `[` matches
   only itself. The repository's hooks run as they do for a plain
   `git commit`: a pre-commit check that picks files by pattern still sees
   them and can refuse the commit. Another
   writer's dirty files are never staged, committed, stashed or touched. A file
   another writer already staged under a directory you named is refused
   (`commit_prestaged_paths`) instead of swept in; name the file to claim it.
   A path outside the brain's [source root](#source-roots) is refused
   (`commit_outside_source_root`). When git refuses the commit (a hook, a
   missing identity, a busy index), the paths are unstaged again, so nothing
   is left in the shared index for another writer's commit to pick up.
3. **Pushes your commit, and merges remote commits in memory when the push is
   rejected.** It fetches, builds the merge without touching any working tree
   (`git merge-tree --write-tree` on git 2.38 and later, a three-way merge in a
   temporary index on older git) and pushes the merge commit. Local commits
   whose patch the remote already has (a cherry-picked or rebased copy) are
   left out of that merge: the local commits are replayed in memory onto the
   remote tip without them, so a copy the remote edited since never conflicts
   and a copy the remote reverted is never put back. The merge commit's message
   lists the commits it left out. It makes up to
   eight attempts, backing off, while the remote keeps moving. One push at a
   time runs per checkout and it publishes the newest local commit, so writers
   that queue behind it share its push. The post-commit hook never waits: when
   a push is already running it asks that push to publish its commit too
   (`push_deferred`).
4. **Advances the shared checkout fast-forward only.** `git merge --ff-only`
   refuses, and changes nothing, when another writer moved HEAD or has a local
   edit in a file the merge must change. The push has still landed; the
   checkout just lags until the next commit-push or pull (`pushed_checkout_lagging`).
5. **Stops on a real conflict.** When both sides changed the same file, it
   changes nothing and asks you which version wins
   ([conflicts](#conflicts)).

Remote commits therefore arrive as merge commits named
`gbrain: merge origin/<branch> into <branch>`, so brain history is no longer
linear. That is the price of never rewriting a working tree other writers
are using.

## Commands

A brain hardened with `gbrain sources harden` has a committed helper,
`scripts/brain-commit-push.sh`. It hands the same arguments to
`gbrain git commit-push`, so either form works:

```bash
# Commit and push the files you wrote (paths are relative to the current directory)
scripts/brain-commit-push.sh "people: add alice-example" people/alice-example.md
gbrain git commit-push -m "people: add alice-example" -- people/alice-example.md

# Publish commits already on the branch (the hook's job; also the retry after a push failure)
scripts/brain-commit-push.sh --push-only
gbrain git commit-push --push-only

# Bring remote commits in (fast-forward, or an in-memory merge); never pushes
scripts/brain-commit-push.sh --pull
gbrain git commit-push --pull

# Commit and push the write-through files gbrain could not commit (doctor's dirty_age names them)
gbrain git commit-push --pending

# Stop tracking files and keep them on disk (see "Untrack" below)
gbrain git commit-push --untrack -m "stop tracking the archive" -- archive-example

# Preview: runs the real run's path checks (a path outside the source root, a sparse-checkout
# exclusion and the rest refuse here too), prints the paths, branch and lock it would use; takes no lock, writes nothing
gbrain git commit-push --dry-run -m "people: add alice-example" -- people/alice-example.md
```

Flags: `--path <dir>` acts on a checkout other than the one containing the
current directory (the paths are then relative to `<dir>`, like `git -C`),
`-m` repeats like `git commit` (each one is a new paragraph, so a second `-m`
carries a trailer), `--json` prints one JSON result (or the error envelope),
`--require-clean` makes `--pull` skip when the checkout has any local edit
(the rule the unattended pull cron uses), `--scan-timeout <seconds>` gives the
secret scan every push runs a longer budget than its 300 s default. The command is local only: it pushes
with this machine's git credentials and is never exposed over MCP.

When gbrain is not installed on the machine, or the installed one predates the
scan on every push (its `git commit-push --help` has no `--scan-timeout`), the
helper falls back to a locked path-scoped commit and pushes nothing, because only gbrain scans the commits it
publishes for secrets. It exits 4 (0 when the branch is already on the remote),
logs the commit as local-only and tells you to install gbrain and run
`gbrain git commit-push --push-only`. A named path git left out of the commit
is reported as `commit_paths_skipped`, as `gbrain git commit-push` reports it;
the helper then exits 1, or 4 when the commit is not on the remote.

In a managed canonical worktree (`gbrain sources writer git-durability`) its
persistence owner is the only Git publisher. Save pages with `put_page`,
`edit_page`, `remember` or `capture`. For files written there outside gbrain
(see [files that are not pages](../architecture/topologies.md#files-that-are-not-pages)),
`gbrain git commit-push -m "<msg>" -- <paths>` commits only the named paths
under the checkout's commit lock and reports `committed_local` (or
`nothing_to_commit`) with `managed: true`: it never fetches, merges, pushes or
moves the checkout, and refuses `--pending`, `--branch`, `--resolve` and
`--allow-outside-source-root` there (`commit_paths_invalid`). Its
`unpublished` field counts the commits the upstream lacks as last fetched
(`null` when no fetched upstream can be read), `upstream` names the branch's
configured upstream (`null` when it has none), and it writes no push-log line. Commits wait for
the owner's next Git publish; `gbrain git commit-push --push-only --keep-checkout`
publishes them now. `--push-only` without `--keep-checkout` is still refused with
`writer_coordinator_required`.

A checkout with no Git remote at all (`git remote` prints nothing and the
branch names none) has nothing to publish to: `gbrain git commit-push -m "<msg>" -- <paths>`
commits only the named paths under the commit lock and reports
`committed_local` with `no_remote: true`, saying nothing was pushed.
`--push-only`, `--pending`, `--branch`, `--resolve`/`--expect-remote` and
`--require-clean` are refused there (`commit_paths_invalid`). Add a remote and
set the branch upstream, then `gbrain git commit-push --push-only` publishes the
local commits. A branch that names a remote which does not exist still refuses
(`git_unavailable`).

The one form a managed worktree accepts is `--push-only --keep-checkout`. It
publishes the commits already on the branch, merging a moved remote in memory,
but never moves the checkout and skips its pre-push hook, so
`gbrain sources refresh` stays the only way remote files enter the checkout.
The owner's Git effects use it on their own when another machine pushed first;
you run it only to settle a [conflict](#conflicts) the owner reports.

**Say to your agent:** *"My brain's Git backups stopped pushing. Find out why and get them moving again."*
The agent reads `gbrain sync status --source <id> --json` (`git_push_holds`) or
`gbrain doctor --json` (`parked_effects`). Effects parked after repeated push
failures go through `gbrain sources writer retry-effects <source> --parked-pushes`
(preview with `--dry-run`); a conflict names the user's choice first.

<a id="preview-the-secret-scan"></a>
### Preview the secret scan

`gbrain git scan [--path <dir>] [--from <rev>] [--to <rev>] [--json]` runs the
scan a push runs, over `--from..--to` (by default the upstream as last fetched,
up to `HEAD`), with the checkout's `.gbrain-scan-allow`, and changes nothing:
no fetch, lock, commit or push. It says whether a push would refuse
(`would_refuse`) and lists each finding's commit, path, line, rule and
fingerprint, never the value. Before an upgrade,
`--from $(git rev-list -1 --before="30 days ago" HEAD)` shows what the last 30
days of commits would have hit. `gbrain git commit-push --dry-run` names the
marker that makes a checkout a managed canonical worktree, or none; every push
mode scans either way.

A finding that is not a secret: add its fingerprint (`sha256:` and 16 hex
characters, as the preview prints it) as a line of `.gbrain-scan-allow` at the
checkout root (`#` starts a comment). The scan reads the file from the working
tree, so the next push uses it without a commit. That is deliberate: the file is
the local user's answer to the scan, and writing it takes local write access to
the checkout, which could push directly anyway. In a managed root below the
repository's top level the file sits at that root and its path globs match
paths relative to it. Keep it out of commits (list it
in `.git/info/exclude`): a commit that changes it changes what the scan sees, so
no automatic push publishes it. A fingerprint accepts that exact value wherever
it appears; a line without `sha256:` is a path glob and accepts every finding in
the files it matches.

<a id="outcomes"></a>
## Outcomes

Every run ends in exactly one of these. Successes exit 0; every failure prints
an `[Error <code>]` line (or a JSON envelope with `--json`) and exits non-zero.
Follow the error's `fix.next` as the
[agent operator protocol](../protocol/AGENT_OPERATOR_v1.md) describes.

| Outcome or code | Exit | What the agent does next |
| --- | --- | --- |
| `pushed` | 0 | Done. Report the commit; a hosted link to the file works now. |
| `push_deferred` | 0 | Only with `--require-clean` (the post-commit hook): another push was running in this checkout and was asked to publish HEAD too when it finishes. Nothing to do. |
| `nothing_to_commit` | 0 | The paths had no change. Any earlier local commit on the branch was still pushed, so nothing is waiting (with `no_remote: true` or `managed: true`, nothing is pushed; a managed checkout's `unpublished` counts the commits still waiting). |
| `committed_local` | 0 | A managed canonical worktree, or a checkout with no Git remote (`no_remote: true`): the paths were committed locally and nothing was pushed (a managed result's `unpublished` counts the commits waiting). Report the commit; it reaches a remote on the owner's next publish, or after a remote is added and `--push-only` runs. |
| `pushed_checkout_lagging` | 0 | The push landed but this checkout was not advanced; a `[gbrain notice]` names the files that blocked it. Change nothing: the next commit-push or `--pull` catches the checkout up. Never stash or reset to "fix" it. |
| `commit_lock_busy` | 1 | Another writer held the lock for the whole wait; nothing was committed. Retry once. If it is still busy, tell the user which checkout and lock path the message names and stop. |
| <a id="checkout_not_a_source"></a>`checkout_not_a_source` | 1 | The checkout commit-push resolved from the working directory (no `--path`) is not one of the brain's source checkouts on this host, typically a wrapper that changed into another repository; nothing was staged. The message lists the brain's checkouts. Tell the user to make the script pass `--path` with the absolute brain checkout. A repository that only encloses a source checkout (a brain cloned inside another repository) is not one; a source registered at a subdirectory its checkout tracks is. A host whose brain records no source checkout, or a checkout with `gbrain.sourceRoot` set, is never refused this way. |
| `commit_paths_invalid` | 1 | No paths, a path outside the checkout, the checkout root itself, or a path git would not stage (one outside a sparse-checkout definition included). Name the explicit files you wrote and rerun. |
| <a id="commit_paths_skipped"></a>`commit_paths_skipped` | 1 | Git left a named path out of the commit: a modified file flagged assume-unchanged or skip-worktree (`reason` `assume_unchanged`, `skip_worktree`) or a file inside a nested Git repository (`not_staged`). The other named paths were committed (and, on a classic checkout, pushed); `detail` lists each skipped path, the commit and the pushed head, or the push failure (`publish`) when the push failed too. Check the flags with `git ls-files -v -- <path>`; clear them only after the user agrees, one flag per call (`git update-index --no-assume-unchanged -- <path>`, `git update-index --no-skip-worktree -- <path>`; given both, git clears only the first), and remember skip-worktree is often set on purpose to keep local edits out of commits, or move the file out of the nested repository, then rerun. A skip-worktree file absent from disk (a sparse checkout), a flagged gitlink and ignored files under a named directory are not reported. |
| `commit_prestaged_paths` | 1 | Another writer staged files under a directory you named; nothing was staged or committed. Name your own files explicitly. Unstage the others (`git restore --staged -- <file>`, which keeps their bytes) only after the user agrees. |
| `commit_outside_source_root` | 1 | The commit, or a local commit about to be published, changes files outside the brain's [source root](#source-roots); nothing was pushed. Show the user `git show --stat <sha>`; rerun with `--allow-outside-source-root` only if they want it published. |
| `git_index_locked` | 1 | A git command that does not take the writer lock held `index.lock`. Retry once after a few seconds. |
| `git_index_stale` | 1 | An `index.lock` older than 10 minutes blocks the checkout. Check that no git command is running there, tell the user, and remove the named lock file only with their agreement. |
| `git_operation_in_progress` | 1 | A rebase, merge, cherry-pick or revert is unfinished in the checkout. gbrain never aborts it for you. Follow [stuck rebase](#stuck-rebase). |
| `git_detached_head` | 1 | The checkout is on a detached HEAD or an unborn branch. Check out the branch the remote tracks (`git switch <branch>`), or make the first commit, then rerun. |
| <a id="publish_secret_found"></a>`publish_secret_found` | 1 | On every push `gbrain git commit-push` makes (commit mode, `--pending` and `--push-only`; `--scan-secrets` is accepted for older scripts), so also the post-commit hook `gbrain sources harden` installs and `scripts/brain-commit-push.sh`, and on every automatic publish: the one `gbrain sources refresh` runs on its own, the push of a managed worktree's Git effects, doctor `git_convergence`'s push fixes, the access-policy and durability-scaffolding commits, `gbrain sources push` and the first push of `gbrain bootstrap repo` (#8902; there the remote has no branch yet, so the whole history is scanned). A commit about to be pushed that gbrain did not make for a page write (its commit ledger records its own page-write commits, whose bodies are stored raw by design and are not scanned; a Git effect's commit counts only by the sha gbrain created for it, when its files held the bytes the effect wrote, so an amended or reworded copy is scanned; one that adopted a file edited outside gbrain, or one older than the retained ledger, is scanned) adds a value that looks like a secret, in its message, an added line (even one a later commit removed) or a merge resolution, adds text too large to scan, or changes `.gbrain-scan-allow` or a `.gitattributes` (files that decide what the scan sees); nothing was pushed. The message names each file, line, rule and commit, never the value. Ask the user: remove the value from those unpushed commits, or add a false positive's fingerprint to `.gbrain-scan-allow`, then retry. A commit that changes `.gbrain-scan-allow` or a `.gitattributes` is never published automatically: the user reviews it and pushes it. The exception is the commit `gbrain sources push` or `gbrain bootstrap repo` makes itself from files it has just scanned with that allowlist. Never publish them with a command that skips the scan. On a managed worktree its Git effects hold meanwhile (`gbrain sync status` and doctor list them; the page writes are safe in the database and in local commits); after the fix, `gbrain sources writer retry-effects <source> --parked-pushes` runs the ones that parked. |
| <a id="publish_scan_unreadable"></a>`publish_scan_unreadable` | 1 | Wherever `publish_secret_found` can refuse: the scan could not read the commits about to be pushed in full (a missing or corrupt object, git output it does not recognise, or its time budget), so it reported no secret and nothing was pushed. When it ran out of time (a first push of a long history can need more than the 300 s default), the fix is the same command with `--scan-timeout <seconds>`, four times the budget and at least 1200: run it; the scan still reads every commit, and prints its progress on stderr. `gbrain git commit-push`, `gbrain sources push` and `gbrain bootstrap repo` take `--scan-timeout`. Otherwise run `git fsck` in the checkout, fix what it names, then retry. When the remote has no such branch, a managed worktree's Git effect scans the branch's whole history and creates it only when that scan passes; a history too large to scan in the owner process holds the effects with this code and names `git ls-remote --heads <remote>`: check the upstream, then point it at the right branch or review the history and push the branch yourself. Never publish with a command that skips the scan. On a managed worktree its Git effects hold meanwhile, as for `publish_secret_found`. |
| `integrate_conflict` | 1 | Local and remote commits changed the same file; nothing was merged and the checkout is unchanged. Stop, relay the question to the user, then [resolve](#conflicts). |
| `push_unconfirmed` | 4 | The commit is durable locally but no push destination confirmed it (network, credentials, branch protection, a remote that kept moving, or another push that held the push lock for the whole wait). Fix what the message names, then run `gbrain git commit-push --push-only`. Never force-push. |
| `writer_coordinator_required` | 1 | This is a managed worktree. Stop using git for pages; save them through `put_page` and the other gbrain write tools. `scripts/brain-commit-push.sh` refuses this way on a checkout marked managed and commits nothing; `gbrain git commit-push` refuses this way when git left a named page out of its commit (the same causes as `commit_paths_skipped`), after committing the other named paths locally. Ask the user before re-saving such a page through `put_page` with the managed source (`gbrain put --source-id <source> <slug>`, or `source_id` over MCP; without it the write goes to the default source): it replaces the stored page with the file's content. |
| `git_unavailable` | 1 | A git command failed, often a missing `user.name`/`user.email` or a refusing pre-commit hook. Read the message, fix that, rerun. When the branch names a remote that does not exist (a typo or a broken clone), the run stops before committing: fix the name or add the remote, then rerun. A checkout with no remote at all commits locally instead (`committed_local`). |

`--pull` reports `up_to_date`, `advanced`, `ahead` (local commits not yet
pushed; run `--push-only`), `skipped_dirty` (only with `--require-clean`) or
`lagging` (a dirty file the pull must change blocked it; a notice names it).
All of these exit 0. A diverged branch whose two sides changed the same file
fails with `integrate_conflict`, the same as a push.

The helper's own exits: 2 for a usage error (no message, or no paths: it
refuses a repo-wide commit), 4 when its no-gbrain fallback committed without pushing.

With `--json`, a success prints `outcome`, `sha` (the commit now on the
remote), `committed` (your commit, or null), `branch`, `remote`, `paths`,
`integrated` (remote commits merged in), `checkout` (`advanced`, `unchanged`
or `lagging`), `lagging_reason` when it lags, and `repo`.

Every run also appends a line to `~/.gbrain/brain-push.log`, which
`put_page`'s push status and `gbrain doctor` read. An unresolved
`integrate_conflict` is also recorded in the checkout itself
(`git rev-parse --git-path brain-integrate-conflict.json`), so `put_page`
reports it for that checkout until a publish resolves it.

<a id="source-roots"></a>
## Base check

A script that reads a file, edits it and commits can overwrite a change another writer committed in
between. `--base` closes that gap: record the blob when you read the file
(`git rev-parse HEAD:<path>`, or `absent` for a file that does not exist yet) and pass it back:

```bash
gbrain git commit-push --base notes/summary.md=<blob> -m "update summary" -- notes/summary.md
```

Under the commit lock and before anything is staged, each `--base` path's blob at HEAD must still
equal the one given. Otherwise the command refuses `commit_base_moved` naming the path, the base and
HEAD's blob; nothing is staged or committed. Read the file at HEAD again, redo the change and rerun with
the new base. Every `--base` path must also be one of the committed paths. Pages the agent also edits
are better written with `gbrain put` (put_page), which carries its own revision check.

<a id="untrack"></a>
## Untrack: stop tracking files, keep them on disk

`git rm --cached` followed by a plain commit is the usual way to stop tracking a file, but in a shared
checkout the commit sweeps up whatever else is staged. `--untrack` does it in one locked step:

```bash
gbrain git commit-push --dry-run --untrack -m "stop tracking the archive" -- archive-example   # preview
gbrain git commit-push --untrack -m "stop tracking the archive" -- archive-example
```

It removes every file the last commit holds under each named path from Git and the index, leaves the files
on disk, and commits exactly those deletions (anything else staged stays staged and out of the commit; a commit a
hook changed is taken back). A path the last commit holds nothing under, or a file marked skip-worktree, refuses
`commit_paths_invalid` before anything changes. In an ordinary checkout the commit is pushed like any other.

In a managed canonical worktree (the checkout gbrain's persistence owner writes), untracking a page file would
make the next sync delete that page, so `--untrack` there only takes files under a `storage.db_only` directory
that `gbrain.yml` at HEAD declares and that `.gitignore` ignores. The database row is canonical there, so every
page stays live with its content. Anything else refuses `untrack_not_db_only` with the index as it was: declare
the folder first (add it under `storage.db_only` and its `<dir>/` line to `.gitignore`, commit both with
`gbrain git commit-push -m <msg> -- gbrain.yml .gitignore`), then rerun. The commit stays local, like every
commit-push there; the owner's next Git publish, or `gbrain git commit-push --push-only --keep-checkout`,
publishes it.

If you already ran `git rm --cached` by hand, a plain commit-push of those paths refuses
`commit_paths_skipped` and names the `--untrack` command that commits the removal.

To undo, `git revert <untrack commit>` (then commit-push `--push-only` as usual). The revert writes the
committed bytes back over the files on disk, so copy any local edit to them first.

## Source roots

A brain can be one folder inside a larger repository. `gbrain sources harden`
records the source's folder in the checkout's local git config
(`gbrain.sourceRoot`, one value per source; nothing when the source is the
whole checkout). With a root recorded, `gbrain git commit-push` refuses to
commit a path outside it, and refuses to publish any local commit that changes
a file outside it (`commit_outside_source_root`), whoever made the commit.
That catches a commit made around gbrain, such as a cron's
`git add <dir>/; git commit`, which takes everything any writer had staged.
Merge commits are not judged: gbrain's in-memory merges bring remote files in.
gbrain's own page writes are always confined to their source's folder; the
one exception is the durability scaffolding `gbrain sources harden` commits at
the checkout root (the helper script and the agent instructions file).

**Say to your agent:** *"commit-push refused a commit outside the source root. What is in it?"*
The agent shows you `git show --stat <sha>` for each commit the error names.
If you want it published as it is, it reruns
`gbrain git commit-push --push-only --allow-outside-source-root`.

<a id="pending-write-through"></a>
## Page writes that could not commit

gbrain's own page writes (put_page, remember's facts fences, takes, timeline,
`lint --fix`) commit their one file under the commit lock on a hardened
checkout, waiting 2 seconds for it. They never commit without the lock, since
that races the lock holder on the shared index. When another writer holds the
lock longer, or git refuses the commit, the file is written but not committed,
and gbrain notes it in a pending ledger next to the lock
(`git rev-parse --git-path brain-writethrough-pending.log`). The next page
write that gets the lock commits the pending files with its own, and
`gbrain git commit-push --pending` commits and pushes them on demand.
`gbrain doctor` reports pending files older than 30 minutes as `dirty_age`.
A file flagged assume-unchanged or skip-worktree that differs from HEAD stays
in the ledger (git add skips or refuses it), and `--pending` then fails
`commit_paths_skipped` naming it.

<a id="effect-reverted-edits"></a>
## Edits a gbrain commit reverted

When another writer committed a page file while one of gbrain's Git effects
was committing the same file, older gbrain versions could rebuild the effect's
commit on top of the other commit with the bytes gbrain had staged before it.
HEAD then went back to gbrain's version without any warning, the next sync
imported nothing for that file, and the other writer's edit survived only in
its own commit. Current versions never lay staged bytes over a commit that
changed the file: when that commit also changed the file on disk, it stays
HEAD, the effect completes `superseded` (reason `committed_by_another_writer`)
and the next sync imports it; when the file still holds gbrain's bytes, the
effect stages them again and commits them on top. A strict source's write
refuses `git_target_changed` instead.

To find edits a brain already lost this way, look for a gbrain commit (its
subject starts with `gbrain:`) whose one parent is someone else's commit, made at
most two minutes earlier, that changed a file the gbrain commit also changed.
The loop reads the history reachable from `HEAD` in one `git log` pass and then
diffs only those pairs. It writes nothing, takes no lock and doesn't run gbrain,
so it works the same before and after upgrading. On a synthetic history of
200,000 commits it took about 5 seconds and 360 MB of memory.

```bash
BRAIN=/path/to/brain-checkout
TOP=$(git -C "$BRAIN" rev-parse --show-toplevel)
g() { git -C "$TOP" -c core.quotePath=false "$@"; }
g log --format='%H%x09%P%x09%ct%x09%s' | awk -F'\t' '
  { parent[$1] = $2; at[$1] = $3; ours[$1] = ($4 ~ /^gbrain:/) }
  END { for (c in parent) { p = parent[c]; if (ours[c] && p != "" && p !~ / / && (p in at) && !ours[p] && at[c] - at[p] <= 120) print c, p } }' |
while read -r c p; do
  g diff-tree -r --no-commit-id --name-only "$c" | while IFS= read -r f; do
    g diff-tree -r --no-commit-id --name-only --root -m --first-parent "$p" -- ":(literal)$f" | grep -qxF -- "$f" \
      && echo "$f: edit in $(g log -1 --format='%h (%an, %ci)' "$p") replaced by gbrain commit $(g log -1 --format=%h "$c")"
  done
done
```

A hit looks like this, one line per file:

```text
notes/alice-example.md: edit in 9ee21f7422 (Alice Example, 2026-11-12 10:23:27 +0000) replaced by gbrain commit 15134a6136
```

Each line is a candidate, not proof: a gbrain write made right after someone
else's commit on purpose looks the same. To confirm one, read both versions
(`git show <their commit>:<file>` and `git show <gbrain commit>:<file>`).
While the commit ledger still holds that time, the reverting effect also has an
earlier `effect` line there whose sha is not in history and whose parent is the
other commit's parent (`git log -1 --format=%P <sha>`). Ask the user which
version to keep, then write the chosen content back as an ordinary page write
(`gbrain put` or `put_page` with the page's current revision).

<a id="scripts-and-the-managed-checkout"></a>
## Scripts and the managed checkout

On a managed brain the persistence owner is the only Git writer in the
canonical checkout, and `gbrain sources refresh` is the only way upstream
commits come in. Four rules keep that checkout able to move:

1. **Scripts commit through gbrain, never with plain `git commit`.** A cron
   job or hook that writes files into the checkout and commits them with
   plain git leaves commits the upstream lacks and nobody publishes. The
   checkout diverges, and every later refresh refuses `refresh_diverged` and
   changes nothing. Commit the files a script wrote with
   `gbrain git commit-push --path <absolute checkout> -m "<msg>" -- <paths>`
   (run from another repository without `--path`, it refuses `checkout_not_a_source`): on a managed worktree it
   commits only those paths under the commit lock (`committed_local`) and the
   owner publishes them on its next Git publish. Pages can also go through
   `put_page`, `edit_page`, `remember` or `capture`. CLI calls go through
   the [one wrapper](cron-schedule.md#calling-gbrain-unattended).
2. **Refresh on a schedule.** `gbrain sources refresh <id>` drains queued
   writes, refuses new ones until it finishes, fast-forwards with
   `git merge --ff-only` and re-syncs every source on the checkout; run it
   from cron on the owner host
   ([cron line](../../skills/cron-scheduler/SKILL.md#managed-brain)).
   `refresh_diverged` means something committed outside gbrain:
   `git log --format='%h %an %ad %s' @{upstream}..HEAD` lists the stray
   commits. Fix that writer first, then, after the user agrees, publish the
   stray commits merged with the upstream
   (`gbrain git commit-push --push-only --keep-checkout --scan-secrets --path <checkout>`)
   and retry the refresh, as the [refusal](write-refusals.md#refresh_diverged)
   says. Never force the checkout. When local commits there are expected
   (automations committing alongside a sibling checkout that pushes the same
   branch), each refresh runs that publish itself when the worktree's Git durability is
   on (`sources.refresh_publish_diverged` unset; `false` turns it off, `true` publishes
   with durability off too), after scanning the local commits for secrets
   ([live sync](live-sync.md)); it never publishes over a rewritten upstream.
   `gbrain sources git-reconcile` runs that publish for every source checkout
   on the host, and autopilot runs it each tick. To keep one source's local
   commits on this machine while it still syncs, set
   `sources.auto_reconcile.source.<id> false`; `set-sync off` (below) stops
   its sync as well.
3. **Stop syncing a source before rewriting its history.** Before a
   force-push or `git filter-repo`, run `gbrain sources set-sync <id> off`
   (with the user's agreement) so automatic sync skips it, and
   `gbrain sources mirror-readonly <id>` so no managed write touches its
   checkout. A sync whose recorded base commit no longer exists makes sync and
   the maintenance cycle re-read the whole tree. After the rewrite, move the
   checkout onto the new history
   ([upstream rewritten](troubleshooting.md#upstream-rewritten)), then
   `gbrain sources mirror-writable <id>` and `gbrain sources set-sync <id> on`.
4. **Decide what a gitignored path is.** A page whose file a `.gitignore`
   rule excludes cannot be committed, so its Git effect parks at once as
   `git_target_ignored` naming the rule (since v0.60.427.0). Either un-ignore
   it (remove or narrow the rule, commit that, then
   `gbrain sources writer retry-effects <source> --parked-code git_target_ignored`)
   or keep those pages database-only and leave the effects parked. Ask the
   user which; it decides whether those pages are in the Git backup.

<a id="conflicts"></a>
## Conflicts

A conflict means this machine's unpushed commit and the remote both changed
the same file. On git 2.38 and later that means overlapping changes; on older
git (Ubuntu 22.04 ships 2.34) any change to the same file on both sides counts
as a conflict, even in different paragraphs.

Nothing changes when it happens: the local commit stays local, the checkout is
untouched and nothing is pushed. The error names the files, the local and
remote commits (in its `detail`), and a question to relay to the user. Until it
is resolved, every later commit-push from this checkout hits the same
conflict, even for other files, because the unpushed commit is still waiting.
A conflict reported by a scanned publish (a Git effect's push, a refresh
publish) comes only after the secret scan of what the local commits add to the
remote's current tip passed, and its resolve command keeps `--scan-secrets`.

One kind of conflict settles itself on push. When the remote's version of a
file is one this checkout already had at that path and later replaced with
another version (a stale clone or writer pushed an old copy back, often inside
a merge), gbrain keeps this machine's version: the remote's copy is history
this checkout already moved past. It looks at the last 200 commits that
changed the file. The push lists those files in `superseded_remote_paths`
(`--json`) and a `[gbrain notice]` line, and the merge commit message names
them. A version this checkout never had, a file the remote deleted, and a file
you name with `--resolve` stay ordinary conflicts. When both kinds meet in one
push, the error lists only the real conflicts (its `detail.superseded` names
the others), and the `--resolve` run keeps this machine's version of the
superseded files. `--pull` still reports them as conflicts; a
`gbrain git commit-push --push-only` settles them.

To resolve:

1. Ask the user which version of each file should win, or whether they want
   the two merged by hand. Choosing a side discards the other side's change to
   that file, so never pick one yourself.
2. Look at both versions if it helps the user decide:
   `git show HEAD:<path>` (this machine) and `git show origin/<branch>:<path>`
   (the remote).
3. Rerun with `--expect-remote <remote sha>` (copied from the error) and one
   `--resolve` per conflicted file, using the path exactly as the error
   printed it (relative to the checkout root; the error shell-quotes names
   with spaces or non-ASCII characters):

   ```bash
   # Keep this machine's version
   gbrain git commit-push --push-only --expect-remote 1a2b3c4d5e6f --resolve people/alice-example.md=ours
   # Keep the remote's version
   gbrain git commit-push --push-only --expect-remote 1a2b3c4d5e6f --resolve people/alice-example.md=theirs
   # Use a hand-merged copy written OUTSIDE the checkout
   gbrain git commit-push --push-only --expect-remote 1a2b3c4d5e6f --resolve people/alice-example.md=file:$HOME/.gbrain/merge-alice-example.md
   ```

   It builds the same in-memory merge with your choice for each file, pushes
   it and advances the checkout. A conflicted file left without a `--resolve`
   fails again with every conflicted file listed. If the remote moved since
   the user chose, it reports the conflict again against the new remote
   commit instead of applying the choice to a version nobody saw. Delete the
   merged copy afterwards.

   A file/directory or rename conflict (one side has `topic` as a file, the
   other as a folder) cannot be settled by picking a side per file, so
   `--resolve` refuses it. Move or remove the local path in a new commit
   (`gbrain git commit-push -m "<msg>" -- <paths>`), then run
   `gbrain git commit-push --push-only`.

Write a merged copy outside the checkout: editing the conflicted file in place
leaves it dirty, so the checkout cannot fast-forward over it afterwards.

On a managed worktree the owner's Git effects hold with `integrate_conflict`
instead (the database already has every page write; only the Git backup
waits). The fix the owner reports adds `--keep-checkout` and the checkout's
`--path`; after the choice is pushed, run
`gbrain sources writer retry-effects <source> --parked-pushes` for the effects
that parked meanwhile, then `gbrain sources refresh <source>` to bring the
merged remote files in.

Shared append-only files (a `log.md` every workflow appends to) are the usual
source of conflicts: two appends at the end of the same file overlap. Keep
both sides by merging by hand with `file:`, or make such files derived instead
of hand-appended.

<a id="quarantine"></a>
### Quarantine (opt-in)

A checkout where no one is around to answer the conflict question (an
unattended agent or a cron) can opt in to quarantine instead:

```bash
git -C <checkout> config gbrain.quarantine true
```

With it on, a content conflict no longer stops the push. gbrain publishes the
remote's version of each conflicted file and every non-conflicting change from
this machine, and keeps this machine's version under a ref named
`refs/gbrain/quarantine/<time>-<commit>`. Nothing is dropped: the parked
commit is also part of the published history. commit-push prints a
`[gbrain notice] quarantine` line (the `quarantined` field in `--json`), and
`gbrain doctor` reports the waiting ref as `quarantined_changes` until the
user is done with it.

**Say to your agent:** *"What did gbrain quarantine?"*
The agent shows you the doctor finding and the difference
(`git diff <remote sha> <ref> -- <path>`). Whatever should stay, it commits
again with `gbrain git commit-push -m "<msg>" -- <path>`; when you're
done, it deletes the ref with `git update-ref -d <ref>`.

File/directory and rename conflicts are never quarantined; they stop the push
as described above. Quarantine is off by default.

<a id="stuck-rebase"></a>
## Recovering a stuck rebase

<!-- gbrain-allow-shared-tree-git: names the command that leaves a stuck rebase -->
An older helper or agent that ran `git pull --rebase --autostash` in the shared
checkout and crashed leaves `.git/rebase-merge` (or `.git/rebase-apply`)
behind. gbrain then refuses with `git_operation_in_progress`. The autostash
inside that directory can hold other writers' uncommitted edits, so save it
before anything else. Never delete the directory first.

1. Make sure the rebase is not still running: no `git rebase` or `git pull`
   process in that checkout (`ps -ef | grep '[g]it '`).
2. Save the autostash to the stash list, where it survives everything below:

   ```bash
   cd <brain-checkout>
   for d in rebase-merge rebase-apply; do
     f="$(git rev-parse --git-path "$d/autostash")"
     [ -f "$f" ] && git stash store -m "autostash rescued from a stuck $d" "$(cat "$f")"
   done
   git stash list
   ```

3. End the rebase. `git rebase --abort` returns the branch to where it was
   before the rebase started, so local commits are kept. If it refuses, use
   `git rebase --quit`, which leaves HEAD, the index and the working tree as
   they are.
4. Check whether the edits are back: `git rebase --abort` re-applies the
   autostash when it can, so `git status` may already show them. If so, the
   stash entry is only a spare copy. If not, show the user the rescued edits
   (`git stash show -p stash@{0}`) and ask before putting them back. With
   their agreement:
   `git stash apply stash@{0}` <!-- gbrain-allow-shared-tree-git: restores an autostash rescued in step 2, with the user's agreement -->
   The writers those edits belong to commit them as usual, or you commit them
   with `gbrain git commit-push -m "<msg>" -- <paths>` if the user asks.
5. Bring the checkout up to date: `gbrain git commit-push --pull`.

## Never run these in a shared checkout

Each one moves or captures files other writers are using:

<!-- gbrain-allow-shared-tree-git-begin: the list of commands this guide forbids -->
- `git pull --rebase`, and any pull with `--autostash`: stashes every writer's
  edits for as long as the rebase runs. Use `--pull` instead.
- `git stash` in any form other than `git stash store`, `list` or `show`:
  hides other writers' edits.
- `git add -A`, `git add .` or `git commit -a` without explicit paths: commits
  other writers' half-written files. Name your paths.
- `git reset --hard`: discards other writers' edits.
- `git push --force`: deletes other writers' published commits.
- A plain `git push`: not destructive, but it does not take the writer lock or
  integrate a rejected push. Use `--push-only`.
- Deleting `.git/rebase-merge` before its autostash is saved
  ([stuck rebase](#stuck-rebase)).
<!-- gbrain-allow-shared-tree-git-end -->

`gbrain sources harden` also sets `rebase.autoStash=false`, `merge.autoStash=false`
and `pull.ff=only` in the checkout's local git config, so a stray `git pull`
refuses instead of autostashing.

The repository lint `bun run check:shared-tree-git` fails a gbrain skill,
recipe, template or doc that teaches any of these in a code block or an inline
code span. A line that must name one (a warning, or a single-writer clone such
as a fresh export) carries `# gbrain-allow-shared-tree-git: <reason>` on the
same line inside a code block, or `<!-- gbrain-allow-shared-tree-git: <reason> -->`
on the line before it in prose. A list of them, like the one above, sits
between `<!-- gbrain-allow-shared-tree-git-begin: <reason> -->` and
`<!-- gbrain-allow-shared-tree-git-end -->`. `git push --dry-run` is read-only
and never flagged.

<a id="lock-contract"></a>
## Lock contract for host daemons

A process outside gbrain that commits or pulls the same checkout (a host
git-sync service, your own cron script, an OpenClaw host's sync) joins the
protocol by taking the same lock. The simplest way is to call
`gbrain git commit-push --pull` and `gbrain git commit-push -m "<msg>" -- <paths>`,
which take it for you. A daemon that runs git itself follows this contract:

- **Lock file:** `git rev-parse --git-path brain-commit.lock` (the commit lock), one per checkout
  (each linked worktree has its own). The lock is an exclusive OS file lock,
  the same one `flock -x` takes on Linux and macOS. The file existing means
  nothing; never delete it.
- **Legacy lock:** helpers and hooks from before this protocol take
  `gbrain-push.lock` in the same directory. gbrain takes both, always
  `brain-commit.lock` first; a daemon that may share a checkout with an old
  helper does the same, in the same order.
- **Hold it** for local changes only: staging, committing, and moving the
  checkout. Release it before pushing and push under `brain-publish.lock`, as
  gbrain does. A daemon that pushes while holding the commit lock cannot make
  gbrain lose or revert its commits, but every gbrain writer waits for it:
  `commit-push` fails `commit_lock_busy` after its wait, page writes leave
  their files pending, and gbrain's publisher reports `pushed_checkout_lagging`
  because it cannot advance the checkout. Its own plain push also loses races
  to gbrain's merged pushes and strands its commit until
  `gbrain git commit-push --push-only` runs.
- **Commit with explicit paths** (`git commit --only -- <paths>`). A commit
  without paths takes everything any writer has staged in the shared index.
- **Mark your children:** while holding the lock, set
  `BRAIN_COMMIT_LOCK_HELD` to the lock file's absolute path in the environment
  of anything you start that may take it, such as `gbrain git commit-push` or a
  `git commit` whose post-commit hook runs gbrain. gbrain honors the marker only
  when it names this lock and the lock really is held, so a stale, copied or
  generic (`1`) marker cannot skip the lock.
- **Wait time:** gbrain waits `GBRAIN_COMMIT_LOCK_WAIT_SECONDS` (alias
  `GBRAIN_PUSH_LOCK_WAIT_SECONDS`), default 60, then fails with
  `commit_lock_busy`. Wait the same way and fail loudly; never skip silently.
  A push waits `GBRAIN_PUBLISH_LOCK_WAIT_SECONDS` (default 300) for another
  push in the same checkout, then fails with `push_unconfirmed`.
- **Inside the lock:** integrate with `git fetch` plus
  `git -c merge.autoStash=false merge --ff-only`, or call `gbrain git commit-push --pull`;
  never rebase, stash or reset the shared tree.

```bash
cd <brain-checkout>
exec 8>"$(git rev-parse --git-path brain-commit.lock)"
flock -w "${GBRAIN_COMMIT_LOCK_WAIT_SECONDS:-60}" 8 || { echo "commit_lock_busy" >&2; exit 75; }
exec 9>"$(git rev-parse --git-path gbrain-push.lock)"
flock -w "${GBRAIN_COMMIT_LOCK_WAIT_SECONDS:-60}" 9 || { echo "commit_lock_busy" >&2; exit 75; }
export BRAIN_COMMIT_LOCK_HELD="$(git rev-parse --path-format=absolute --git-path brain-commit.lock)"
gbrain git commit-push --pull
gbrain git commit-push -m "host sync: daily notes" -- daily/
```

<a id="commit-guard"></a>
## Commit guard (opt-in)

`gbrain git guard --install` adds a local, untracked `prepare-commit-msg` hook
to the checkout. It refuses every commit that gbrain did not make under the
commit lock: a plain `git commit`, `-a`, `--amend`, and `--no-verify` too,
because that flag skips only the pre-commit and commit-msg hooks. A refused
commit changes nothing; whatever its writer staged stays staged. gbrain's own
commits (commit-push, page writes, the helper, including its no-gbrain
fallback) pass because they name the lock they hold. A merge commit, and a
commit that finishes a merge, cherry-pick, revert or rebase, pass too:
refusing those would leave the operation half done in the shared tree.
`gbrain git guard` prints whether it is installed, and
`gbrain git guard --uninstall` removes it. It refuses to replace another
tool's `prepare-commit-msg` hook and needs git 2.31 or later. It is off
unless you install it.

**Say to your agent:** *"Stop crons and other scripts from committing to my brain around gbrain."*
Your agent runs `gbrain git guard --install` in the brain checkout.

A person who needs a plain commit once bypasses it for that one command:

```bash
GBRAIN_COMMIT_GUARD=off git commit -m "fix the README by hand" -- README.md
```

<a id="owner-path-guard"></a>
### Owner-path guard (managed worktrees)

`gbrain git guard --install` refuses a managed canonical worktree. Its owner
installs the guard there with
`gbrain sources guard <source> --install [--mode enforce]` instead. It runs
only on the source's owner host (any other host is refused
`permission_denied`), under the worktree's writer lock, from the trusted local
CLI. The hook goes in a hooks directory private to that worktree
(`<worktree git dir>/gbrain-hooks`), and only that worktree's
`core.hooksPath` points at it (`git config --worktree`; gbrain enables
`extensions.worktreeConfig` when the repository has linked worktrees), so a
person's own linked checkout of the same repository keeps its hooks. It refuses,
changing nothing, when another tool's hook lives at the worktree's current
hooks path.

`--mode enforce` also refuses cherry-pick, revert, rebase and sequencer
commits: in a managed worktree only the owner commits. The owner's writers
pass unchanged: the effect worker commits with an empty hooks directory, page
writes through the door and the in-memory merges are plumbing that runs no
commit hook, sync's auto-init turns hooks off, `commit-push` names the commit
lock it holds, and a refresh fast-forward runs no commit hook.
`gbrain sources guard <source> --status` prints whether it is installed, its
mode and the effective hooks path; `--uninstall` removes it. A worktree added
later with `git worktree add` inherits the hooks path (git copies
`config.worktree`); the guard lets its commits through, and
`git config --worktree --unset core.hooksPath` in that worktree restores its
own hooks.

A writer that turns hooks off itself (`git -c core.hooksPath=/dev/null commit`)
is not stopped by any hook. The [commit ledger](#commit-ledger) names it.

<a id="commit-ledger"></a>
## Commit ledger

Every commit gbrain makes is appended as one JSON line to
`<git common dir>/gbrain/commit-ledger.jsonl`: the sha, the writer
(`commit_push`, `door`, `merge`, `replay`, `effect`, `sync_init`,
`workspace_push`, `bootstrap`, `hosted_repo`), the worktree, ref, pid and host.
The file sits inside `.git`, so it is never tracked, and every worktree of the
repository shares it. Appends take their own lock
(`commit-ledger.lock` beside it) for microseconds, never while git runs. The
first append writes a `start` line; at 4 MiB the file rotates to
`commit-ledger.1.jsonl` (one previous file is kept). A `git commit` gbrain runs
writes an `intent` line first (the HEAD before it and the message's sha256)
and the commit line after; a plumbing commit is recorded before its ref moves.
A failed append never fails the commit: gbrain logs it once, and doctor then
reports that commit as foreign. Nothing reads or writes the ledger in a
repo-less brain.

<a id="foreign-writers"></a>
## Foreign writers (doctor `foreign_writers`)

`gbrain doctor --only foreign_writers` reads every registered source checkout
on this host, managed worktrees included, once per repository. It is read-only.

- **Foreign commits.** It reads the reflogs of local ref moves (`logs/HEAD`,
  `logs/refs/heads/*` and each linked worktree's `HEAD` log). A commit created
  here (`commit`, `--amend`, cherry-pick, revert, rebase or `pull --rebase`
  picks, `am`, or an `update-ref` after `commit-tree`) that the ledger does not
  name was made by another writer. Merges, fast-forwards, pulls, resets,
  checkouts, branch moves and clones are not commits made here. Each is
  labelled `plain`, `amend`, `rewrite` or `plumbing`; a plain commit made while
  the enforce guard was installed reads `plain (guard bypassed)`. Any foreign
  commit fails the check, naming the newest one:
  `Commit <sha12> (<kind>, "<subject>", <time>) in <checkout> was not made by
  gbrain; route that writer through gbrain git commit-push or a page write`.
  An older gbrain co-installed on the host (one without the commit ledger)
  also reads as a foreign writer; a foreign commit whose message carries a
  `gbrain-*:` trailer is flagged `gbrain_trailer` and named as possibly that,
  but still fails, since a trailer alone proves nothing.
  Ask the user which job makes such commits before changing anything.
- **Covered window.** Reflog entries older than the ledger's start (or its
  oldest retained line after rotation) are reported as uncovered, never
  foreign. A repository gbrain has not committed in yet has an empty window.
- **Unconfirmed commits.** A commit whose parent and message match an open
  intent within 60 seconds (gbrain crashed between `git commit` and the
  ledger line) is a warning and is never written back to the ledger.
- **Dirty page files.** Untracked and modified files under the source roots
  are listed by age (their mtime), leaving out files gbrain is about to commit
  (a queued or running git effect, or the write-through pending ledger). Files
  older than 30 minutes warn.

The JSON (`details`) carries the window per repository, every foreign commit
(sha, kind, ref, time, subject, committer), the unconfirmed ones, ref moves it
could not read, and at most 20 dirty files with the total count. Whatever the
scan could not read leaves it partial (a warning) with the reasons in
`partial_reasons`: a root inside a Git checkout that git cannot read, source
roots past the 50-root cap, an unreadable ledger, a `git status` that failed
or timed out (it gets up to 30 s within doctor's budget), or doctor's budget
running out. A brain with no Git checkout reports `not_applicable`; a scan
that skipped a root never does.

## Limits

- **Two agents editing the same file at the same time still conflict.** The
  lock serializes commits, not edits: if two writers change one file, the
  second commit carries whatever is on disk when it commits, and edits on two
  machines meet as an `integrate_conflict`. When agents routinely write the
  same pages, use managed mode, where pages go through `put_page` and one
  persistence owner
  ([topologies](../architecture/topologies.md#files-that-are-not-pages)).
- **git older than 2.38** has no `merge-tree --write-tree`, so any file changed
  on both sides is a conflict, even when the changes do not overlap.
- **A lagging checkout is not repaired automatically** while another writer's
  edit blocks it. The next commit-push or `--pull` after that edit is
  committed brings it current.
- **Writers that skip the lock** (a hand-run `git commit`) are not excluded
  unless the [commit guard](#commit-guard) is installed. They cannot revert a
  locked writer's commit, because the checkout only fast-forwards, but a commit
  without paths can still sweep up staged files; with a
  [source root](#source-roots) recorded, gbrain refuses to publish one that
  reaches outside it. `gbrain doctor` reports such unpushed commits
  (`commits_outside_source_root`), a checkout behind its upstream for over an
  hour (`checkout_lagging`), pending or long-staged files (`dirty_age`),
  local versions the opt-in [quarantine](#quarantine) parked
  (`quarantined_changes`), and every commit gbrain did not make
  ([`foreign_writers`](#foreign-writers)).
- **No page-aware merge.** Two edits to the same page meet as a text conflict;
  a merge driver that understands page sections is a planned follow-up.

## Related

- [Multi-source brains: durability hardening](multi-source-brains.md)
- [Live sync](live-sync.md)
- [Agent operator protocol](../protocol/AGENT_OPERATOR_v1.md)
- [Error codes](error-codes.md)
