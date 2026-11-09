# QM memory-provider contract

`v1.json` is the contract between gbrain and QM's memory provider: the two tools
(`memory_recall`, `memory_write`) with their argument schemas, output shapes and
limits, the `x-qm-actor` header and actor id pattern, every error code and
`actor_not_attested` reason with its fix, the operations not attestable yet, and
the `x-qm-audience` header, refused until wave 2.

It is generated from the live operation registry by
`bun scripts/build-qm-memory-contract.ts` (part of `bun run regen:all`), and
`test/qm-memory-contract.test.ts` fails when the committed file drifts.

A change to the shape is a new file, `v2.json`; `v1.json` stays until QM moves.
`v2.json` adds `source_id` / `source_ids` on `memory_recall` (scope reads, `scope_read`) and `source_id` on
`memory_write` (scope writes, `scope_write`). Its `invalid_params` note names `recall`'s 2,000-character question
limit: a longer question is refused with reason `question_too_long` and detail `max_chars=2000 received_chars=<n>`,
never cut.
Operator setup is in [docs/guides/qm.md](../../guides/qm.md).
