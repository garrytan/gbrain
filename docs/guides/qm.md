# QM memory provider

QM, a trusted system that already knows who each person is, keeps per-person
memory in a brain through two MCP tools: `memory_recall` reads what the person may
read, and `memory_write` saves facts only they read back. Both run as the person QM
names in the `x-qm-actor` header. The wire contract QM vendors is
[`docs/contracts/qm-memory-provider/v1.json`](../contracts/qm-memory-provider/README.md); `v2.json` adds scope reads and writes, `v3.json` the personal tools for the person's own DM, `v4.json` owner-approved proposals (`memory_propose`), which personal tools are scope reads, and each recalled fact's `own_page`, and `v5.json` marks `context_pack` as a scope read.

## Set up on the brain host

```bash
gbrain auth register-client qm --grant-types client_credentials --scopes "read write"
gbrain auth rescope --client <client_id> --attest-actor qm      # attested ops default to get_write_request,memory_recall,memory_write
gbrain access member add alice-example --email alice@example.com   # --email is optional
gbrain access member link alice-example --qm U0ALICE            # the canonical id QM sends, compared exactly
gbrain access member link --email alice@example.com --qm U0ALICE # the same link, finding the member by email
```

A declared email (`--email` on `member add`, or `gbrain access member set <id> --email <addr>|none`) is
stored lower-case and is unique per brain. It only helps the operator find the member: the operator
still makes every link, an unknown email is `not_found` and creates nothing, and QM can't set an email
or make a link.

From another machine, the owner runs the same steps over the running server with
`gbrain mcp admin attest`, `member-add`, `member-set` and `link` (owner session only; see
[ADMIN](../mcp/ADMIN.md#inspect-clients-and-edit-access)).

Add `forget` with `--attest-ops forget,get_write_request,memory_recall,memory_write` if QM
should withdraw facts; an attested `forget` reaches only facts on the person's own
page, and any other id is `not_found`.
The personal tools in [contract v3](../contracts/qm-memory-provider/README.md) (`query`,
`get_page`, `get_timeline`, `get_backlinks`, `find_experts`, `whois`, `entity`,
`context_pack`, `volunteer_context`, `forget_fact`) are opt-in the same way: the
default stays `get_write_request,memory_recall,memory_write`, so list each one QM uses,
for example `--attest-ops forget_fact,get_page,get_write_request,memory_recall,memory_write,query,whois`.
They read as the person, their own restricted pages included, so grant them only to
the client that serves the person's own DM, never to a client that serves shared
rooms.
No page write is attestable: `put_page`, `edit_page`, `append_page`, `add_timeline_entry`, `add_link`,
tags, deletes, restores, uploads, raw data and every other operation that writes a page, plus answer
feedback, the ingest log and loop muting, are listed in the contract's `deferred_ops`. A person's words reach a shared page only through an owner-approved
proposal (`memory_propose`, [below](#proposed-writes)). `--attest-ops` refuses them, and a list that
already names one is refused for it on every call (`actor_not_attested`, reason `op_not_attested`).
An attested `remember` keeps the fact on the person's own page: `share: true` or `visibility: "world"`
is refused (`invalid_params`, reason `attested_share_refused`) and nothing is saved.
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

### Reads that name sources

An attested call to `get_page`, `entity`, `whois`, `get_backlinks`, `get_timeline`,
`find_experts`, `volunteer_context`, `query` or `memory_recall` that names `source_id`
or `source_ids` reads those sources as their audience, never as the person: the
person's restricted pages and their member page read as missing, a source outside
the grant is refused, and `__all__` or `all_sources` is refused (`invalid_params`).
`volunteer_context` refuses `stats: true` there. An agent job submitted for the
person reads the same way. List the ops a client needs with `--attest-ops`.
`context_pack` that names `source_id` reads that one source the same way: its entities,
the core block, the counterparty brief and hot facts all come from that source. Each
`entity_refs` entry must name the same `source_id`; `entity_refs` without `source_id`,
an entry in another source, or `session_id` is refused (`invalid_params`) before
anything is read. Contract v4 marks each personal tool `scope_read: true` or `false`;
v5 adds `context_pack` to the marked tools.

Set how each client reads named sources with `--attest-read`:

```bash
gbrain auth rescope --client <room_client_id> --attest-read scope    # every call must name a person
gbrain auth rescope --client <dm_client_id> --attest-read person     # named sources, read as the person
```

`scope` also refuses any call that names no person (`actor_not_attested`, reason
`actor_required`), so the client never reads as itself. `person` is for a client that
serves only one person's own conversations, so a client with `--attest-sources` refuses it; a `person` client that reads a source a
room client reads is flagged by `gbrain doctor` (`attest_read_shared_scope`). Unset
(`none`) reads named sources as the scope and still serves calls that name no person.

### Each person's own sources

A client reads only the sources its credential is granted, usually the default
source, so facts in a member's own DM or member source are not recalled until the
client is granted that source. Grant the client every DM source and bind each one to
its member, so a person reads their own and nobody else's:

```bash
gbrain auth rescope --client <client_id> --sources source-a,dm-alice-example,dm-bob-example
gbrain access member source add alice-example dm-alice-example
gbrain access member source add bob-example dm-bob-example
gbrain access member source list
```

A bound source is personal. An attested call reads its credential's grant minus every
personal source bound to someone else: alice-example's unnamed `memory_recall` reads
source-a and dm-alice-example, never dm-bob-example. A read that names sources as
their audience (the reads above, unless the client is `--attest-read person`) reads
no personal source, not even the speaker's own, so a room never reads a DM. A hidden
source named in `source_id` or `source_ids` is refused exactly like a source outside
the grant (`permission_denied`). Binding only hides inside the grant: a source the
credential is not granted stays unreadable. Unattested calls and member-bound
credentials are unchanged. `gbrain access member source remove <member> <source>`
previews first and says whether the source stays personal; `--yes` applies. Bindings
are database state, so a repo-less brain works the same.

## Proposed writes

`memory_propose` lets QM suggest one timeline entry or one link on a shared page for
the person it serves. Nothing is written until the brain owner says yes. Grant it with
`--attest-ops cancel_write_request,get_write_request,memory_propose,memory_recall,memory_write`.

- `memory_propose {kind, target, idempotency_key, expected_revision?, ...}`: `kind: "timeline"`
  takes `date` (`YYYY-MM-DD`), `summary`, `detail?` and `source?`; `kind: "link"` takes `to`,
  `link_type?`, `context?`, `valid_from?` and `valid_until?`. A field of the other kind is
  refused (`invalid_params`, reason `proposal_kind_field`). The person must be able to read the
  target (and a link's `to` page). The answer is `{status: "awaiting_owner", request_id, kind,
  target, expires_at}`; the same key from the same person and client returns that proposal's current
  status, and the same key with other fields is `idempotency_conflict`.
- `get_write_request {request_id}` reads the proposal: `awaiting_owner`, then `approved`
  (with the write's own receipt), `denied` (with the owner's reason), `expired`, `cancelled`,
  `failed` or `conflict` (the page or the link target changed while it waited). Only the
  person it was made for reads it; anyone else gets `not_found`.
- `cancel_write_request {request_id}` withdraws a proposal still awaiting the owner.

The owner reviews on the brain host, or from another machine with `gbrain mcp admin
memory-proposals list|show|approve|deny` (owner session only), never over MCP:

```bash
gbrain memory-proposals list                       # awaiting your decision, oldest first
gbrain memory-proposals show <request_id>          # the proposed text, fenced as untrusted transcript text
gbrain memory-proposals approve <request_id>       # re-checks the person, the grant and the page, then writes it; exits 1 if the write fails
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
  never as the person: no own facts first and no fact from any member page
  (unless the client is set `--attest-read person`; see below).
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
for the model. Each fact in `structuredContent.facts` carries `arm`: `own` (the
person's own recent fact) or `ranked` (matched by `query`); a recall that names
sources has only `ranked` rows. Each fact also carries `own_page`: `true` when it sits on
the person's own member page, the same test `forget_fact` uses, so `forget_fact` accepts it on
ownership; `false` means `forget_fact` for that person answers `fact_not_found`. An older own fact can be `ranked` with
`own_page: true`. A query over 2,000 characters is ranked on its start;
send `query_keep: "tail"` when QM puts its preamble ahead of the turn, and read
`query_truncated` to tell a cut query from a short one. An attested call to a v3 personal tool also gets its
result in `structuredContent` (a list as `structuredContent.results`), while
`content` keeps the JSON; `context_pack`'s `content` is its rendered text alone. The
same tools called without `x-qm-actor` answer as before, with no `structuredContent`.
A personal read whose answer, counted with `structuredContent`, is over the
connection's result cap is refused whole (`result_too_large`). A person not yet linked gets an empty `memory_recall` with
`structuredContent.code: "actor_unlinked"` (its arguments are still checked
first). Every refusal, including the transport's scope and unknown-tool ones,
carries `structuredContent.error`. A request carrying `x-qm-audience` (channel
turns, wave 2) is refused before any work with `actor_not_attested` reason
`audience_not_supported`, with or without `x-qm-actor`. Refusals are listed in
[attested-actor refusals](write-refusals.md#attested-actor-refusals).
