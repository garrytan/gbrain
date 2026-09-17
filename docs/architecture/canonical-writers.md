# Canonical writer enforcement

Managed persistence is an explicit activation boundary. Page bodies, frontmatter,
visibility, tags, aliases, facts, takes, timeline rows, source identity/path and
sync checkpoints require coordinator authority. The checked-in
[writer census](canonical-writers.tsv) lists every engine-method/SQL reference to
those writes plus the filesystem and git escape paths. Its test rejects a new
file or an increase in write references until the enforcement route is reviewed.
This lexical census intentionally includes comments; it supplements runtime
checks rather than proving arbitrary JavaScript safe.

Supported page, memory, tag, timeline and take operations use the durable journal.
Their receipts become committed only with the canonical transaction. Prepared
imports compare the observed page identity/revision before installing bodies,
versions, tags or chunks. A same-body hash is insufficient for a prepared no-op:
canonical metadata and additive tags must also match. Legacy hash repairs and
unchanged-file skips acquire the same page guard and compare revisions.

Source add, archive, restore, remove, purge, path rebind and managed reclone use
native exclusion and guarded topology transactions. Directory replacement also
reserves recovery space and records its beforeimage before publication. Source
incarnations fence old queued requests; lifecycle replay retains its original
outcome even after a source is removed and recreated.

Unsupported direct writers fail closed after managed activation. SQL triggers
cover pages, tags, slug aliases, free-text aliases, facts, takes, timeline entries
and sources. Physical embeddings/index telemetry remain projections. Connector
materialization, unmanaged import variants, engine migration, manual link edits,
schema link rewrites, synthesis, patterns
and phantom redirect refuse before their first canonical side effect. Legacy
maintenance that reaches a canonical engine mutation is rejected by the SQL
trigger. Extracted links are derived projections; manually authored link API
writes remain refused until a coordinator callback exists. Links authored in
Markdown are reconciled by the coordinated import transaction.

Managed Markdown sync runs on the registered filesystem owner with
`gbrain sync --source <source-id> --no-pull`. Discovery freezes the target Git
commit, source incarnation, owner epoch, topology generation and page
identities/revisions. Attached repositories import committed Git content;
`--working-tree` opts into uncommitted files and detached repositories include
them automatically. Source-relative exclusions retain their existing meaning.
Each file's bytes and fingerprint are frozen before its journal request is
admitted. Import leaves the original bytes intact unless canonical sanitization
or retained tags require an explicit recoverable file publication.

A durable cursor uses a singleton JSON-array envelope under the private
`managed-sync` operation in `op_checkpoints`; the immutable manifest is stored
separately so advancing one page never rewrites the entire discovered file list. Only one page is admitted ahead of
the scan, and the scan yields after at most 25 pages or 250 milliseconds between
page publications. Foreground requests on the same root receive service first;
after 25 foreground commits or one second of continuous foreground service, sync
earns a bounded batch even while new interactive requests continue arriving. Interruption or a pending owner leaves the cursor and source
checkpoint intact. A later invocation resumes the frozen target; a newer Git
HEAD is a separate subsequent sync. A revision/file conflict blocks the cursor.
After inspecting the conflict, `--retry-failed` can start a fresh discovery once
all earlier admitted requests are terminal. `--skip-failed` cannot advance a
managed checkpoint past failed receipts.

When PGLite already has a resident owner, the CLI authenticates before opening
the datastore, including when the owner serves stdio MCP. Sync uses the private
CLI registration and a strict options envelope; stdio credentials and legacy
shared-secret sync cannot acquire that authority. The client advances bounded
RPC slices. If the client exits, accepted page requests can finish, and repeating
the same options resumes the remaining durable cursor.

The source checkpoint commits only after the entire selected cursor is exhausted
and every admitted page has a committed receipt. It takes the source-exclusive
guard before authentication/request/page locks and checks the original anchor,
source incarnation, topology and owner epoch. Code/image importers, ignored-file
walks and Git pull/rebase remain explicitly refused in managed mode until their
own prepared publication and recovery paths exist. Remote sync retains the
original `submit_job` principal, admin/source/operation ceiling and normalized
payload; runtime options cannot expand that grant and current revocation is
checked before publication.

Filesystem helpers check managed roots before atomic writes, frontmatter backup,
schema-pack replacement, clone, staging, pull or rebase. The registry stores one
0600 record per brain/root under the private configuration directory; records
retain source incarnation, worktree and topology generation when known. Existing
ancestors are resolved through symlinks, including a not-yet-created target.
Records are refreshed when an engine connects and remain usable before a second
process opens local PGLite. Stale records conservatively refuse writes until a
verified drain and explicit administration cleanup. A shared 0600 refusal marker
inside git metadata (or `.gbrain-managed` for non-git roots) also protects supported
commands using another home. Marker existence never grants publication authority.

The native worktree lock and database ownership rows grant authority. Registry
files and markers only refuse unsupported writes; copying a marked tree may
therefore require administration cleanup. Generated durability hooks honor that
refusal. Activation must quiesce older binaries and external writers because
programs that do not implement this protocol cannot be constrained by application
checks. Direct SQL administration, external editors and arbitrary shell commands
remain outside the supported writer protocol. Migration and rollback after
managed commits require verified drain and forward repair, preserving the
journal, source incarnation and canonical revisions.
