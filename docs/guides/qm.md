# QM memory provider

QM, a trusted system that already knows who each person is, keeps per-person
memory in a brain through two MCP tools: `memory_recall` reads what the person may
read, and `memory_write` saves facts only they read back. Both run as the person QM
names in the `x-qm-actor` header. The wire contract QM vendors is
[`docs/contracts/qm-memory-provider/v1.json`](../contracts/qm-memory-provider/README.md); `v2.json` adds scope reads and writes.

## Set up on the brain host

```bash
gbrain auth register-client qm --grant-types client_credentials --scopes "read write"
gbrain auth rescope --client <client_id> --attest-actor qm      # attested ops default to get_write_request,memory_recall,memory_write
gbrain access member add alice-example
gbrain access member link alice-example --qm U0ALICE            # the canonical id QM sends, compared exactly
```

Add `forget` with `--attest-ops forget,get_write_request,memory_recall,memory_write` if QM
should withdraw facts; an attested `forget` reaches only facts on the person's own
page, and any other id is `not_found`.
Direct page writes (`add_timeline_entry`, `add_link`, `put_page`, `edit_page`) are not
attestable: a person's words reach a shared page only through an owner-approved proposal
(`memory_propose`, [below](#proposed-writes)). `--attest-ops` refuses them, and a list that
already names one is refused for it on every call (`actor_not_attested`, reason `op_not_attested`).
A client whose `bound_slug_prefixes` do not cover `memory/members/<member>` is refused
(`permission_denied`) when it saves for that member.
Links and the right are database state, so a repo-less brain works the same; where
a repo exists, saved facts go through the same git-first writer door as `remember`.

Use the attest client only for QM's personal-scope memory route. An attested call
reads as the named person, including their own private facts and pages only they
may read, and gbrain cannot tell which conversation the answer goes to. Don't
register the client as a model-callable MCP connector in QM, and don't route it to
shared scopes (channels, groups, projects, teams, the org): either can show one
person's private facts to a whole room. Shared conversations wait for
`x-qm-audience` (wave 2).

## Proposed writes

`memory_propose` lets QM suggest one timeline entry or one link on a shared page for
the person it serves. Nothing is written until the brain owner says yes. Grant it with
`--attest-ops cancel_write_request,get_write_request,memory_propose,memory_recall,memory_write`.

- `memory_propose {kind, target, idempotency_key, expected_revision?, ...}`: `kind: "timeline"`
  takes `date` (`YYYY-MM-DD`), `summary`, `detail?` and `source?`; `kind: "link"` takes `to`,
  `link_type?`, `context?`, `valid_from?` and `valid_until?`. A field of the other kind is
  refused (`invalid_params`, reason `proposal_kind_field`). The person must be able to read the
  target (and a link's `to` page). The answer is `{status: "awaiting_owner", request_id, kind,
  target, expires_at}`; the same key from the same person returns that proposal's current
  status, and the same key with other fields is `idempotency_conflict`.
- `get_write_request {request_id}` reads the proposal: `awaiting_owner`, then `approved`
  (with the write's own receipt), `denied` (with the owner's reason), `expired`, `cancelled`,
  `failed` or `conflict` (the page or the link target changed while it waited). Only the
  person it was made for reads it; anyone else gets `not_found`.
- `cancel_write_request {request_id}` withdraws a proposal still awaiting the owner.

The owner reviews on the brain host, never over MCP:

```bash
gbrain memory-proposals list                       # awaiting your decision, oldest first
gbrain memory-proposals show <request_id>          # the proposed text, fenced as untrusted transcript text
gbrain memory-proposals approve <request_id>       # re-checks the person, the grant and the page, then writes it
gbrain memory-proposals deny <request_id> --reason "<why>"
```

An approved proposal becomes an ordinary write admitted at approval, under the same
`request_id`, with the person's member id (never QM's id) in its provenance. Until then the
text lives only in the `memory_proposals` table: it never reaches git, an export, search or
recall. `gbrain doctor` (`memory_proposals_pending`) and `gbrain status` show how many wait.
Limits, all set with `gbrain config set`: `proposals.ttl_hours` (168), `proposals.max_pending_per_actor`
(10), `proposals.max_pending_per_credential` (50; over either cap is `proposals_pending_limit`),
`proposals.max_payload_chars` (1,000; over it is `invalid_params`, reason `proposal_too_large`),
`proposals.max_reason_chars` (500) and `proposals.retention_days` (30: closed proposals are
deleted after it; awaiting ones expire at their TTL first). A repo-less brain works the same.

## What the tools do

- `memory_recall {query, max_chars?, source_id?, source_ids?}` answers plain text, one fact per line
  (`- <fact> (<date>; <kind>)`): the person's own facts from the last 24 hours
  first, then the facts they may read ranked by `query`. Never page bodies. The text
  holds as many whole lines as fit, with no marker line (every line is one fact;
  `structuredContent.truncated` says some were left out), and never exceeds `max_chars`
  (a whole number of UTF-16 code units, 200-12000, default 6000). A longer `query` is
  ranked on its first 2,000 characters, never refused. `recall`'s `question` is capped at 2,000: a longer one is
  refused `invalid_params` with reason `question_too_long` and detail
  `max_chars=2000 received_chars=<n>`, nothing is read, so trim it before calling. Each fact is
  one line: line breaks and control characters in it become spaces. Ranking is
  keyword-only on a keyless brain. A call that names sources (`source_id`,
  `source_ids`, narrowed inside the credential's grant) reads as that scope,
  never as the person: no own facts first and no fact from any member page.
  Name the shared scope on a shared turn; leave sources out only for the
  person's own conversations.
- `memory_write {facts, idempotency_key}` saves 1-20 facts on
  `memory/members/<member>`, readable by that member alone, with provenance
  `qm:<id>; <provenance>`. `provenance` is one line that does not start with
  `qm:`; `valid_from` is `YYYY-MM-DD` or an ISO 8601 time in years 0001-9999.
  Every fact is checked before any is saved, so one bad fact refuses the call and
  leaves the key unused. Repeating a claim in one call saves it once, with one
  id in `fact_ids`. The same key from the same person replays the first
  receipt; from another person it is a separate write. A write still publishing
  answers `status: "pending"` with a `request_id` for `get_write_request`.
- `memory_write {facts, idempotency_key, source_id}` (contract v2) saves the facts on a shared
  scope's page `memory/scope` in that scope source instead, `visibility: world`, readable by every
  credential that reads the source. The source must be in the credential's `--attest-sources`; any other
  source is `permission_denied` reason `source_not_attested`, and the credential's own write source is
  `invalid_params` reason `source_is_member_source` (leave `source_id` out for the person's own page).
  The person is still attested and named in the provenance. A key replays per source.

## Shared scopes (projects, channels, teams)

Give each scope its own source and list it on the QM credential:

```bash
gbrain sources add scope-acme-example --path <dir>   # on a repo brain: git-first, like member pages
gbrain sources add scope-acme-example                # on a repo-less brain
gbrain auth rescope --client <client_id> --attest-sources scope-acme-example --federated-read <home>,scope-acme-example
```

Listing a source marks it a scope source for good (`sources.config.qm_scope`): revoking or rotating the
credential leaves the mark. A scope source is never federated (`sources federate` refuses, `sources restore`
leaves it unfederated, a federated flag on it is ignored), and no other client, token or registration may
add it to a read grant, so its memory is read only by naming it in `memory_recall` from the scope
credential. A person read (no sources named) never reads a scope source. A source others already read,
`default`, a federated source and the credential's own write source cannot be listed; a credential with
scope sources keeps its attested ops within `forget,forget_fact,get_write_request,memory_recall,memory_write` and cannot
hold `--private-pages granted-sources`. A leaked scope credential secret reads and writes every listed scope:
restrict it with `--operations` to the memory tools. Remote writes to `memory/scope` other than a scope
`memory_write` are refused, and a `memory/scope` page that names readers, is private or sits under a folder
rule takes no scope fact (`scope_page_not_shared`). On a repo-backed scope source, anyone who can push to its
repository can also author `memory/scope.md`, because git is the parent; its history keeps every actor's id
through provenance. Each repo-backed scope source is one more writer claim, so its writes may answer `pending`
until a writer publishes them.

On success the result is in `structuredContent`, and `content` holds only the text
for the model. A person not yet linked gets an empty `memory_recall` with
`structuredContent.code: "actor_unlinked"` (its arguments are still checked
first). Every refusal, including the transport's scope and unknown-tool ones,
carries `structuredContent.error`. A request carrying `x-qm-audience` (channel
turns, wave 2) is refused before any work with `actor_not_attested` reason
`audience_not_supported`, with or without `x-qm-actor`. Refusals are listed in
[attested-actor refusals](write-refusals.md#attested-actor-refusals).
