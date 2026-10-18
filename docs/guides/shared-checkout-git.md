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
   paths (`git add -A -- <paths>`, `git commit --only -- <paths>`). Another
   writer's dirty files are never staged, committed, stashed or touched.
3. **Pushes your commit, and merges remote commits in memory when the push is
   rejected.** It fetches, builds the merge without touching any working tree
   (`git merge-tree --write-tree` on git 2.38 and later, a three-way merge in a
   temporary index on older git) and pushes the merge commit. It makes up to
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

# Preview: prints the paths, branch and lock it would use; takes no lock, writes nothing
gbrain git commit-push --dry-run -m "people: add alice-example" -- people/alice-example.md
```

Flags: `--path <dir>` acts on a checkout other than the one containing the
current directory, `--json` prints one JSON result (or the error envelope),
`--require-clean` makes `--pull` skip when the checkout has any local edit
(the rule the unattended pull cron uses). The command is local only: it pushes
with this machine's git credentials and is never exposed over MCP.

When gbrain is not installed on the machine, the helper falls back to a locked
path-scoped commit and a plain push. A rejected push then fails loudly (exit 4)
and tells you to install gbrain and run `gbrain git commit-push --push-only`;
the fallback never integrates remote commits itself.

A managed canonical worktree (`gbrain sources writer git-durability`) refuses
both forms with `writer_coordinator_required`: its persistence owner is the only
Git writer there. Save pages with `put_page`, `edit_page`, `remember` or
`capture`; see [files that are not pages](../architecture/topologies.md#files-that-are-not-pages).

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
| `nothing_to_commit` | 0 | The paths had no change. Any earlier local commit on the branch was still pushed, so nothing is waiting. |
| `pushed_checkout_lagging` | 0 | The push landed but this checkout was not advanced; a `[gbrain notice]` names the files that blocked it. Change nothing: the next commit-push or `--pull` catches the checkout up. Never stash or reset to "fix" it. |
| `commit_lock_busy` | 1 | Another writer held the lock for the whole wait; nothing was committed. Retry once. If it is still busy, tell the user which checkout and lock path the message names and stop. |
| `commit_paths_invalid` | 1 | No paths, a path outside the checkout, the checkout root itself, or a path git would not stage. Name the explicit files you wrote and rerun. |
| `git_index_locked` | 1 | A git command that does not take the writer lock held `index.lock`. Retry once after a few seconds. |
| `git_index_stale` | 1 | An `index.lock` older than 10 minutes blocks the checkout. Check that no git command is running there, tell the user, and remove the named lock file only with their agreement. |
| `git_operation_in_progress` | 1 | A rebase, merge, cherry-pick or revert is unfinished in the checkout. gbrain never aborts it for you. Follow [stuck rebase](#stuck-rebase). |
| `git_detached_head` | 1 | The checkout is on a detached HEAD or an unborn branch. Check out the branch the remote tracks (`git switch <branch>`), or make the first commit, then rerun. |
| `integrate_conflict` | 1 | Local and remote commits changed the same file; nothing was merged and the checkout is unchanged. Stop, relay the question to the user, then [resolve](#conflicts). |
| `push_unconfirmed` | 4 | The commit is durable locally but no push destination confirmed it (network, credentials, branch protection, a remote that kept moving, or another push that held the push lock for the whole wait). Fix what the message names, then run `gbrain git commit-push --push-only`. Never force-push. |
| `writer_coordinator_required` | 1 | This is a managed worktree. Stop using git for pages; save them through `put_page` and the other gbrain write tools. |
| `git_unavailable` | 1 | A git command failed, often a missing `user.name`/`user.email` or a refusing pre-commit hook. Read the message, fix that, rerun. When the branch has no usable remote at all, the run stops before committing: add the remote, or commit locally with `git add <paths> && git commit -m "<msg>" -- <paths>`. |

`--pull` reports `up_to_date`, `advanced`, `ahead` (local commits not yet
pushed; run `--push-only`), `skipped_dirty` (only with `--require-clean`) or
`lagging` (a dirty file the pull must change blocked it; a notice names it).
All of these exit 0. A diverged branch whose two sides changed the same file
fails with `integrate_conflict`, the same as a push.

The helper's own exits: 2 for a usage error (no message, or no paths: it
refuses a repo-wide commit), 4 when its no-gbrain fallback could not push.

With `--json`, a success prints `outcome`, `sha` (the commit now on the
remote), `committed` (your commit, or null), `branch`, `remote`, `paths`,
`integrated` (remote commits merged in), `checkout` (`advanced`, `unchanged`
or `lagging`), `lagging_reason` when it lags, and `repo`.

Every run also appends a line to `~/.gbrain/brain-push.log`, which
`put_page`'s push status and `gbrain doctor` read. An unresolved
`integrate_conflict` is also recorded in the checkout itself
(`git rev-parse --git-path brain-integrate-conflict.json`), so `put_page`
reports it for that checkout until a publish resolves it.

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

Shared append-only files (a `log.md` every workflow appends to) are the usual
source of conflicts: two appends at the end of the same file overlap. Keep
both sides by merging by hand with `file:`, or make such files derived instead
of hand-appended.

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
- **Hold it** for local changes: staging, committing, and moving the
  checkout. gbrain itself releases it before pushing and pushes under
  `brain-publish.lock`; a daemon that pushes while holding the commit lock is
  still safe, it just delays other writers' commits for as long as the push
  takes.
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
- **Writers that skip the lock** (a hand-run `git commit`) are not excluded;
  they cannot revert a locked writer's commit, because the checkout only
  fast-forwards, but they can still sweep up files with a repo-wide add.

## Related

- [Multi-source brains: durability hardening](multi-source-brains.md)
- [Live sync](live-sync.md)
- [Agent operator protocol](../protocol/AGENT_OPERATOR_v1.md)
- [Error codes](error-codes.md)
