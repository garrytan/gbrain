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
3. Build with
   `bun build --compile --no-compile-autoload-bunfig extensions/fidelity-minion/run-once.ts --outfile fidelity-minion`.
   Run `./fidelity-minion jobs <source> <topic>` on the same host as the
   elected HTTP Serve consumer that advertises guarded maintenance support,
   with managed persistence and
   `persistence.single_consumer` enabled. Use the same brain configuration.
   Set your scheduler to invoke that command for each approved topic.

A replay of unchanged inputs keeps the existing page revision. A concurrent
change to a participating atom, its trust, the source, or the approval rejects
the publication. To stop publishing, remove the schedule or revoke that
topic's approval. An existing private concept remains available for review.

If a write is pending, the command returns the original durable receipt.
Inspect that request with `gbrain write-request <request-id>`. After a
revision conflict, review the current atom and approval before retrying.
