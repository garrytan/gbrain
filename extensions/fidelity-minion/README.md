# Fidelity concept Minion

This optional PostgreSQL Minion publishes a private, database-only concept from
an explicitly approved list of atom excerpts. It uses the existing Minion
queue and managed persistence coordinator and does not call a chat model.

1. Create the source's atoms through the normal ingestion workflow. Tag each
   participating atom with `fidelity_concepts: [<topic>]` in frontmatter. This
   membership is separate from Dream's native `concepts` field. Leave the
   native `concepts` field empty on these atoms.
2. Use the trusted local CLI to set
   `cycle.synthesize_concepts.fidelity.<source>` to a JSON object keyed by
   topic. Each value is an ordered array of
   `{"atom":"atoms/example","sha256":"<sha256 of the approved atom body>"}`.
   The digest covers the trimmed body after generated fence sections are
   stripped. The concept quotes the approved first paragraph and links to
   the complete atom. Review the atom before changing its approval.
3. Choose a trigger for the approved topic.

## Dream handoff

Use the same PostgreSQL brain with an Autopilot worker and an elected HTTP
Serve consumer from a build that supports the Dream guard. Enable one approved
topic per source and list the source page slugs whose current revisions must
finish native atom extraction before the Minion may publish. For example:

```sh
gbrain config set cycle.synthesize_concepts.fidelity_dream.default \
  '{"topic":"incident-review","pages":["notes/example-incident-review"]}'
```

Autopilot uses the existing atom-drain budget and source slot. It runs the
Minion in the same job after all selected inputs have completed, with the
scope and source revisions checked again by Serve at publication. A failed,
truncated, held or pending extraction blocks publication. A compatible Serve
must own the write coordinator. While configured, native concept synthesis
skips the same topic after resolving its canonical name. Existing pages are
preserved. Change the setting between cycles so an already-running native
publication can finish first. Revoking approval pauses the Minion. Removing
the setting allows native synthesis from existing `concepts` tags, without
backfilling tags omitted by scoped extraction. Use one trigger per source and topic.

## Independent runner

For an independent schedule, build with
`bun build --compile --no-compile-autoload-bunfig extensions/fidelity-minion/run-once.ts --outfile fidelity-minion`.
Run `./fidelity-minion jobs <source> <topic>` on the same host as the
elected HTTP Serve consumer that advertises guarded maintenance support,
with managed persistence and
`persistence.single_consumer` enabled. Use the same brain configuration.
The runner checks the registered source owner and publishes through Serve.
It does not need filesystem access to the source worktree.
Set your scheduler to invoke that command for each approved topic.

A replay of unchanged inputs keeps the existing page revision. A concurrent
change to a participating atom, its trust, the source, or the approval rejects
the publication. To stop publishing, remove the schedule or revoke that
topic's approval. An existing private concept remains available for review.

If a write is pending, the command returns the original durable receipt.
Inspect that request with `gbrain write-request <request-id>`. After a
revision conflict, review the current atom and approval before retrying.
