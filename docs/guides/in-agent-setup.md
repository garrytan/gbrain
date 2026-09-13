# Install GBrain inside a personal agent

Give the agent one durable GBrain folder and one absolute command to use in
every conversation. The setup helper installs a private Bun runtime, creates a
local PGLite brain, and writes a small memory skill. You can start remembering
facts without a model API key, a server, or a new agent identity.

Start with the instructions for your app:

- [Grok Bot](grok-bot.md): use its shared `/workspace` directory.
- [Muse](muse.md): first establish which user-files directory survives runtime
  replacement; its public documentation does not name that path.
- [An existing hosted brain](hosted-harness-access.md): connect to that brain
  instead of creating another local database.

## 1. Choose the durable folder

The root must be an absolute path with an existing parent, for example
`/workspace/gbrain`. It must be empty or absent for a new installation. Do not
use a temporary directory, a checkout that another task might delete, or a
symlink. The same root must be available to later conversations and routines.

Setup creates this layout:

| Path beneath the chosen root | Purpose |
| --- | --- |
| `bin/gbrain` | Stable command; always selects this brain and its source |
| `bin/gbrain-setup` | Repair the recorded runtime, or explicitly upgrade it |
| `.gbrain/config.json` | Local configuration |
| `.gbrain/brain.pglite` | Complete database, including facts saved only in the database |
| `.gbrain/agent-install/receipt.json` | Ownership, pinned package/runtime versions, schema, and capability evidence |
| `memory/` | Managed source files |
| `instructions/gbrain-skill.md` | Memory instructions to attach using the app's native skill mechanism |
| `instructions/maintenance.md` | Optional maintenance routine with a stable identifier |
| `runtime/` | Replaceable private runtime and package versions |

`GBRAIN_HOME` is the chosen root; GBrain places its state in the `.gbrain`
directory underneath it. Use the generated launcher even if another `gbrain`
is on `PATH`. It selects the root explicitly, changes to that directory, and
removes inherited database, brain, source, and provider overrides. Put later
provider configuration in this installation's config or private `.gbrain/.env`,
not another project's environment.

## 2. Run the shipped setup helper

Run these commands **inside the agent's computer**. For Grok Bot:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/garrytan/gbrain/latest-stable/scripts/setup-in-agent.sh \
  --output /tmp/gbrain-setup.sh
bash /tmp/gbrain-setup.sh --root /workspace/gbrain --harness grok-bot
```

For Muse, use `--harness muse` and the absolute durable root established in
[its guide](muse.md). The helper needs Bash, `curl`, `git`, `unzip`, and outbound
access to GitHub and package downloads. It does not install system packages or
require root. If the platform blocks a download, use its normal permission flow.

The helper verifies the pinned Bun release checksum and records the exact
GBrain commit it installs. Package installation runs with lifecycle scripts
disabled. Initialization uses `--pglite --no-embedding`: keyless fact writes,
entity recall, and text filtering are available; semantic embedding and paid
extraction require separate configuration.

**Relay the search-mode matrix printed by initialization and confirm the
operator's choice**, as described in [the install protocol](../../INSTALL_FOR_AGENTS.md).
Automatic capture and paid maintenance remain separate choices. A local
database does not automatically capture conversations, grant connector access,
or install a native skill.

For an existing compatible local brain, review its root and config before
adding `--adopt`. Adoption preserves the database and configuration; existing
source trees remain external to the installer. `--adopt` does not convert a
hosted client or repair an unreadable database by replacing it.

## 3. Prove the first memory round trip

Use a harmless randomized value so the answer cannot come from the model's
general knowledge. Have the agent substitute a new random suffix and the
current date:

```bash
/workspace/gbrain/bin/gbrain remember \
  "My setup test phrase is amber-orbit-REPLACE-WITH-RANDOM-SUFFIX" \
  --entity projects/gbrain-setup --provenance "explicit setup test, YYYY-MM-DD" --json
/workspace/gbrain/bin/gbrain recall projects/gbrain-setup --json
```

Replace `/workspace/gbrain` throughout this guide if your root differs. Keep
the returned fact ID. The write must return a successful status, and a separate
recall process must return the exact phrase with its attribution.

Now attach `instructions/gbrain-skill.md` through the app's native saved-skill
or standing-instruction mechanism. Open a **new conversation**, ask for the
test phrase without repeating it, and inspect the actual command result. The
agent must invoke the same absolute launcher. Its own built-in memory is not
evidence that it used GBrain.

Finally, ask the agent to correct the test phrase. It should recall the old
fact, retire the old ID, save the replacement with provenance, and verify that
ordinary recall returns the current fact. To remove the test:

```bash
/workspace/gbrain/bin/gbrain forget FACT_ID --reason "setup test complete"
/workspace/gbrain/bin/gbrain recall projects/gbrain-setup --json
```

Use the numeric ID returned by this installation's CLI. Forgetting retires a
fact from active recall; history and earlier backups can still contain it.

The installer records `native_runtime: unverified` deliberately. A successful
database probe establishes local operation; enabling the native skill and
testing a fresh conversation establishes app behavior. Record those results
separately, including the date and app version when visible.

## 4. Make memory useful

The generated skill is intentionally small: recall relevant context before
personal or continuing-work questions; save requested durable facts with a
source and date; preserve uncertainty; correct stale facts; verify the result.
Keep personal edits in a separate native instruction or separate file so
repair can maintain the generated file without replacing your work.

Three useful first workflows:

1. **Preferences:** “Remember that I want meeting briefs in three bullets, with
   the decision first.” In a new conversation, request a meeting brief and
   check that the agent recalled the preference.
2. **Decisions:** “Remember that project-example chose option B today, because
   it meets our offline requirement. Mark this as our decision, not a general
   recommendation.” Ask for the decision and rationale next week.
3. **Connected services:** “Use your existing calendar/email connector to
   prepare this meeting, then save only the decisions and commitments I ask
   you to retain, with source links.” The harness keeps using its own service
   connection. GBrain stores the selected memory; it does not need a second
   copy of the service credentials or the entire inbox.

Capture and bulk imports are opt-in. To import chosen files or exported chats,
follow [chat connectors and imports](chat-connectors.md). Neither this helper
nor the product guides claim automatic transcript interception or hooks.

## 5. Maintenance and concurrent agents

Use finite CLI commands. PGLite allows one process to hold the database at a
time; another command waits and can return `pglite_busy` when the wait expires.
Let the first command finish, then retry. Do not remove a live lock. Avoid
launching parallel memory commands against the same root, and keep longer
maintenance work out of interactive recall periods.

After the round trip succeeds, the user can choose a native schedule. Attach
`instructions/maintenance.md` to **one** routine, using the identifier in the
receipt. Start with `doctor --fast --json` and report its result. Missing
embedding credentials on a keyless installation are a configuration choice;
do not invent keys or start paid maintenance to improve a score.

The helper creates no daemon, `serve` process, cron entry, or native routine.
Native scheduling availability must be checked in the actual app. Reuse the
same routine on repair instead of creating duplicates. If serialized local
commands become a bottleneck, [move to a hosted brain](hosted-harness-access.md)
with a server database suitable for concurrent clients.

## 6. Back up the complete local database

Choose a private backup directory outside `memory/` and `instructions/`, and
pause other memory and file writers for the snapshot:

```bash
mkdir -p /workspace/gbrain-backups
chmod 700 /workspace/gbrain-backups
/workspace/gbrain/bin/gbrain backup create \
  --output /workspace/gbrain-backups/brain-YYYYMMDD-HHMM.gbrain-backup --json
```

Each output filename must be new. The command holds the real PGLite writer
lock, takes a full database dump, checks the managed file inventory for changes,
and publishes a checksummed archive with mode `0600`. A busy database or a
changing file fails the operation instead of publishing a success receipt.

| Included | Excluded or inventoried for reconnection |
| --- | --- |
| Full PGLite database: pages, DB-only facts, jobs, settings, authentication state, and other tables | Runtime packages, Bun, caches, Git metadata, previous backups |
| Files under the receipt's managed data paths, subject to the exclusions below; fresh setup uses `memory/` and `instructions/` | External source directories and remote object storage contents |
| Config with recognized credential fields removed, source/path inventory, and install metadata | Known standalone credential files such as `credentials.json`, `auth.json`, `token.txt`, and `.env*`; `.gbrain/credential-deliveries`; known cache, browser-profile, and backup directories |
| File hashes, package/schema versions, and explicit omitted-item inventory | Native app accounts, installed skills, routines, and platform state |

**The archive contains sensitive full database state and may contain secrets.**
Excluded managed paths are listed in the inventory. Ordinary memory documents,
including files named `credentials.md`, are preserved; arbitrary files can
contain secrets regardless of their names. Config redaction and filename
exclusions do not make the raw database or archive secret-free. The format is
checksummed, not encrypted. A same-computer copy does not protect against losing
that computer. Choose a protected off-VM destination explicitly, apply its
encryption and access controls, and verify that the copied archive can restore.
Do not upload an archive to a public issue or chat.

This recovery format currently accepts managed `.gbrain/brain.pglite` databases,
PostgreSQL 17 PGLite clusters, and at most 8 GiB of payload. `backup status` and
`backup check` report file coverage; neither creates this snapshot. Markdown
exports alone cannot recover facts that exist only in the database.

## 7. Restore into a new root

Use an available GBrain runtime and a destination that **does not exist**:

```bash
/workspace/gbrain/bin/gbrain backup restore \
  /workspace/gbrain-backups/brain-YYYYMMDD-HHMM.gbrain-backup \
  --into /workspace/gbrain-restored --json
```

Restore verifies the archive before publishing usable state. It rebases managed
source, page, and known config paths; detaches external source/config paths; and
cancels every unfinished background job in one transaction, preserving its
previous status for inspection. Completed history remains. No worker, connector,
sync, native routine, or paid operation starts.

External checkout and API sources keep their remembered pages available, but
their live connector configuration is quarantined and sync is disabled. The
prior configuration is retained in the private `.gbrain/restore-detached.json`
inventory and an inert database record. Google token commands, GitHub
materializers, and remote clone settings cannot reactivate merely because
someone runs `sync --source ... --repo ...`. Chat connector auto-sync is switched
off, remote storage is detached, and an `autopilot-paused` marker holds the
daemon until an operator explicitly resumes it. Keep that pause when using
the recommended finite CLI commands and native harness routines.

A successful `restore-receipt.json` says `state: ready`, `launcher_ready: false`,
and `setup_required: true`. Reinstall the runtime at the new root:

```bash
bash /tmp/gbrain-setup.sh --root /workspace/gbrain-restored --harness grok-bot
```

Fetch the helper again if `/tmp/gbrain-setup.sh` is gone. For a backup from the
managed setup, **do not add `--adopt`**: restore writes the ownership receipt
that repair needs. For a backup of a pre-existing unmanaged local brain, review
the restored config and use `--adopt`. For Muse, retain `--harness muse`.

Read the reconnect inventory, restore excluded credentials using the platform's
secure entry mechanism, and explicitly reattach external sources. Re-run the
randomized memory test against the new launcher before updating the native
skill. Review quarantined jobs before explicitly resubmitting any. The original
brain stays intact; use one chosen root for subsequent writes.

Review quarantined source settings before applying any of them: they may name
old paths, accounts, or executable credential commands. Recreate a connector
with its normal setup flow under a new source ID if you do not need to retain
its sync identity; the previous source's pages remain queryable. Reusing an
existing source ID requires a deliberate configuration repair from that
inventory, followed by a small explicit sync. Restoring credentials or changing
a source path alone does not restore quarantined connector settings or enable
its schedule. Treat the private inventory as sensitive, like the full backup.

If restoration fails or is interrupted, keep that destination for inspection
and retry into another absent root. An incomplete restore receipt blocks setup.
Do not rename partial database directories into an active installation.

## Repair, upgrade, and remove

After runtime replacement, repair with the retained shell helper:

```bash
bash /workspace/gbrain/bin/gbrain-setup
```

If that file is missing, download the shipped helper again and pass the original
`--root` and `--harness`. Ordinary repair reinstalls the recorded commit and Bun
version; it preserves facts, configuration, source choice, and native routine
identifiers. It refuses to replace edited generated files, malformed config,
or a previously initialized database that has disappeared.

Choose upgrades explicitly, after a verified backup:

```bash
bash /workspace/gbrain/bin/gbrain-setup --upgrade
```

Upgrade installs the currently stable package and applies its migrations.
Repair is not an upgrade, and neither operation resets the brain.

To stop using GBrain, pause its native routine and disable its saved skill.
Keep the root and a protected backup until you deliberately choose to remove
the data. No daemon or system-level installation needs uninstalling. If using
hosted access, also revoke that installation's grant on the host.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Setup reports unowned state | Choose an empty root; use `--adopt` only after reviewing a compatible existing local brain |
| Runtime executable disappeared | Run the retained helper or fetch it again with the same root |
| Config is malformed or initialized memory is missing | Preserve the root; recover config or restore a full backup into a new root |
| Generated instructions were edited | Preserve your edited file under a different name, then rerun repair and reattach your additions separately |
| `pglite_busy` | Wait for the active command to finish and retry; stop a long-lived server through its owning process before using finite CLI mode |
| Fresh conversation cannot recall the test | Inspect the native skill attachment and exact launcher invocation, then run explicit entity recall |
| Backup says files changed | Pause the writer and create a new snapshot; do not treat the failed output as a backup |
| Restore target already exists | Choose another absent root; restore never overwrites existing state |
| A package or host URL is blocked | Complete the app's normal approval flow; preserve the error if access is denied |

## What has been verified

Repository tests exercise real local initialization, separate installed CLI
processes, environment isolation, runtime repair, ownership guards, archive
integrity, path rebasing, and unfinished-job quarantine in temporary roots.
They do not establish persistence across an actual Grok Bot or Muse computer
replacement, native skill selection, scheduling, or their network/credential
policies. Those remain app-level acceptance checks in the product guides.

[Validation evidence and actual-harness acceptance](harness-validation.md).
