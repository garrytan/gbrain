# Enforced member mode

Set `GBRAIN_ENFORCED_MEMBER=<member>` in the environment of a gbrain process and
the CLI acts as that one member instead of as the brain owner. A group-chat turn
that runs `gbrain search` sees only what that member may read, its writes can't
touch a page the member can't read, and anything the mode doesn't know is refused.

It is meant for a launcher (a harness's wrapper or the cron wrapper in
[cron-schedule.md](cron-schedule.md#calling-gbrain-unattended)) that pins the
variable for every call it makes. The mode binds only a caller whose launcher
pins it: a process that unsets the variable, or a script that opens the database
directly, is outside it.

## What each command does

Every CLI command, and every subcommand of a command that mixes reads, writes
and admin, has one class. The list is code (`src/cli/enforced-member-classes.ts`),
and a test fails when a new command or operation has no class.

| Class | What happens |
|---|---|
| read | The command answers exactly as a stdio MCP server bound to the member would: page readers (`readable_by`), folder rules and `visibility: private` all apply, and other members' personal sources are out of scope. Stderr gets one constant line: `gbrain: results limited to what GBRAIN_ENFORCED_MEMBER=<member> may read`. It prints the same line whether or not anything was hidden. |
| write | A normal local write. It lands where and as visible as it would without the mode, after two checks: every target page (and its source) must be one the member reads, and the write must not change an access or privacy label (`visibility`, `readable_by`, the privacy aliases, a private fact or takes fence). |
| allowed | `sync`, `sources refresh <id>`, `git commit-push --pull`, `doctor` and the offline `errors` and `protocol`. The first three run as usual, but their output is replaced by one constant line (and the bare error code on failure), so imported or held paths never print. `sync` takes only `--source <id>`, `--no-pull`, `--no-embed`, `--json` and `--dry-run`, and `sources refresh` one source id with `--json` or `--dry-run`; any other flag (`--repo`, `--all`, `--full`, `--watch`, ...) or subcommand is refused, and so is a source the member can't read (another member's personal source, or one that isn't registered). `doctor` (plain or `--json`, no other flags) prints only each check's name and status and the count per status: no message, slug, path, title or source name. |
| silent | `hook` only. Nothing on stdout, the constant stderr line, exit 0. Harness hooks run inside group turns and must not fail them; this is the one deliberate exception to "anything not listed exits non-zero". |
| refused | Everything else: `--as`, `call`, `serve`, `config`, `auth`, `access`, `upgrade`, `autopilot`, `repair`, `delete`, `jobs`, `reindex`, `embed`, `dream`, `doctor` with any flag, `status`, `write-requests`, every status command that names held paths (`sync status`, `sources status`, `sources writer status`), raw SQL and anything that prints a credential. |

Reads: `search`, `query`, `search --exact`, `list`, `find`, `get`,
`backlinks`, `timeline`, `links`, `tags`, `history`, `stats --by` (the plain
brain-wide counters are refused), `whoami`, `entity`, `whois`, `graph` and
`recall` (its entity, `--since`, `--question`, `--grep` and `--query` arms;
`--since-last-run` is refused because it moves the owner's cursor). A
`--source <id>` narrows a read the way a remote credential's source does;
another member's personal source and an unregistered one refuse alike.
`entity` leaves out the mention coverage count, which counts every page.

Help prints only for a command the mode allows, and only the static help text:
`--help` on a refused command (`creds list --help`) is refused like the
command, and no command's handler runs for a help request.

Writes: `put`, `link`, `unlink`, `tag`, `untag`, `timeline-add`, `remember`
and `git commit-push` with named paths (`edit_page` and `append_page` are
classified writes with no CLI name). `timeline-add` refuses a gbrain fence
marker (`<!--- gbrain:...`) in its summary, detail or source. `remember`
saves one fact only with `--entity` naming the exact slug of a page the member
reads; nothing is inferred, and `--replaces` is refused. Without it, the refusal's first line says so and
that nothing was saved, and its next line is the retry shape:

```
gbrain: refused under GBRAIN_ENFORCED_MEMBER=alice-example: remember saves a fact only with --entity <slug of a page you can read>; nothing was saved [GBRAIN_ENFORCED_REFUSED]
Retry: gbrain remember "<one fact>" --entity <exact slug of a page you can read, from gbrain find or gbrain search> --provenance "<where you learned it>"
```

`gbrain write-request <id>` reads the receipt of a write this mode accepted
for the member (it records those request ids in `~/.gbrain/enforced-member/`
on the machine that ran the write). Any other id answers exactly as an unknown
one. `git commit-push` refuses a named
file the member can't read, an access policy file (`.gbrain/`) and any label
change against HEAD; `--pending`, `--push-only` and `--resolve` are refused.

<a id="writes-off"></a>
## Turn member writes off

A brain owner who wants member CLIs to read and not write sets one key in the
brain's config, from a direct session (one without `GBRAIN_ENFORCED_MEMBER`):

```
gbrain config set access.enforced_member_writes refuse
```

| Value | Page writes | `git commit-push` with named paths |
|---|---|---|
| `checked` (default, or no value) | checked as described above | checked as described above |
| `refuse_pages` | refused | checked as described above |
| `refuse` (and any other value) | refused | refused |

Page writes are `put` (a new slug, a page the member reads and a page it can't
read alike), `link`, `unlink`, `tag`, `untag`, `timeline-add`, `remember`, and
`edit_page` and `append_page`. Use `refuse_pages` when a host's member turns
still commit files on purpose. The refusal comes before any page, path or
source lookup, so it reads the same for every target and names none:

```
gbrain: refused under GBRAIN_ENFORCED_MEMBER=alice-example: writes are off for members on this brain; nothing was saved [GBRAIN_ENFORCED_REFUSED]
Why: This brain turned off member writes under this mode: its config access.enforced_member_writes is refuse (or a value other than checked and refuse_pages), or could not be read.
Fix: ask the brain owner to save it in a direct session (one without GBRAIN_ENFORCED_MEMBER).
Recovery: nothing was saved; the same call refuses every time, so do not retry here.
Docs: docs/guides/enforced-member.md#refused
```

Under `refuse_pages` the Why line reads: `This brain turned off member page
writes under this mode: its config access.enforced_member_writes is
refuse_pages.`

- The key lives in the brain's database, so it works on a brain with no
  repository and no environment variable overrides it. `config` is refused
  under the mode, so a member can't change it.
- Any value other than `checked` and `refuse_pages`, or a config read that
  fails, counts as `refuse` (fail closed).
  `gbrain config set access.enforced_member_writes checked` turns writes back on.
- Reads are never affected, and neither is a CLI without
  `GBRAIN_ENFORCED_MEMBER`.
- Under every value, `git commit-push --pull`, `git commit-push --dry-run`,
  `sync`, `sources refresh` and `write-request` keep their behaviour: they
  bring in or read what is already committed.

<a id="refused"></a>
## Refused

A refusal exits 3 and writes this to stderr, with no secret values:

```
gbrain: refused under GBRAIN_ENFORCED_MEMBER=alice-example: config [GBRAIN_ENFORCED_REFUSED]
Why: This command is not on the enforced member allow-list.
Fix: ask the brain owner to run this in a direct session (one without GBRAIN_ENFORCED_MEMBER).
Recovery: do not retry here; nothing was changed.
Docs: docs/guides/enforced-member.md#refused
```

With `--json`, stdout carries the `enforced_member_refused` envelope. An agent
should stop and tell the user, not retry: the same call refuses every time. The
variable set but empty, naming no enabled member, or naming the brain owner
(`gbrain access owner set`) refuses every command except `errors`,
`protocol` and the static help of a command the mode allows. It never falls back to the owner.

## Limits

- **PGLite with a running `gbrain serve`.** The mode never hands a call to a
  live serve (the serve answers as the owner), so it opens the brain itself. A
  PGLite brain allows one process at a time, so on a PGLite brain with a running
  `gbrain serve`, every enforced-mode read (and write) fails closed with the
  lock error. Postgres brains are not affected.
- **A thin client** (a remote MCP config) reads as its own credential, so it
  refuses every command under the mode.
- **Create versus refuse.** A write to a page the member can't read is refused,
  while a write to a slug no page has yet creates it, so a writer can tell those
  two apart. The refusal never says the page exists.
- **Auto-links.** A `put` whose text links to a slug links it only when a page
  with that slug exists, and its `auto_links` counts say which happened, so a
  writer can tell whether a slug it can't read exists (the same shape as
  create versus refuse).
- **The warm CLI socket** is skipped under the mode.
- **Receipts are per machine.** `write-request` answers only receipts recorded
  on the machine that ran the write; on another machine they answer as unknown.
- **doctor statuses are brain-wide.** A check's status counts pages the member
  can't read, so a status can change because of one. Names, statuses and counts
  are all it prints.
