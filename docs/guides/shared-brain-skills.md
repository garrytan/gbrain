# How to share skills through your brain

A brain's content source can hold both knowledge and canonical skills. Connected
agents read the same authorized revisions instead of maintaining independent
copies. The original parent agent follows the same catalog as its children;
being the parent does not make its local copy authoritative.

Following skills is not permission to execute scripts, add tools, access more
files, install packages, spend money, capture conversations, or replace an
agent's identity. Those permissions remain separate.

## Where the content lives

For a fresh local brain, `gbrain init` creates the default source under
`configDir()/content/<persistent-brain-id>/default`. Normally this is
`~/.gbrain/content/<persistent-brain-id>/default`. **`GBRAIN_HOME` is the parent
of the config directory**, not the config directory itself: setting it to
`/absolute/brain-home` puts content under
`/absolute/brain-home/.gbrain/content/<persistent-brain-id>/default`.

```text
content-root/
  skillpack.json
  skills/
    brain-router/SKILL.md
    memory-recall/SKILL.md
    memory-care/SKILL.md
  people/, topics/, ...       your existing knowledge layout
```

The release-pinned `gbrain-memory` pack contains those three self-contained,
prose-only skills, with provenance and licensing. It needs no development
checkout or helper scripts. The upstream GBrain application repository is not
your content repository.

Fresh owned-root setup also approves following this packaged prose and its
existing memory/discovery tool requirements when publication is enabled and no
source policy already exists. It does not add scripts, editor grants, spending,
or capture. Existing brains, adopted roots, explicit publication opt-outs, and
existing source policies are not silently opted into this fresh-setup policy.

An existing registered source root wins. Isolated in-agent setup keeps its
recorded `<installation-root>/memory` root. Thin clients do not create a second
host repository. New local setup accepts `--content-root /absolute/new-root`,
`--db-only`, or `--git` for explicit Git initialization in a newly owned empty
directory. DB-only mode cannot detach an existing canonical root. No GitHub
repository, commit, push, or off-host backup is implicit. Check the setup
receipt's `root`, `repository_kind`, `stage`, and `pending_actions`; a
`content_directory` is not a Git repository, and `backup: not_verified` is not
a protected backup.

Doctor treats upstream-sync freshness as not applicable only for an owned content
directory or explicitly initialized Git root whose completed, ready setup receipt
matches the current brain, source incarnation, registered root, and active
canonical-owner binding.
The source must have no Git sync commit, external repository, connector, or
company-ingestion policy. Existing external roots and incomplete or mismatched
receipts retain the ordinary never-synced/stale checks; managed persistence alone
does not exempt a source. No `last_sync_at` timestamp is fabricated. The separate
`canonical_content_writes` check reports queued publication and required recovery
for these roots. Both checks classify ownership from database records; remote
doctor does not inspect or execute commands against stored filesystem paths.

## Discover the authorized catalog

Use `list_skills` with `{"schema_version":2}` over MCP, or:

```bash
gbrain skills --schema-version 2 --json
```

The result contains compact descriptions and triggers, qualified identities,
immutable revisions, policy epochs, requirements, usability, and an opaque
authorized-view token. Follow `next_cursor` until absent. The default page size
is 50; the maximum is 100. Fetch only the relevant `get_skill` with
`schema_version: 2`, the returned `qualified_id`, and `revision`. Fetch declared
dependencies through `get_skill_asset` using that same identity and revision.
Do not turn a returned file into an execution permission.

When supplying separate identity fields instead of `qualified_id`, pass the
returned brain ID as `expected_brain_id` (`--expected-brain-id` on the CLI).
This asserts the already-connected brain; it never routes to another database.
The catalog and receipt field remains `brain_id`. Shared-skill tools expose no
caller-controlled `brain` or `brain_id` routing parameter.

A qualified identity contains the persistent brain ID, source ID, source
incarnation, pack ID, and skill name. Copy the returned identity rather than
constructing it or choosing a same-named skill from a different source.

Omitting `schema_version` preserves the legacy response shape. Once shared
publication is active, legacy `list_skills`, `get_skill`, and
`list_brain_skillpack` read the source-scoped sealed catalog too; ambiguous
unqualified names require a qualified selection. Before activation, the legacy
host-directory/resident-pack paths remain. A legacy `installed` field is not
evidence that the calling harness installed or used a skill.

Resource clients can read **`gbrain://skills`** for catalog and revision-bound
body/manifest/asset links. Resources use the same operation, source, surface,
publication, and grant checks as tools. This is GBrain's resource binding, not
a claim of conformance to a draft Skills-over-MCP extension.

The **starter** surface includes shared-skill discovery and membership tools,
subject to authorization. The **verbs** surface remains exactly the seven
memory verbs and does not provide shared skills. Choosing full surface does
not add authority. A client can read an authorized catalog without joining.

## Approve publication, following, and editing separately

| Permission | What it permits | What it does not permit |
| --- | --- | --- |
| `read` plus discovery operation access | Read published content in permitted sources | Enrollment or editing |
| `skills_member_self` plus `read` and membership operation access | Join, sync, acknowledge delivery, and leave this principal's membership | Memory writes, editing, or another principal's membership |
| `skill_editor` plus `write` and explicit `put_skill`/`delete_skill` operation access | Publish permitted skill revisions within source and slug fences | Widening the disclosure or follow policy |
| `skill_publisher` plus `admin` and explicit policy operation access | Inspect policy with `get_skill_policy`; approve classes, audiences, requirements, and following with `set_skill_policy` | Automatic execution or implicit editor authority |

These named scopes are explicit capabilities, not consequences of `admin` or
ordinary memory-write access. Standard profiles do not add editor or publisher
authority, including `operator` and `full`.

`mcp.publish_skills` remains the outer remote-publication gate. Migration keeps
an explicit false disabled, maps true to previously approved SKILL.md prose
only, and leaves unknown consent pending. References, assets, and scripts need
separate owner approval; even their metadata is not an implicit disclosure.
Private skills stay excluded from remote publication.

Beyond the fresh-setup default, the owner approves a versioned policy through
`set_skill_policy`, not through an editor's content update. For example, the
following **MCP arguments** approve only prose and the tools used by the default
memory pack for existing readers:

```json
{
  "source_id": "default",
  "expected_policy_epoch": null,
  "policy": {
    "version": 1,
    "enabled": true,
    "classes": ["prose"],
    "audiences": ["readers"],
    "requirements": ["tool:list_skills", "tool:get_skill", "tool:recall", "tool:remember", "tool:forget"],
    "allow_follow": true
  }
}
```

Use null only for the initial policy; supply the reviewed current epoch for
an update. Inspect the actual pack's requirements before approving. The outer
publication gate must also be enabled by the owner. Existing-brain migration
and granting client follow access do not approve a source policy; fresh setup's
limited packaged policy is not permission to expand disclosure later.

Use `get_skill_policy` with publisher authority to inspect the current policy
and CAS epoch, including when sharing is disabled. The trusted host can call
these operations through `gbrain call`; a remote memory grant cannot self-approve.

## Connect each installation

Follow [hosted access](hosted-harness-access.md) to provision on the host and
install the private handoff inside the intended harness. New `gbrain mcp grant`
connections default to `--skills follow`; `--skills memory-only` opts out of
membership, not necessarily catalog reads. Existing grants are unchanged when
the follow choice is omitted. Reapplying a profile preserves previously
approved membership unless explicit custom scope/operation lists replace it;
it does not enroll an old memory-only client. `--skills memory-only` explicitly
withdraws follow authority. A profile update is not an implicit skill-editor
regrant.

Use a separate principal and private handoff for every independent installation,
including the original parent. Sharing credentials creates one security
principal, not independently verified children. Installation IDs come from the
server; a client display name is not an identity credential.

For an existing client, preview only the follow change without resetting its
profile, finite spending cap, or write fences:

```bash
gbrain mcp grant agent-example --client CLIENT_ID --if-version REVISION \
  --harness codex --skills follow --url https://brain.example.com/mcp \
  --dry-run --json
```

Review the before/after grant, then repeat without `--dry-run`. Use the host's
`--admin-token-file` when administering a running PGLite owner. Added scopes
require a newly issued token; refresh cannot widen the old token's ceiling.
Recover the current private handoff with `mcp grant --resume` as described in
the hosted guide, then repeat `connect ... --install` inside that installation.

For a **dedicated editor**, the trusted host's advanced grant parser accepts
the named scope and explicit operation snapshot:

```bash
gbrain auth rescope-client EDITOR_CLIENT_ID --if-version REVISION \
  --scopes read,write,skill_editor \
  --allowed-operations list_skills,get_skill,get_skill_asset,put_skill,delete_skill \
  --dry-run --json
```

This example replaces the scope and operation lists; it is not an append.
Review the existing source and slug fences and include every permission you
intend to retain before applying. Run local auth administration only with
safe database access, never as a second PGLite writer. An editor needs neither
`skill_publisher` nor enrollment just to publish. A publishing principal needs
its own reviewed `admin,skill_publisher` and policy-operation permissions;
do not silently turn a memory client into that principal.

The [generated adapter reference](harness-adapters.md) lists all 13 registry IDs;
`gbrain mcp adapters` returns their current metadata. Do not infer native skill
support from a name or supported transport.

- Claude Code, Codex, and opencode managed connections install an owned,
  namespaced native router. Successful file installation reports
  `restart_required` and `native: unverified`. Start a new conversation and
  verify actual use.
- Thin CLI and manual clients have visible pending native-registration steps.
  A downloaded router or connected MCP server is not native activation.
- The router asks the agent to check `sync_brain_skills` before selection. That
  prose is advisory. Only callers routed through the adapter's enforced `admit` seam
  get its current-view check and pinned revision. No universal per-invocation,
  offline, or stale-cache guarantee applies to arbitrary vendor sessions.

A newer client connected to an older server reports shared skills unsupported
or pending; it does not synthesize a catalog or treat memory access as enrollment.
Keep using independently authorized memory while upgrading the host/adapter.

`join_brain` records an approved follow policy; `sync_brain_skills` returns a
complete authorized view and accepts an acknowledgment of an issued batch. Acknowledged
installation is a client report, not proof of native use. Policy, source, or
requirement changes can require renewed approval. A server write receipt proves
canonical commitment, not delivery to all members.

`sync_brain_skills` is the membership operation. It is distinct from the existing
local-only administrative `sync_brain` content-sync operation.

### Existing in-agent installations and legacy bridges

Isolated Grok Bot/Muse local setup uses the recorded installation's private CLI
registration and absolute launcher, not a credential from another brain. Fresh
non-adopted setup defaults to following; existing/adopted roots need an explicit
choice. After upgrading the recorded setup helper, approve with
`bash /absolute/installation/bin/gbrain-setup --skills follow --json`, or choose
`--skills memory-only` to stop local following. It writes the owned router and
includes it in `instructions/gbrain-skill.md`; native saved-skill loading stays
manual with `pending` / `native_registration_required`. Inspect the setup
result's `shared_skills` and the installation's receipts, not `connect --status`
for a different connection. The local installation is still not an isolation
boundary between agents sharing its files or credentials.

Legacy `skillpack scaffold --harness` full/stub paths do not copy bundled skill
bodies over an active shared brain. They return a pending migration plan,
inventorying known bridge-ledger files as unchanged, modified, or missing when
the destination is known. An unavailable brain is not permission to fall back
to stale bundled copies. Review and explicitly remove unchanged bridge-owned
copies through the existing harness/destination removal flow before enrolling;
modified or unowned copies require conflict resolution. No legacy body or
native shadow copy is automatically deleted or converted by this plan.

After resolving that inventory, a local bridge can approve following with
`gbrain skillpack scaffold --harness codex --dest /absolute/native/skills --skills follow`.
Use the actual supported harness and native destination, and `--skills memory-only`
on that same target for cleanup. The bridge reserves one source/destination per
verified local CLI principal and harness. Reuse that target for repair or rejoin;
leaving does not release its binding. Independent installations need separate
private-handoff principals, not another destination using the same credential.

Conflicting legacy targets can remove unchanged owned local files, but shared
server leave is withheld so another target's enrollment is not disabled. The
receipt records pending remote cleanup. Edited or unverifiable native files need
manual resolution; neither cleanup nor a successful router write proves that a
running harness unloaded or used those instructions.

## Update a shared skill

An authorized editor calls `put_skill` with a unique `request_id`, the current
`expected_revision` (JSON null for creation), source/incarnation, pack/name,
and the **complete** declared file set. `delete_skill` uses the same identity,
request ID, and revision check to publish a tombstone. Inspect the durable
write result: queued or accepted is not committed. Retry a lost response with
the same request ID and identical intent; changed intent needs a new ID.

The publisher validates policy and file hashes, publishes the canonical bundle,
and seals its catalog projection. A race returns a conflict instead of
last-write-wins. Generic memory writes, raw uploads, and skillpack file-copy
commands are not a shortcut around skill publication. Do not resolve a conflict
by overwriting the canonical directory or an edited parent copy.

After commitment, refresh the second client **and the parent**, compare the
qualified revision, and test new-conversation routing. Ordinary revisions
within the approved policy can follow without individual installation consent;
new permissions, file classes, or requirements cannot.

### Optimize without bypassing publication

Opt-in `run_skillopt` calls can select `shared_skill: true` with the catalog's
`source_id`, `source_incarnation`, `pack_id`, `expected_revision`, the skill's
`skill_name`, and a unique stable `request_id`. The existing benchmark, provider,
budget, and evaluation requirements still apply; connecting or following does
not authorize paid optimization. Remote callers additionally need the existing
administrator/skill allowlist approval, catalog-read authority, and explicit
`skill_editor` and `put_skill` permission.

For remote calls, both benchmark and held-out inputs must be approved assets of
that exact selected skill revision, readable through the caller's current
`get_skill_asset` grant. Their sealed bytes are used for evaluation; a neighboring
skill's file, an unpublished local file, or a changed live file cannot substitute
for the approved input. Trusted-local callers may supply explicitly chosen,
bounded external evaluation files.

The active canonical owner stages the approved closure under private
`skillopt-proposals/<proposal_id>`, not inside the content root. Only an accepted,
lint-valid body change is eligible for publication; frontmatter and supporting
files stay unchanged. Publication rechecks current authority and the original
revision. Revocation, conflicts, and invalid candidates retain the private
proposal without overwriting canonical bytes. A submitted request UUID refuses
another optimization run before spending; inspect `get_write_request` rather
than blindly retrying. Shared optimization does not support legacy resume,
write-capture, or evaluation-ablation options.

### Publish reviewed filesystem edits

Human/Git edits to canonical files are proposals, not live catalog revisions.
The trusted host can publish a reviewed proposal through the same coordinator:

```bash
gbrain call --source default import_skill_proposal \
  "$(cat /absolute/private/reviewed-skill-proposal.json)"
```

Prepare that private JSON file from the reviewed current skill identity,
`expected_revision`, unique `request_id`, and complete `files` input used by
`put_skill`. Add `expected_hashes` containing the current SHA-256 of **every
affected on-disk file and `skillpack.json`**; JSON null denotes an absent file.
Review actual bytes before recording hashes. This local-only operation refuses
changed hashes or revisions and does not approve a broader publication policy.
Do not simply regenerate hashes to dismiss an unreviewed conflict.

### Inspect and bound revision storage

Retention administration is local-only, not an MCP editor permission:

```bash
gbrain call --source default get_skill_retention '{}'
gbrain call --source default prune_skill_revisions '{}'
```

Inspect status before pruning. A prune handles at most 128 eligible revisions;
it preserves current heads, tombstones, the most recent 20 revisions per skill,
the 24-hour grace window, active delivery/pin leases, pending publication
references, and permanent write receipts. Source and brain storage budgets can
block new publications with `skill_retention_capacity`; wait for protections to
expire or prune eligible history rather than deleting active records manually.

`retain_skill_revision`, also through trusted-local `gbrain call`, pins an exact
source/incarnation/pack/name/revision for `hours` greater than zero and at most
24, under bounded quotas. A pin preserves storage, not read or execution
authority. Unpinned old revisions can become `revision_unavailable`; retain
content backups for longer rollback needs. Retention is not physical erasure of
downloaded files, other history, or backups.

## Migrate an existing brain

Use the mechanical [v0.53.0.0 migration checklist](../../skills/migrations/v0.53.0.0.md).
Start on the host with `gbrain apply-migrations --dry-run --json`. It inventories
registered roots and reports stage-specific conflicts, not arbitrary home
directories or disconnected devices. Keep operational DB and content backups
before applying changes. DB-only export requires an explicit absent destination,
quiescence, and a backup choice; it is not a full database backup.

Writer claim, activation and transfer require deliberate administration intent
and the `admin_state` from reviewed `sources writer status --json` output. Neither
routine repair nor `--confirm-quiesced` supplies that authority. Enable the base
managed writer first when necessary, then inspect fresh status before the separate
`--shared-skills` activation. The migration checklist gives the exact state-bound
commands; a changed state requires review, not an automatic retry with a new hash.

An existing root is adopted in place. Knowledge folders, private markers,
modified files, and explicit publishing opt-outs are preserved. Unmanifested
skills, malformed manifests, changed hashes, or an ambiguous root remain
conflicts. Host-global catalogs require reviewed source assignment; migration
does not expose them to every source. Do not count `pending_host_work` or
per-source `action_required` as completion even if the migration ledger says
the mechanical checkpoint completed.

The host report's `member_installations` inventories known members per source,
with `joined`, `refresh_pending`, `delivery_reported`, `source_changed`, or
`left` and a `next_action`. `delivery_reported` means client-reported artifact
delivery only; every row remains native-unverified. Unknown or disconnected
installations are not proven migrated by that inventory.

## Troubleshoot, leave, and recover

Inspect this installation's local receipt without credentials or a live host:

```bash
gbrain connect --harness codex --status --json
```

Use the installation's actual harness and connection `--name`; thin CLI
installations also need their explicit persistent `--root`. Status reports
desired/installed/acknowledged views, the last authority-check time, pending
files, retained-file count, and remote cleanup state. It does **not** make a
fresh authority probe: `current_authority: unprobed` and `native_use: unverified`
remain explicit. For bootstrap-managed wiring use its bootstrap receipt/status
rather than assuming it shares a `connect` installation's receipt path.

| State | Safe next action |
| --- | --- |
| `writer_not_quiesced` | Stop and exclude old filesystem writers and direct-file skill servers; claim exact roots and activate the shared writer protocol on the host. A confirmation flag cannot stop those processes for you. |
| `catalog_unavailable` / `stale_unavailable` | Keep installed files and cursor state; retry the current authorized view. Do not treat failure as an empty catalog or activate a stale cached skill. |
| `full_resync_required` | Discard the pagination cursor and enumerate again under current authority. |
| `requirements_changed` / `approval_required` | Have the owner review the changed disclosure, tools, source, or follow policy. Do not self-grant permissions. |
| `revision_conflict` / `local_conflict` | Preserve both edits and inspect current revisions/ownership receipts before retrying. |
| `restart_required` | Restart the harness and record actual new-conversation evidence. Files alone do not clear this check. |
| `left_with_retained_files` | Preserve the reported edits, disable native cached instructions through the harness controls, and restart. |

`leave_brain` stops this principal's membership. The managed adapter's leave
path also removes unchanged owned files; changed files are retained. Neither
leaving nor `connect ... --remove` revokes credentials, deletes memory, removes
history, or proves that native cached instructions stopped running. Revoke
access separately on the host when intended. Previously downloaded bytes
cannot be recalled, and `forget` is withdrawal from active memory, not physical
erasure of source material, history, or backups.

Managed removal disables local following and attempts owned-file cleanup even
when offline or already revoked. `remote_membership_pending: true` means the
host has not acknowledged leave; retry remote cleanup when possible. Do not
claim a server-side departure from successful local deletion, or delete edited
files to make the status look complete.

There is no automatic content rollback command. To roll back content, an
authorized editor reviews an allowed, retained prior revision and republishes
its complete files with a new request ID and the **current** expected revision.
Policy rollback is a separate owner decision. Do not lower the writer floor,
run an older binary against the activated database, or assume a Git checkout
rebuilds permissions or revision history.

Interrupted publications use durable recovery records; unexpected human edits
fence the root rather than being overwritten. Preserve the database, staging
files, receipts, and root when recovery is pending. Use the current writer's
recovery procedure, not manual journal deletion.

Canonical files can reconstruct content, but operational DB state also needs
a protected, tested backup: grants, memberships, policy/audit history,
revocations, serving identity, and write/delivery receipts are not all in Git.
A stale backup may omit a later revocation or withdrawal. Do not clone a live
operational database and present both copies as independent brains.

### Restore a local archive as a new brain

For supported local PGLite installations, create a private archive with
`gbrain backup create --output /absolute/private/brain.gbrain-backup` after
pausing writers. It contains sensitive full DB state and installer-managed
files, **not every canonical content root**, even on the same disk. Inspect the
archive's `omitted` inventory and back up excluded canonical files separately.
Backup coverage checks and a Git remote are not substitutes for an operational
archive.

Restore only into a new, absent root whose parent already exists:

```bash
gbrain backup restore /absolute/private/brain.gbrain-backup \
  --into /absolute/restored-brain --json
```

An archive with shared-skill storage restores as a **new independent,
unpublished brain**. Restore changes the brain ID and serving epoch/key,
deactivates memberships and leases, revokes archived credentials and local
writers, detaches canonical owners, and disables skill publication/following.
Knowledge, retained revision history, and the writer protocol floor remain;
unfinished work is quarantined, not automatically restarted. The original
installation is not overwritten.

Read `restore-receipt.json`, `reconnect_required`, and
`.gbrain/restore-detached.json`. Restore does not publish a launcher or start
automation. Repair the runtime through the recorded in-agent setup path when
applicable, review restored content, claim the correct restored roots, recheck
writer quiescence, establish publication policy, and issue new credentials
before serving. A backup with unresolved file recovery fails with
`restore_recovery_required`; preserve the archive/source installation, reconcile
recovery with its current owner, and make a new backup.

### Recover the same brain identity

For a compatible local operational archive, an explicit recovery mode preserves
the brain ID while still rotating the serving epoch/key, revoking archived
credentials and memberships, detaching owners, and disabling publication:

```bash
gbrain backup restore /absolute/private/brain.gbrain-backup \
  --into /absolute/recovered-brain --mode recovery \
  --confirm-quiesced --confirm-backup-compatible --confirm-authority-reviewed \
  --json
```

All three confirmations are required. They record operator attestations, not
proof that the old service stopped or that the archive contains later
revocations and withdrawals. Exclude the old service externally, validate the
archive against current authority and withdrawal records, review the recovery
receipt, and reissue access before serving. Missing compatible authority metadata
or unresolved file recovery still refuses recovery; flags cannot bless an
incomplete archive.

External PostgreSQL dump restoration remains an operator-managed procedure with
the same offline validation, old-service exclusion, and authority reissue
requirements. A stale backup cannot tell you which newer withdrawals or
revocations it lacks.

## Concurrent publication and engine choice

PGLite's single backing connection serves both reads and atomic bundle
publication. Frequent publications can delay shared-skill body and asset reads,
especially as the generated pack inventory grows. PostgreSQL is the preferred
engine for write-heavy shared catalogs. This is a latency consideration, not
permission to return partially published files or stale authorization.

The reproducible [lifecycle workload](../../scripts/shared-skills/README.md)
reports correctness, read latency and publication costs separately. A successful
delivery test or memory-search latency gate is not a passing shared-asset latency
result, and no benchmark proves native harness activation.

## Acceptance checklist

- **Protocol:** discover only granted sources; fetch an exact revision and its
  approved dependency manifest; verify a committed edit reaches both a second
  principal and the parent. Check forbidden-source and revoked access fail.
- **Files:** check ownership receipts, hashes, pending/retained files, and the
  recorded absolute launcher or named MCP connection. An edited native shadow
  copy is unresolved until safely excluded with the user's authorization.
- **Native new conversation:** record the exact harness/version and observe it
  choose the relevant skill without being told its name, then use the new
  revision after refresh/restart. Missing platform access stays unverified.

Keep these evidence levels separate. See [harness validation](harness-validation.md)
for the release checklist; this guide is not a claim that those tests ran on
your installation.
