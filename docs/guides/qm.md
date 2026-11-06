# QM memory provider

QM, a trusted system that already knows who each person is, keeps per-person
memory in a brain through two MCP tools: `memory_recall` reads what the person may
read, and `memory_write` saves facts only they read back. Both run as the person QM
names in the `x-qm-actor` header. The wire contract QM vendors is
[`docs/contracts/qm-memory-provider/v1.json`](../contracts/qm-memory-provider/README.md);
`v2.json` adds the scope read and `v3.json` the personal tools for the person's own DM.

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
The personal tools in [contract v3](../contracts/qm-memory-provider/README.md) (`query`,
`get_page`, `get_timeline`, `get_backlinks`, `find_experts`, `whois`, `entity`,
`context_pack`, `volunteer_context`, `forget_fact`) are opt-in the same way: the
default stays `get_write_request,memory_recall,memory_write`, so list each one QM uses,
for example `--attest-ops forget_fact,get_page,get_write_request,memory_recall,memory_write,query,whois`.
They read as the person, their own restricted pages included, so grant them only to
the client that serves the person's own DM, never to a client that serves shared
rooms.
Direct page writes (`add_timeline_entry`, `add_link`, `put_page`, `edit_page`) are not
attestable: a person's words reach a shared page only through an owner-approved proposal,
which is not served yet. `--attest-ops` refuses them, and a list that already names one
is refused for it on every call (`actor_not_attested`, reason `op_not_attested`).
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

## What the tools do

- `memory_recall {query, max_chars?, source_id?, source_ids?}` answers plain text, one fact per line
  (`- <fact> (<date>; <kind>)`): the person's own facts from the last 24 hours
  first, then the facts they may read ranked by `query`. Never page bodies. The text
  holds as many whole lines as fit, with no marker line (every line is one fact;
  `structuredContent.truncated` says some were left out), and never exceeds `max_chars`
  (a whole number of UTF-16 code units, 200-12000, default 6000). Each fact is
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

On success the result is in `structuredContent`, and `content` holds only the text
for the model. Each fact in `structuredContent.facts` carries `arm`: `own` (the
person's own recent fact) or `ranked` (matched by `query`); a recall that names
sources has only `ranked` rows. An attested call to a v3 personal tool also gets its
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
