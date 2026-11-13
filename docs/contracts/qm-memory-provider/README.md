# QM memory-provider contract

`v1.json` is the contract between gbrain and QM's memory provider: the two tools
(`memory_recall`, `memory_write`) with their argument schemas, output shapes and
limits, the `x-qm-actor` header and actor id pattern, every error code and
`actor_not_attested` reason with its fix, the operations not attestable yet, and
the `x-qm-audience` header, refused until wave 2.

`v2.json` adds the scope read (`source_id` / `source_ids` on `memory_recall`).
`v3.json` keeps all of v2 and adds `personal_tools`: the tools QM's agent calls in
a person's own DM, read as that person (`query`, `get_page`, `get_timeline`,
`get_backlinks`, `find_experts`, `whois`, `entity`, `context_pack`,
`volunteer_context`, `get_write_request`, `forget_fact`). Each entry carries the
served input schema and a frozen result shape: the fields every success carries,
with other fields allowed and ignored. `get_write_request` freezes the write-request
states, and a state not listed means unknown, not published. v3 also adds each
`memory_recall` fact's `arm` (`own` or `ranked`), and `memory_recall`'s `query_keep`:
`tail` ranks a query over 2,000 characters on its end instead of its start, and a
call that sends it gets `query_truncated`. None of the v3 tools is a
default attested operation (only `get_write_request` is): the brain operator lists
each one in the client's `--attest-ops`. No v3 tool is marked as a shared-scope
read; v4 adds those markings.

`v4.json` keeps all of v3 and adds three things. `memory_propose` lets QM propose
one timeline entry or link on a shared page that the brain owner approves before
anything is written, with its arguments, caps, the proposal receipt `get_write_request`
answers, the proposal states (a state not listed means unknown, not published) and
`cancel_write_request` as the proposer's cancel. Each personal tool carries
`scope_read: true` or `false`: a marked tool reads named sources as their audience,
never as the person. Each `memory_recall` fact carries `own_page`, true when the fact
sits on the person's own member page, which is exactly when `forget_fact` accepts it on
ownership (it can still ask the owner for a fact more trusted than the person's own writes).
`x-qm-audience` is not an input in v4: a request carrying it is refused
(`actor_not_attested`, reason `audience_not_supported`), with or without `x-qm-actor`.

`v5.json` keeps all of v4 and marks `context_pack` `scope_read: true`: a call that
names `source_id` reads only that source (entities, cards, core memory, the
counterparty brief and hot facts) as its audience. Each `entity_refs` entry must
carry that same `source_id`, and `entity_refs` without `source_id`, an entry in
another source, or `session_id` is refused with `invalid_params` before anything
is read.

They are generated from the live operation registry by
`bun scripts/build-qm-memory-contract.ts` (part of `bun run regen:all`), and
`test/qm-memory-contract.test.ts` fails when a committed file drifts.

A change to the shape is a new file; a published file never changes, and
`v1.json` stays byte-identical until QM moves.

`v2.json` adds `source_id` / `source_ids` on `memory_recall` (scope reads, `scope_read`) and `source_id` on
`memory_write` (scope writes, `scope_write`). Its `invalid_params` note names `recall`'s 2,000-character question
limit: a longer question is refused with reason `question_too_long` and detail `max_chars=2000 received_chars=<n>`,
never cut.

Operator setup is in [docs/guides/qm.md](../../guides/qm.md).
