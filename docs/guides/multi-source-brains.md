# Multi-source brains

**A single gbrain database can hold multiple knowledge repos.** Each one
is a `source`: a logical brain-within-the-brain with its own slug
namespace, its own sync state, and its own federation policy. The rest
of this guide walks the three canonical scenarios.

(Sources are the *within-one-database* axis. If you want to connect a
whole separate database — a team-published brain with its own access
policy — that's the *brain* axis: `gbrain mounts add`. See
`docs/architecture/brains-and-sources.md` for the two-axis topology.)

## The three scenarios

### 1. Unified knowledge recall (wiki + gstack)

You have a personal wiki and a `gstack` checkout. Both belong to you,
both are knowledge you want your agent to recall across. When you ask
"what did I learn about X?" you want the best hit whether it lives in
the wiki or in a gstack plan.

```bash
# Register the gstack source, federate so it joins cross-source search
gbrain sources add gstack --path ~/.gstack --federated

# Pin the directory so `gbrain sync` knows which source it's walking
cd ~/.gstack && gbrain sources attach gstack

# Initial sync
gbrain sync --source gstack

# Now `gbrain search "retry budgets"` returns hits from BOTH wiki and
# gstack. Each result includes source_id so the agent can cite properly.
```

Result: wiki pages and gstack plans are separate (different source_ids,
different slug namespaces) but share the search surface.

### 2. Purpose-separated brains (news-desk + essays)

You run two completely different content pipelines on the same backend.
`news-desk` covers company news and founder profiles. `essays` is
personal writing. You explicitly DON'T want them mixed in search — news
content leaking into essay searches is a bug, not a feature.

```bash
# Two sources, both isolated (federated=false)
gbrain sources add news-desk --path ~/news-desk --no-federated
gbrain sources add essays --path ~/writing --no-federated

# Pin each checkout directory
(cd ~/news-desk && gbrain sources attach news-desk)
(cd ~/writing && gbrain sources attach essays)

# Sync each independently
gbrain sync --source news-desk
gbrain sync --source essays
```

Result: searching from neither directory returns the `default` source
(your main brain). Searching from inside `~/news-desk` returns only
news-desk hits. Searching from inside `~/writing` returns only essays.
Federation is opt-in, not leaked.

To search across every source explicitly on demand (trusted local CLI;
`--source` takes exactly one id):

```bash
gbrain search "tech layoffs" --source-id __all__
```

### 3. Mixed (wiki federated + sessions isolated)

Your main wiki is federated with a few trusted sources. Your session
transcripts (`gbrain transcripts` ingests them) land in a separate
isolated source so they don't dominate every search result.

```bash
# Federated sources
gbrain sources add gstack --path ~/.gstack --federated

# Isolated source for session transcripts
gbrain sources add sessions --path ~/.claude/sessions --no-federated
```

## Resolution priority

When any command needs to pick a source, gbrain walks this list (highest
first):

1. Explicit `--source <id>` flag.
2. `GBRAIN_SOURCE` environment variable.
3. `.gbrain-source` dotfile in CWD or any ancestor directory.
4. A registered source whose `local_path` contains the CWD (longest
   prefix wins for nested checkouts).
5. The brain-level default set via `gbrain sources default <id>`.
6. The seeded `default` source.

So inside `~/.gstack/plans/` on a brain that pinned `gstack` to
`~/.gstack` via `.gbrain-source`, `gbrain put` implicitly writes to
the `gstack` source. Outside any registered directory with no env/dotfile
set, it writes to the default.

## Federation flag

Every source row stores `config.federated: boolean` in its JSONB config.

| Value | Meaning |
|-------|---------|
| `true` | Source participates in unqualified `gbrain search "X"` results. |
| `false` (default for new sources) | Source only searched when explicitly named via `--source <id>` or qualified citation. |

The seeded `default` source is `federated=true` so single-source brains
behave as you'd expect — every page appears in search.

Flip later with `gbrain sources federate <id>` / `unfederate <id>`.

### An unscoped connection whose sources hold no pages

A remote token minted without `--sources`, or an agent stdio connection with
no binding, has no source grant: it reads the `default` source plus every
federated source. Because a new source is not federated, a brain whose pages
all live in such sources would answer that connection's every search with an
empty result that reads like a clean miss.

So an unscoped `search`, `query`, `recall` or `list_pages` from such a
connection that comes back empty is refused with `sources_not_readable` when
the sources it reads hold no page at all (for `recall` and `query`, no world fact either)
while other sources on the brain hold pages. The refusal
never names a source the connection cannot read. Its fix is host-side: the
user picks the source these connections should read and the brain host runs
`gbrain sources federate <source>`, or grants the connection its sources
(`gbrain auth rescope --token <name> --sources <ids>`).

Nothing else changes. A read whose sources hold pages but match nothing
answers empty, as does a brain where no source holds a page. A token granted
sources, an OAuth client, a bound connection and a read that names
`source_id` or `source_ids` are never refused: the refusal only ever stops a
call, never widens what it reads. Federating a source never shows its
`visibility: private` pages to a remote connection.

On a brain that is not managed, `gbrain sources add` without `--federated` or `--no-federated` warns on stderr that the new source is not federated, and
when the sources an unscoped connection reads hold no page it also prints the
next step on stdout (`next: gbrain sources federate <id>`), and as `next`
(`command`, `argv`, `why`) under `--json`. A managed brain's `sources add`
prints its lifecycle receipt instead, without the warning or the next step.

### Explicit reads from a bound agent connection

An agent connection started with `GBRAIN_SOURCE=<id>` (or inside a
directory pinned by `.gbrain-source`) is bound to that source. Its
unqualified reads stay on the bound source. It may still name another
source in an explicit `source_id` read (`search`, `query`, `get_page`,
`list_pages`, `resolve_slugs`, `recall`, `get_links`, `get_backlinks`,
`traverse_graph`) when that source is
`federated=true`; the result holds only the named source's rows. Writes
still go to the bound source only.

| Refusal hint | Why | Fix (on the brain host) |
|--------------|-----|-------------------------|
| `<id> is not federated` | The named source is not federated. | `gbrain sources federate <id>`, or start the connection without the binding. |
| `<id> opted out of federation` | The named source was unfederated. | `gbrain sources federate <id>` if it should be readable from other sources. |
| `<bound> opted out of federation …, so it reads no other source` | The bound source itself is isolated (`federated=false`), so it never reads another source. | `gbrain sources federate <bound>`, or start the connection without the binding. |
| `Your token is not granted <id>` | An HTTP token or OAuth client whose grant does not include the source. | `gbrain auth rescope-client <client_id> --federated-read <ids>` for an OAuth client; `gbrain auth rescope-token <name> --sources <ids>` for a legacy bearer token. |

`search_by_image`, `open_loops` and the code-intel tools keep their stricter
rule: an explicit `source_id` must be inside the connection's own source or
grant.

### Narrow one request with `source_ids`

`search` and `query` take `source_ids`, a list of source ids (CLI:
`--source-ids source-a,source-b`). The request reads only those sources:

- Each id is checked exactly like an explicit `source_id`. A remote agent
  naming a source outside its grant gets `permission_denied` for the whole
  request, and a removed or archived source gets `unknown_source`. So the
  list can narrow a request but never widen it.
- Omitting `source_ids`, or passing `[]` or a blank string, reads every
  source the caller can read, as before.
- With `source_id` as well, the request reads the sources in both
  (`source_id: "__all__"` keeps the list). If none are left, nothing is
  searched: the result is empty with an `empty_retrieval` notice, never a
  fallback to the wider scope.
- `__all__` and malformed ids in the list are `invalid_params`.

Every part of the request reads the narrowed sources: keyword, vector and
title matches, other names, entity anchoring, saved facts, the CRAG re-run,
think escalation and evidence delivery.

**Say to your agent:** *"Search my brain for the acme-example renewal, but
only in source-a."*

### A bot acting for many members

A shared brain often holds one source per member or project, with one bot
answering for several people. Give each member their own token, granted only
the sources that member may read, and send each member's requests with that
member's token. This is the supported production setup today: one
`serve-http` API key per member, each with its own source grant. The server
never learns who is asking from the request itself.

```bash
gbrain auth create bot-alice-example
gbrain auth rescope --token bot-alice-example --sources source-a
# OAuth client instead of a bearer token:
gbrain auth rescope --client <client_id> --sources source-a
```

The token's grant is the security boundary: the server scopes every call to
the grant of the token that made it, whatever the call's arguments say.
`source_ids` is a convenience inside that boundary. A bot holding one token
granted several sources can pass `source_ids` to keep one request to the
current member's sources, but a prompt-injected or buggy bot can omit it, so
it does not separate members who must not see each other's pages. Use
per-member tokens for that, and `source_ids` to narrow further.

### Lay out sources by who may read them

gbrain enforces access per source, never per page. Two pages in one source are
readable by exactly the same tokens. So put content in sources by who may read
it, before any member's bot connects:

- **One source per channel, team or member.** Give a channel's pages a source
  of their own (`channel-a`), a team's documents theirs (`team-a`), and each
  member a private one (`private-alice-example`). Content everyone may read
  goes in a shared source (`public`).
- **One grant per member.** Grant each member's token or client every source
  that member may read, and nothing else:

  ```bash
  gbrain auth rescope --token bot-alice-example --sources private-alice-example,channel-a,team-a,public
  gbrain auth rescope --client <client_id> --sources private-alice-example,channel-a,team-a,public
  ```

  The first id is the token's write source, so a member's saved memories land
  in their own private source.

> **Warning: one shared source has no boundary inside it.** A bot that answers
> everyone with one unscoped token over a single source exposes everything in
> that source to every requester. Neither `source_ids` nor a search limit can
> narrow a read inside one source: `source_ids` chooses whole sources, and a
> limit only shortens a ranked list, which can still start with a page the
> requester should not see. Semantic search makes this more visible, because
> it returns related pages that a keyword search would not match. Split the
> content into sources first, then grant per member.

### Links, backlinks and the graph across sources

`gbrain links`, `gbrain backlinks` and `gbrain graph` (MCP: `get_links`,
`get_backlinks`, `traverse_graph`) read the same sources as `search` for the
same caller:

| Caller | Unqualified read | `--source <id>` / `--source-id <id>` | `--all-sources` |
|--------|------------------|--------------------------------------|-----------------|
| Local CLI, source not pinned | Every federated source: one read per source, merged | That source | Every source |
| Local CLI, pinned by `--source`, `GBRAIN_SOURCE` or `.gbrain-source` | The pinned source | That source | Every source |
| Remote agent with no source grant | Every federated source | A federated source | Every federated source |
| Remote agent with a grant | Its granted sources (never wider) | A granted source | Its granted sources |

```bash
gbrain backlinks companies/acme-example                     # resolved scope
gbrain backlinks companies/acme-example --source business   # one source
gbrain links people/alice-example --all-sources --json      # every source
gbrain graph people/alice-example --depth 2 --all-sources
```

Each call returns at most 500 rows (`--limit N`, up to 5000), merged across
sources and identity members in link order before the cut. When more match, the
last row carries `truncated: true` and `next_cursor`; continue with
`--cursor <next_cursor>` and the same flags, or pass `--all` to page through
every row.

`get_links` keeps working as an alias of `links`. Passing `--source` together
with `--source-id` or `--all-sources` is an error. A source that does not exist
or is archived answers `unknown_source`; a remote agent naming a source outside
its grant or federated set gets `permission_denied` with the fix, even when that
source is archived. Private pages stay hidden from remote agents exactly as in
`search`.

Graph output carries source ids: each `gbrain graph` node has `source_id`, and
each edge returned to agents has `from_source_id` / `to_source_id`. The same slug
in two sources is two nodes or two edges.

When a local unqualified read finds nothing but the page has links in a source
outside the read (a non-federated source), the CLI prints the per-source counts
and the exact rerun command on stderr, for example
`gbrain backlinks companies/acme-example --source priv`; stdout stays the empty
result and `--json` prints no hint. Remote agents never get this hint, so a
source they cannot read stays indistinguishable from an empty one.

On a thin-client install the link commands send an ambient `GBRAIN_SOURCE` or
`.gbrain-source` binding as `source_id`, so they are narrowed the same way
`search` is. An empty narrowed result says which binding scoped it and prints
the `--all-sources` rerun command. If the brain host is older and ignores
`source_id` or `--all-sources`, the command fails with "the brain host does not
support … upgrade the host" instead of printing an unscoped result. Hosts that
predate unknown-parameter warnings cannot be detected; upgrade the host first.

**Say to your agent:** *"Show me everything that links to acme-example across my sources."*

**Say to your agent:** *"Which pages does alice-example link to in the business source only?"*

## Commands

The most-used subcommands (run `gbrain sources --help` for the full,
always-current reference — it also covers `status`, `current`,
`set-cr-mode`, and the `push`/`pull` durability surface).

Changing the contextual retrieval mode, per source with `gbrain sources
set-cr-mode <id> <mode>` or brain-wide with `gbrain config set
search.contextual_retrieval <mode>`, does not restamp existing pages: each
keeps the mode recorded when it was imported, and the new mode applies to
pages imported from then on. Both commands print this after the write, with
`gbrain repair contextual-mode [--source <id>] --apply` for pages that have no
recorded mode (preview it first without `--apply`; see
[repair](repair.md)).


```
gbrain sources add <id> --path <p> [--name <n>] [--federated|--no-federated] [--force] [--json]
                               Register a source. id: [a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?
                               --path must be a git repo (or a subdirectory of one) — see
                               "The git requirement for --path sources" below. --force
                               skips that check to register before git-init exists.
gbrain sources add <id> --url <git-url> [--pat-file <p>] [--clone-dir <path>] [--no-harden]
                               Clone + register a remote repo in one step; auto-hardens
                               for durability when a PAT is provided (see "Durability" below).
gbrain sources list [--json]   List all sources with page counts + federation state.
gbrain sources archive <id>    Soft-delete: hide from search, keep data for a TTL
                               grace window. Prefer this over `remove`.
gbrain sources restore <id>    Un-archive. `gbrain sources archived` lists expiries;
                               `gbrain sources purge` permanently deletes expired archives —
                               except sources still referenced by a registered OAuth client
                               (reported as `Blocked:`, sweep continues); revoke or rescope
                               the client (`gbrain auth revoke-client <id>`) and re-run.
gbrain sources remove <id> [--confirm-destructive] [--dry-run]
                               Permanently cascade-delete a source (pages, chunks,
                               timeline). Shows an impact preview first.
gbrain sources rename <id> <new-name>
                               Change display name only; id is immutable.
gbrain sources default <id>    Set the brain-level default.
gbrain sources attach <id>     Write .gbrain-source in CWD (like kubectl context).
gbrain sources detach          Remove .gbrain-source from CWD.
gbrain sources federate <id>
gbrain sources unfederate <id>
gbrain sources mirror-readonly <id>
gbrain sources mirror-writable <id>
gbrain sources refresh <id> [--dry-run] [--resume|--abandon]   Managed brains: fast-forward the checkout and sync.
gbrain sources set-strategy <id> <markdown|code|auto>
gbrain sources set-sync <id> <on|off> [--dry-run] [--expect <on|off>]
                               Include or exclude the source from automatic sync
                               (config.syncEnabled; an explicit gbrain sync --source
                               still runs). --dry-run prints the apply command, which
                               carries --expect; a moved state refuses preview_changed.
gbrain sources host-repo <id> --dir <path> [--push-remote <url>] [--dry-run | --expect <plan_hash>]
                               Managed brains: host a new, empty source in a bare
                               repository under <path> (see below). Previews without --expect.
gbrain sources canonical <id> --to git|mixed [--dry-run | --apply --expect <hash>] [--json]
                               Managed brains: convert a source to git-canonical or back
                               to mixed. Previews without --apply; the apply prints progress
                               on stderr and, if stopped, where it stopped
                               (docs/designs/GIT_CANONICAL_MEMORY.md#conversion).
```

### Hosted repositories

`gbrain sources host-repo` gives a new, empty source its own bare repository
(`<path>/repo.git`) that people clone and fetch from, and checks it out once
as a linked worktree gbrain owns (`<path>/worktree`), claimed as the source's
canonical worktree like any other. The source becomes git-canonical
(`canonical: git`), so every page write, remote ones included, commits there
through the door before the database indexes it. A pre-receive hook refuses
every push into the repository; `--push-remote` names a repository of your own
that the push effect publishes to once Git durability is enabled
(`gbrain sources writer git-durability <id> --enable`).

It runs only from the trusted local CLI on the brain host. The preview says in
words that the source becomes strict and prints the apply command with its
`--expect <plan_hash>`; a plan that moved refuses `preview_changed`. It refuses
a source that is bound or already has pages (moving existing pages into a
hosted repository is conversion, a later wave), and a directory that is not
empty or sits inside a checkout or another source's directory. On a hosted
source the preview reports the hook and the worktree link, and the apply
reinstalls a missing or changed hook. An agent runs it on a production brain
only with the user's explicit yes, one source at a time.

### Read-only mirror sources

A source whose Git remote is the source of truth (a code or docs repository
you keep current from upstream) can be marked a read-only mirror:

```bash
gbrain sources mirror-readonly <id>
```

On a managed brain, sync then imports canonical metadata (a default title,
type, tags kept in the brain) into the database only and never writes a file
back into that checkout, so `git status` stays clean and the next fast-forward
pull succeeds. A page write into the source (`put_page`, a timeline entry, a
maintenance write) is stored database-only too; its receipt says
`storage: "database_only"` with `write_through.skipped: "mirror_read_only"`.
`gbrain sources list --json` shows `mirror_read_only` per source. Undo it with
`gbrain sources mirror-writable <id>`; files are written again from the next
write on, except for pages created while the source was a mirror: those have
no file in the checkout and stay database-only. Git effects of a mirror's
writes (for example a `forget`) complete as skipped. The flag is off by default.

A managed brain never pulls inside a cycle. Advance a managed checkout with
one command on its owner host:

```bash
gbrain sources refresh <id>
```

It refuses new writes to every source that shares the checkout until queued
ones finish, fast-forwards it with `git merge --ff-only`, then syncs each of
those sources without pulling. Sources bound to one checkout (for example
`notes/` and `docs/` of the same repository) are refreshed together, because a
merge rewrites files of all of them. `--dry-run` previews the incoming commit;
refusals are listed under
[worktree refresh refusals](write-refusals.md#worktree-refresh-refusals). A
brain that is not managed keeps pulling inside `gbrain sync --source <id>`.

The autopilot cycle syncs the checkout as it is and reports
`upstream_refresh: "skipped_managed"`; `gbrain doctor` (`sync_freshness`) says
"upstream unknown" when the checkout was not fetched in the last 24 hours. See
[`managed_pull_skipped`](write-refusals.md#managed_pull_skipped).

### Code sources: persist the sync strategy

Every sync of a source (`sync --all`, autopilot, the dream cycle, the MCP
`sync` op) uses the strategy stored on the source when the call names none.
Unset, that is `markdown`, which imports only Markdown and deletes the page of
a code file that changes. Record `code` (code only) or `auto` (Markdown and
code) once for a code repository:

```bash
gbrain sources set-strategy api code
gbrain sync --source api --full   # re-classify files unchanged since the last sync
```

`gbrain sources list --json` shows `strategy` per source (`null` when unset).
An explicit `gbrain sync --strategy` still wins for that run. A source with an
unfinished managed sync run refuses the change (`sync_run_unfinished`) until
the run finishes (`gbrain sync --source <id> --no-pull` resumes it) or is
retired ([managed sync orphans](repair.md#managed-sync-orphans)): that run's
frozen manifest was classified under the old strategy. Connector sources
(GitHub, Google) materialize Markdown and take no strategy.

## The git requirement for --path sources

Every `--path` source must be a git repository (or live inside one — a
subdirectory of a git repo works too) with at least one committed, tracked
file under that path. `gbrain sources add` validates this at registration
time and refuses a directory that doesn't qualify — no `.git` at all, a
`git init` with no commit yet, or a commit made before `git add` — with an
actionable error instead of silently registering a source that will fail
(or worse, "succeed" while importing nothing) on its first `gbrain sync`.
Fix it with:

```bash
git -C <path> init
git -C <path> add -A   # gbrain-allow-shared-tree-git: first commit of a brand-new repo nobody else writes yet
git -C <path> commit -m "initial import"
gbrain sources add <id> --path <path>
```

Two details that are easy to miss:

- **Files must actually be committed, not just present.** The sync walker
  reads files through git objects, so `git init` alone — even followed by an
  empty commit (`git commit --allow-empty`) — isn't enough. Registration
  checks for real tracked content (`git ls-tree HEAD` scoped to the path),
  not just a resolvable `HEAD`, so this footgun is caught immediately
  instead of surfacing later as a sync that imports nothing. For files that
  are deliberately untracked or `.gitignore`d but should still sync, use
  `gbrain sync --include-gitignored` — it forces a full filesystem walk so
  periodic syncs see ignored/untracked syncable content the git-object walk
  skips (`gbrain import <dir> --include-gitignored` is the one-shot import
  equivalent). Doctor's `multi_source_drift` advice names this case:
  a slug stuck at `default` whose file is untracked won't be recreated by a
  plain re-sync, so reach for the flag (or commit the file) before any
  delete step.
- **`--force` registers the source anyway**, skipping the check. Use this if
  you're registering a path before an automated pipeline gets around to
  `git init`-ing it. GBrain never auto-`git init`s a `--path` source for
  you — it's your directory, not a gbrain-managed clone (same consent
  boundary as sync-time self-heal, which also never mutates a `--path`
  source without an explicit ask).

**If sync ever reports a problem with the sync anchor** (`last_commit`) —
after a force-push, a history rewrite, or a from-scratch `git init` on a
directory that was synced before — you do not need to reset anything by
hand. `gbrain sync` detects an unreachable or non-ancestor anchor
automatically and recovers: either a full reimport (anchor object missing)
or a direct tree-to-tree diff against the orphaned bookmark (anchor present
but rewritten), advancing the anchor to the new HEAD when it completes.

## Sources in a Git subfolder

A `--path` source can point at a subfolder of a Git repository, for example
`gbrain sources add vault-notes --path ~/vault/notes` where `~/vault` holds
the `.git` directory. Such a source has two possible roots for its slugs and
stored file paths, called its **slug-root mode**:

| Mode | `~/vault/notes/people/alice-example.md` becomes | When it is chosen |
| --- | --- | --- |
| `source-root` | slug `people/alice-example`, stored path `people/alice-example.md` | The default for a new subfolder source: the same slugs a plain `gbrain import ~/vault/notes` would give. |
| `git-root` | slug `notes/people/alice-example`, stored path `notes/people/alice-example.md` | When you sync with `gbrain sync --repo ~/vault --src-subpath notes` (you named the Git root as the base), or when the source already has pages whose slugs carry the `notes/` prefix. |

The mode is decided once, by the first real sync or the first coordinated page
write (such as `put_page`) that records a new file path, and pinned in the
source's configuration. A few write paths, such as saved brainstorm
ideas, follow an existing pin but do not set one. Every later sync,
write and reader obeys the pin, so an existing brain never has its slugs
renamed. `gbrain sync --dry-run` works out the mode without pinning it. A
source at the root of its repository, or outside Git, has only one root and no
mode to choose.

**Say to your agent:** *"Add my ~/vault/notes folder as its own source and
keep its slugs relative to that folder."*

**Write-through.** When a write creates a page in a subfolder source,
gbrain writes `<source path>/<slug>.md` and records the stored path in the
source's mode. In `source-root` mode the next sync of that file finds the
same page instead of creating a twin. In `git-root` mode the recorded path
adds the subfolder prefix that the unprefixed slug lacks, so the next sync
can refuse that file with a slug/origin mismatch; there, add new pages as
files in the checkout and sync them. Pages that already have a stored path
keep writing to that file.

**Older stored paths.** Releases before v0.60.5.0 recorded Git-root-style
paths (`notes/people/alice-example.md`) for pages in `source-root` sources.
Sync accepts that form when the rest of the path names the same page, and
rewrites it on the next import. No command is needed.

**`ambiguous_source_path`.** If both readings of an old stored path exist as
files, for example `~/vault/notes/people/alice-example.md` and
`~/vault/notes/notes/people/alice-example.md`, sync refuses instead of
guessing. Rename or move one of the two files, commit, then run
`gbrain sync --source vault-notes --no-pull`. The other
refusal reasons are listed in [write refusal reasons](write-refusals.md).

## Citation format for agents

When agents receive multi-source results they MUST cite pages in
`[source-id:slug]` form. Example:

> You told me about the distillation protocol — see [wiki:topics/ai]
> and [gstack:plans/multi-repo] for where this came from.

The citation key is `sources.id` (immutable). Renaming a source via
`gbrain sources rename` changes the display name only; existing
citations keep working.

## Writing to a specific source

```bash
# Pass --source explicitly
gbrain put topics/ai ... --source wiki

# Or rely on the dotfile / env / CWD match
cd ~/.gstack && gbrain put plans/multi-repo ...
# → source auto-resolves to gstack
```

Reads span federated sources by default. Writes require a resolved
source (explicit, inferred, or default). The resolver never picks a
source silently when ambiguous — it errors with a clear fix.

Unscoped writes are also guarded against landing in the wrong place. On a
brain with at least one other source and more pages outside `default` than
in it, an unscoped
`gbrain sync` refuses (pass `--source <id>` to redirect it), `gbrain import`
warns, and MCP stdio prints a once-per-process advisory when a write actually
resolves to the default tier. `gbrain sync --dry-run` previews the run and
prints the same routing guidance instead of refusing;
`GBRAIN_ALLOW_DEFAULT_WRITE=1` is the escape hatch when `default` really is
the intended target. **Say to your agent:** *"Show me what a sync would do
without writing anything"* — your agent runs `gbrain sync --dry-run`.

## Durability: keep a brain repo in sync (auto-harden)

This hardening path applies to unmanaged worktrees. After activating managed
writers, Git effects belong to the persistence outbox; generated legacy push
helpers refuse to run rather than bypass that ownership boundary. See the
[concurrent-write guide](concurrent-writes.md). On a managed root the owner
commits and pushes page writes (`gbrain sources writer git-durability <source>
--enable`), files that are not pages are committed with plain git and ride the
owner's next push, the checkout is never pulled or rebased, and the durability
block below is regenerated in its managed form by that verb; see
[files that are not pages](../architecture/topologies.md#files-that-are-not-pages).

A long-lived agent that writes to a knowledge-wiki git repo needs three
things to never lose work: pull before it edits, push every write, and not
go stale while it sits idle. `gbrain sources harden` installs all of that,
idempotently. The moment you add a brain repo with a token, it runs
automatically:

```bash
# Clone + register a GitHub repo, then auto-harden it for durability.
# Use a fine-grained PAT scoped to just this repo.
gbrain sources add wiki --url https://github.com/you/brain-wiki.git --pat-file ~/.secrets/wiki-pat
#   → clones, then installs: local auto-push hook, scripts/brain-commit-push.sh,
#     always-on durability rules in AGENTS.md/RESOLVER.md, a 30-min pull cron,
#     and a repo-scoped credential. Verifies push works before declaring done.

# Run the same audit on an existing source any time (idempotent):
gbrain sources harden wiki --pat-file ~/.secrets/wiki-pat

# Pull on demand (the cron calls the --path form, which never opens the DB):
gbrain sources pull wiki

# Remove the durability scaffolding (also runs automatically on `sources remove`):
gbrain sources unharden wiki
```

What hardening guarantees:

- **Pull-first, safe in a shared checkout.** Nothing rebases or stashes the
  working tree. A pull fetches, then, under the checkout's writer lock,
  fast-forwards, or for a diverged branch merges the remote commits in memory
  into a merge commit (`gbrain: merge origin/<branch> into <branch>`) and
  fast-forwards to it. A real conflict changes nothing and is flagged for
  attention ([conflicts](shared-checkout-git.md#conflicts)). `gbrain sources
  pull`, which the unattended 30-minute cron runs, keeps its conservative
  rule: a checkout with any local edit is skipped (`skipped_dirty`), so it
  never moves files under a writer, and a checkout whose writer lock is busy
  is skipped until the next run. An explicit `scripts/brain-commit-push.sh --pull`
  (or `gbrain git commit-push --pull`) advances a dirty checkout unless a
  dirty file is one the pull must change; then it changes nothing and its
  notice names the files. `gbrain sources set-pull-strategy <id> <rebase|merge>`
  is still accepted and recorded, but both strategies now integrate by merge,
  because the shared tree is never rebased. A force-pushed upstream is never
  merged: `gbrain sync` reports `upstream_rewritten` and, after the user
  agrees, `gbrain sources reset-upstream <id> --expect-local <sha> --expect-upstream <sha>`
  moves the checkout to the new upstream and keeps the old history under a
  backup ref ([upstream rewritten](troubleshooting.md#upstream-rewritten)).
- **Push is never deferred.** `scripts/brain-commit-push.sh "<msg>" <path>`
  delegates to `gbrain git commit-push`: it takes the checkout's writer lock,
  commits only the named paths, merges a rejected push in memory, and refuses
  to report success without a push the remote accepted. Other agents'
  uncommitted files are never staged, stashed or touched. The post-commit
  hook is a best-effort background fallback (it only publishes, never pulls);
  the helper is the guarantee. Outcomes and what to do on each:
  [shared-checkout git](shared-checkout-git.md#outcomes).
- **One writer at a time per checkout.** Harden also sets
  `rebase.autoStash=false`, `merge.autoStash=false` and `pull.ff=only` in the
  checkout's local git config, so a stray `git pull` refuses instead of
  autostashing. Host daemons that commit the same checkout join through the
  [lock contract](shared-checkout-git.md#lock-contract).
- **No silent staleness.** A 30-minute background pull keeps an idle session
  current. It runs DB-free, so it never contends with a live brain for the
  PGLite single-writer lock.

Flags: `--no-cron` skips the scheduled pull, `--no-verify` skips the push
probe, `--dry-run` reports what would change, `--json` emits a machine
report, `--all` hardens every source with a remote (same-account only).
`--no-harden` on `sources add` opts out of auto-harden.

After upgrading GBrain, run `gbrain sources harden <source-id>` on each machine
with an already-hardened source to refresh its local hook and
`scripts/brain-commit-push.sh`. Upgrading the CLI alone does not update those
installed scripts. Existing repo-local credentials are reused; no new token
is required when that credential still works.

Security: the push automation is installed locally per machine (never
committed into the repo), the token is wired per-repo (an existing
credential helper is reused when present), and it never appears in the repo,
the remote URL, logs, or the JSON report. For a self-hosted git server
reachable only over a filesystem path, set `GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1`
(default is HTTPS-only).

## Upgrading an existing brain

`gbrain upgrade` runs the needed schema migrations automatically. Your
existing pages all live under `source_id='default'`. Behavior is
unchanged until you add a second source.

To add one:

```bash
gbrain sources add gstack --path ~/.gstack --federated
cd ~/.gstack && gbrain sources attach gstack && gbrain sync
```

Two commands. The existing default source is untouched.

## Related features that build on sources

- **Session transcript ingest** — `gbrain transcripts` (server-private:
  raw chat exports stay on the host machine).
- **Per-source retention** — `gbrain sources archive` / `archived` /
  `purge` (soft-delete with a TTL grace window).
- **One-shot remote bootstrap** — `gbrain sources add <id> --url <git-url>`
  (clone + register + auto-harden).
- **Access control across brains** — the *brain* axis (`gbrain mounts`);
  see `docs/architecture/brains-and-sources.md`.
