# QM memory-provider contract

`v1.json` is the contract between gbrain and QM's memory provider: the two tools
(`memory_recall`, `memory_write`) with their argument schemas, output shapes and
limits, the `x-qm-actor` header and actor id pattern, every error code and
`actor_not_attested` reason with its fix, and the operations not attestable yet.

It is generated from the live operation registry by
`bun scripts/build-qm-memory-contract.ts` (part of `bun run regen:all`), and
`test/qm-memory-contract.test.ts` fails when the committed file drifts.

A change to the shape is a new file, `v2.json`; `v1.json` stays until QM moves.
Operator setup is in [docs/guides/qm.md](../../guides/qm.md).
