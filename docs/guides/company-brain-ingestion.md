# Connect an existing company knowledge repository

**Say to your agent:** “Connect our existing company brain to GBrain. Preserve the
source files, show me the destination and any gaps, and ask before importing.”

This workflow preserves structured company Markdown: customers, competitors,
people, decisions, meetings, and reference pages. It uses an opt-in company schema
and a durable import receipt. It does not reorganize your repository, install its
agent instructions, or enable paid services.

Verified ingestion is not a privacy audit or permission to share. Sanitizing a
personal brain for team use is the separate `company-brainify` workflow and requires
its own explicit approval; connect does not strip sensitive facts or Git history.

## Try it without private data

```bash
gbrain sources demo company-brain
```

The bundled fictional sample goes through the real import and graph pipeline in
an in-memory database. The result identifies an account owner and champion, and
shows which decision supersedes an earlier one, with source-qualified citations.
No API key, configured brain, or saved database is required. Add `--json` for a
machine-readable result. The demonstration is not a claim about your repository.

## Inspect, then connect

The initial workflow supports **committed Markdown in a local Git checkout** and
a **new source in an initialized company brain**. Clone an authorized private
repository through your existing Git workflow first. Non-Git directories, dirty
eligible files, and narrower access requirements must be resolved before apply.

1. Inspect the repository without opening a database:

   ```bash
   gbrain sources inspect ./company-wiki --profile company-brain
   ```

   Every tracked file is accounted for as included, excluded, or unsupported.
   Invalid metadata and conflicting identities block import. Missing owners,
   verification dates, and unresolved links are reported rather than invented.
   Explicit page types can be preserved outside the conventional folder layout;
   use full source-local link paths when a short name is ambiguous or unsupported.

2. Choose an existing destination and preview the effects:

   ```bash
   gbrain sources connect ./company-wiki \
     --brain company-example --source wiki --profile company-brain
   ```

   `--brain` selects the database; `--source` selects the repository inside it.
   Both are required. Use a dedicated company brain, not an unrelated personal
   database. See [Brains and sources](../architecture/brains-and-sources.md) and
   [engine setup](../ENGINES.md) if the destination does not exist yet. Connect
   does not silently initialize or migrate it. A populated incompatible schema
   is refused rather than rewritten.

3. Approve the displayed destination, schema binding, and existing access policy.
   Connect indexes the approved commit, reconciles relationships, and reads the
   result back before reporting completion. Its receipt distinguishes content,
   graph, and verification stages; a successful content sync alone is insufficient.

   Completion includes an example of recorded ownership and decision supersession
   from the imported source, with citations. Missing examples are explicitly
   `not_applicable`, not fabricated. These are verified stored relationships, not
   an LLM quality score or a claim that the sample lists every owner or decision.

No source files, Git history, or access grants are changed by connect. Existing
broad grants may already cover a new source; the preview makes that visible.
`federated=false` suppresses default cross-source search, **not authorization**.
Imported `audience` and `verified` metadata are assertions, not new permissions or
independent verification. Unsupported private/narrower audience requirements must
be mapped through a separately approved access design or excluded.

## Agent and CI use

```bash
gbrain sources inspect ./company-wiki --profile company-brain \
  --json --out ./company-import-plan.json

gbrain sources connect --plan ./company-import-plan.json \
  --brain company-example --source wiki --json

# Only after approving that preview:
gbrain sources connect --plan ./company-import-plan.json \
  --brain company-example --source wiki --yes --json
```

Without `--yes`, a non-interactive connect returns its preview and a confirmation
requirement instead of waiting on stdin. `--yes` authorizes the listed import; it
does not bypass source, schema, identity, or access checks. A saved plan is not an
authorization token. Changed input requires another inspection.

Keep the displayed request ID and the original plan when a connect response is
interrupted. Retry the same approved connection with `--request-id <uuid>` and
the same destination and selection instead of creating another source. A
different request or changed approval does not bypass a collision. If the
checkout has advanced since admission, use source-scoped sync below to recover
the stored receipt rather than replacing the approved plan with current HEAD.

`--out` creates a private file and refuses to overwrite an existing one. The
inspection JSON envelope also contains the raw plan under `plan`; connect accepts
either representation. Plans and receipts may expose private filenames, so do
not post them publicly. Repeat `--include <glob>` and `--exclude <glob>` during
inspection to choose repository-relative paths; re-inspect to change a saved
selection. No network Git operations, provider calls, repository hooks, filters,
scripts, submodules, or LFS downloads run.

New commands write one versioned JSON result to stdout with `--json`; progress
and prompts go to stderr. Exit 0 means a completed command, 2 means invalid usage
or required consent, and 1 means blocked, failed, or incomplete work. Always read
`status` and the receipt as well as the exit code.

## Resume and verify

```bash
gbrain sources status --brain company-example --json
gbrain sync --brain company-example --source wiki --no-embed --no-pull
```

An incomplete receipt retains the approved revision and outstanding phase.
Graph or verification failures are retried even when the content has no diff.
Incomplete checkpoints are protected from age-based cleanup. If the original
commit objects are gone or the approved schema changed, inspect again; GBrain
does not substitute current HEAD silently. Managed brains retain their native
writer, source-incarnation, and revision conflict checks.

Semantic schema/extractor upgrades do not silently renew an old approval. This
first version has no in-place reapproval command. Preview the old registration's
removal impact with `gbrain sources remove wiki --brain company-example --dry-run`.
Removal requires separate destructive consent and `--confirm-destructive` before
reinspecting and reconnecting the same checkout. Alternatively, use a separate
authorized checkout/destination. Do not remove a source automatically merely to
make an upgrade succeed, or edit persisted approval/policy fields to bypass refusal.

Ordinary sync remembers this source's profile and selection. It remains keyless
and does not pull, enqueue embeddings, or edit repository housekeeping files.
Changes to target pages also refresh references from unchanged pages in the same
source. Cross-source references are reported, not satisfied from another source
with a similar name.

When managed canonical consistency would require changing the source Markdown,
the workflow refuses with `source_writeback_required`. Review the needed source
correction separately; the import does not waive canonical checks or make that
edit for you. A lock or ownership change may require waiting for the registered
owner or following the existing writer recovery procedure.

Source status distinguishes incomplete, complete, discarded, missing, and
unavailable receipt state. It does not claim a missing receipt means nothing was
imported. Removing a source is a separate destructive action using the
impact-preview and `--confirm-destructive` flow above; original repository files
remain untouched. Backups may remain.

## What stays opt-in

Embeddings, recurring sync, sharing/federation, imported skills, curation, and
changes to verified company knowledge are separate actions. This workflow never
adopts a repository's “safe changes commit to main” policy automatically. It runs
on the trusted brain host; ordinary MCP/OAuth access is not source-administration
authority, and thin clients do not fall back to an empty local brain.

After separate approval, `gbrain sources federate wiki --brain company-example`
can include the source in default cross-source search. That does not change its
immutable import policy: sync still performs no pull, embedding, or source
writeback, and automatic embedding backfill remains blocked. Federation does not
grant access or authorize enrichment; do not edit the stored profile to enable
either.

The first release does not connect into populated sources, support arbitrary
export formats, or mix different source schemas in one brain, even when federation
is off. An occupied destination must already use the exact company schema.
Existing general migration tools remain available for other source formats.

The company vocabulary and fictional sample are adapted from
[mattzimak/gbrain-company-brain](https://github.com/mattzimak/gbrain-company-brain)
under MIT. See `third-party/company-brain/NOTICE.md` for the pinned revision and
adaptation details.
