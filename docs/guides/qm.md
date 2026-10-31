# QM memory provider

QM, a trusted system that already knows who each person is, keeps per-person
memory in a brain through two MCP tools: `memory_recall` reads what the person may
read, and `memory_write` saves facts only they read back. Both run as the person QM
names in the `x-qm-actor` header. The wire contract QM vendors is
[`docs/contracts/qm-memory-provider/v1.json`](../contracts/qm-memory-provider/README.md).

## Set up on the brain host

```bash
gbrain auth register-client qm --grant-types client_credentials --scopes "read write"
gbrain auth rescope --client <client_id> --attest-actor qm      # attested ops default to memory_recall,memory_write
gbrain access member add alice-example
gbrain access member link alice-example --qm U0ALICE            # the canonical id QM sends, compared exactly
```

Add `forget` with `--attest-ops forget,memory_recall,memory_write` if QM should
withdraw facts; an attested `forget` reaches only facts on the person's own page.
Links and the right are database state, so a repo-less brain works the same; where
a repo exists, saved facts go through the same git-first writer door as `remember`.

## What the tools do

- `memory_recall {query, max_chars?}` answers plain text, one fact per line
  (`- <fact> (<date>; <kind>)`): the person's own facts from the last 24 hours
  first, then the facts they may read ranked by `query`. Never page bodies. The text
  is cut at a line with a final `… N more` line and never exceeds `max_chars`
  (200-12000, default 6000). Ranking is keyword-only on a keyless brain.
- `memory_write {facts, idempotency_key}` saves 1-20 facts on
  `memory/members/<member>`, readable by that member alone, with provenance
  `qm:<id>; <provenance>`. The same key from the same person replays the first
  receipt; from another person it is a separate write. A write still publishing
  answers `status: "pending"` with a `request_id` for `get_write_request`.

On success the result is in `structuredContent`, and `content` holds only the text
for the model. A person not yet linked gets an empty `memory_recall` with
`structuredContent.code: "actor_unlinked"`. Refusals are listed in
[attested-actor refusals](write-refusals.md#attested-actor-refusals).
