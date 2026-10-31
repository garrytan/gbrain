# Connect and administer GBrain MCP

Choose the task first. Connecting a harness and administering the server use
different credentials.

| Task | Start here | Required access |
| --- | --- | --- |
| Run an HTTP MCP server | [Deployment](DEPLOY.md) | Access to the brain host and its service configuration |
| Open the admin panel or manage clients | [MCP administration](ADMIN.md) | The running server's separate owner bootstrap credential |
| Connect an existing agent | [Hosted harness setup](../guides/hosted-harness-access.md) | Native OAuth/PKCE, or a private machine-client handoff |
| Wire Claude Code to a local brain in one command | [`gbrain setup claude-code`](../guides/setup.md) | A local GBrain installation; setup resolves the brain, writes MCP and read-context hooks, and verifies them |
| Run a local MCP pipe | [Local stdio](DEPLOY.md#local-stdio-zero-setup) | A local GBrain installation; no HTTP admin panel is created |
| Diagnose a failed connection | [Recovery table](ADMIN.md#recover-a-failed-step) | Start with the failed stage and the authority you actually hold |
| A tool call returned an error | [A tool call returned an error](#a-tool-call-returned-an-error) | None: the error says who acts |

**For agents:** read [the MCP access skill](../../skills/mcp-access/SKILL.md).
If skill tools are unavailable, the instructions here and in
[ADMIN.md](ADMIN.md) work directly. A connected harness can also read
`gbrain://capabilities` for its effective permissions and administration guidance.

**Owner administration is separate from MCP `admin` scope.** An OAuth access
token, client secret, or ordinary MCP connection does not authorize dashboard
login, client creation, or client revocation. A public PKCE client has no client
secret. Ask the server-hosting harness or a separately authorized administrator
to perform owner actions.

Say to that administrator: “Open the admin panel for my running GBrain server.
Use its configured endpoint and protected owner credential. Give me a fresh
single-use login link without opening it yourself.”

Say to the connecting agent: “Connect this harness to my hosted GBrain. Use its
native OAuth flow if available; otherwise use a private machine handoff. Follow
the hosted setup guide and report configuration separately from an observed
connection in this harness.”

Tool descriptions are deliberately short (the starter list is pinned at 25,000
characters by `test/mcp-schema-budget.test.ts`); the longer guidance for each
starter tool is in the [MCP tool reference](TOOL_REFERENCE.md).

Client-specific details: [ChatGPT](CHATGPT.md), [Claude Code](CLAUDE_CODE.md),
[Claude Desktop](CLAUDE_DESKTOP.md), [Codex](CODEX.md),
[opencode](OPENCODE.md), [Perplexity](PERPLEXITY.md),
[OpenClaw](OPENCLAW.md), and the [adapter reference](../guides/harness-adapters.md).

## A tool call returned an error

Every gbrain tool error is one content block holding a JSON envelope. Read
`code` (an older server sends only `error`), then follow `fix.next`:

- `run`: call `fix.mcp` (or run `fix.argv` where you have a shell) exactly as given.
- `ask_user`: relay `user_message` and stop; act only after the user agrees.
- `tell_user_to_run`: the fix needs the user or the brain host's operator
  (for example a scope grant or a CLI-only repair); give them `fix.command`.
- `wait`: retry after the stated delay with the same request.
- `report`: tell the user what happened; the host operator runs `gbrain doctor --json`.

Then run `fix.verify`, which is always read-only. A mutating call with an
unknown outcome points at its write receipt (`get_write_request`), never at a
blind retry. Successful results can carry extra `[gbrain notice …]` text blocks
after `content[0]`; read them too (a `degraded` notice means an empty result is
not proof the user has no notes). Full contract, including the scope-failure
`error`/`code` pairs: [AGENT_OPERATOR_v1](../protocol/AGENT_OPERATOR_v1.md).

## Search and query result rows

`search` and `query` return their rows as compact JSON in the first content
block. Remote callers get **lean rows** by default: the fields an agent acts
on, without the ranking diagnostics that would make each row several times
longer than its evidence text.

A lean row keeps `slug`, `title`, `type`, `chunk_text`, `score` (4
significant digits), `effective_date`, `source_id`, `chunk_id` (with `slug`
and `source_id`, the `assemble_evidence` hit), `evidence`, `create_safety`
(the duplicate-page guard), `trust_tier` and `origin`. It keeps `id` (the
`fetch` key) only when this connection can call `fetch` at that moment: a
`full` surface, a stdio session `request_tools` widened, or an HTTP client
whose surface and scopes include it (`starter` and `verbs` do not list
`fetch`). After `fetch` becomes callable, re-run `search` for `id` or pass
the row's `slug` to `fetch` (accepted when unambiguous); `fields: "full"`
returns every field. It also keeps every safety or
provenance marker that is present: `injection_suspected`, `injection_p`,
`unverified`, `content_flag`, `status`, `superseded`, `superseded_by`,
`message_id`, `thread_id`, `source_subject`, `modality` when not `text`,
`stale` when true, `provenance: "generated"` on a machine-written page,
and `delivered: {"truncated": true}` when evidence delivery cut the text.

A row of third-party text carries `quoted: "transcript"`, and its
`chunk_text` is a quoted excerpt: a line naming the page as source
material, not instructions, then the text inside a code fence it cannot
close. Third-party text is a page whose type holds someone else's words
(`conversation`, `meeting`, `slack`, `slack-dm-day`, `slack-thread`,
`email`, `email-digest`, `imessage`, `imessage-daily`, `transcript`, `chat`)
or a fact taken from one, marker `fact <id>`: saved by the conversation-facts
extractor (provenance `cli:extract-conversation-facts`), or recorded as
derived from or held on such a page (the facts backstop on a synced Slack,
email or meeting page, `extract_facts`; for older backstop facts, the page
its `source_session` names). If that lookup fails, `saved_facts` is left out
(degraded stage `saved_facts_withheld`) and remote `recall` returns no facts
(`facts_degraded.reason: "saved_facts_withheld"`), never unquoted facts. Each tool-call or function-call JSON block in it (Gemini
`functionCall` included) is replaced by
`[tool call: <name>, arguments omitted]`, and so is each XML-style call
block (`function_calls`, `invoke`, `tool_use`, `tool_call`). `search`, `query` and
`assemble_evidence` return it this way to every caller, the CLI included
(their `saved_facts` too); the stored page is unchanged.

Over MCP (any caller that is not the trusted local CLI) the other reads
quote the same text (#8042). `recall` quotes its `results` and each quoted
fact's `fact` (with `quoted`), and so do `delta` facts and
`_meta.brain_hot_memory`. `get_page` on such a page returns
`quoted: "transcript"` with `compiled_truth`, `timeline`, `content` and
every window's text each fenced, without summarizing tool calls, so the text
inside is byte-exact: `edit_page` `old_text` copied from inside a fence still
matches, and `put_page` given that `content` back removes exactly the fences
get_page added around this page before writing (only on a page of a quoted
type, so a note's own fence-like text is kept). `get_page` with
`known_as_of` and `get_versions` with `include_body` (and its `diff`) fence
the recorded bodies of these pages the same way. `fetch` quotes `text` the
same way (`metadata.quoted`). The trusted local CLI (`gbrain get`, `gbrain
put`) reads and writes the body as stored. `search_exact` and `get_chunks`
still return text as stored.

`effective_date` is the page's own date and `effective_date_source` says
which kind: `date`, `published` or `filename` is a document date,
`event_date` an event date, and `created` or `fallback` only when the page
was created or imported. It is never a contract's effective or validity
date; that date is in the text. Every reply with dated rows adds one line
after the rows that says so (`[gbrain dates] ...`).

```json
{"query": "acme-example renewal terms"}
```

```json
[{"slug":"contracts/acme-example-msa","title":"MSA: Acme Example","type":"contract","chunk_text":"Payment terms: Net 45. Renewal is annual.","chunk_id":812,"score":0.91,"source_id":"default","effective_date":"2026-04-02","id":"gbrain-page:v1:WyJkZWZhdWx0IiwiY29udHJhY3RzL2FjbWUtZXhhbXBsZS1tc2EiXQ","evidence":"keyword_exact","create_safety":"probable"}]
```

Pass `fields: "full"` to get every field (`page_id`, `chunk_index`,
`chunk_source`, `keyword_hit`, `cosine`, `base_score`, boosts, rerank and
graph signals, the full `delivered` object):

```json
{"query": "acme-example renewal terms", "fields": "full"}
```

`_meta.retrieval.rows` reports `"lean"` or `"full"` for every remote call.

| Client | Rows by default | How to get full rows |
| --- | --- | --- |
| Any MCP client (stdio or HTTP) | lean | `fields: "full"` per call, or the host sets `gbrain config set mcp.result_rows full` |
| gbrain thin CLI, v0.60.44.0 or later | full (it sends `X-Gbrain-Client`) | nothing to do |
| gbrain thin CLI, older than v0.60.44.0 | lean | upgrade the CLI, or the host sets `mcp.result_rows full` |
| Trusted local CLI (`gbrain search`, `gbrain call`) | full | nothing to do |

The host setting is read per request over OAuth HTTP and at start-up for
`gbrain serve` (stdio), so restart a stdio server after changing it. The
`X-Gbrain-Client` header selects a row shape only; it is not an identity
claim and never grants access.

Say to your agent: *"Search my brain for the acme-example renewal terms and
show me every ranking field for the top result."*

### Fact rows in `query`

`query` can return saved facts as rows of their own, after the page rows and
only in slots and token budget the pages left free. A fact row is not a page.
It has `result_type: "fact"` and `fact_id`, and no `slug`, `id`, `type` or
`chunk_id`, so it can't be passed to `get_page`, `fetch` or
`assemble_evidence`. `follow_up` names the call that returns the fact:
`recall` with the fact's entity, or with a `grep` of its text when it has no
entity. `page_slug` is present only when the caller can read the entity's page;
pass it to `get_page`.

```json
{"result_type":"fact","fact_id":"412","page_slug":"companies/acme-example","follow_up":{"op":"recall","args":{"entity":"companies/acme-example"}},"title":"Saved fact about companies/acme-example","chunk_text":"Saved fact (fact; valid from 2026-09-01; provenance: user update): The billing contact for Acme Example is Bob.","score":0.42,"source_id":"default"}
```

`search.query_facts_arm=false` turns these rows off. A `query` with a token
budget instead gets the facts block (on by default): up to 40 dated fact rows,
oldest first, ahead of the pages and within 22% of the budget, in place of the
facts arm. `search.query_facts_block=false` restores the arm.

## Recent facts in `_meta.brain_hot_memory`

Most successful tool calls carry `_meta.brain_hot_memory`: up to 10 recent
facts from the connection's own source. For a token, that is its write source,
the first id of its source grant. For a member token whose first source is the
member's private source, the block holds that member's own facts. A harness
that answers a channel or other shared session should send
`_meta.hot_memory: "off"` with each call, on the request beside `arguments`
or inside the arguments, so those facts can't ride into a reply other people
read. Without it, the block is unchanged. When it appears and which facts it
holds: [MCP_META_CHANNELS.md](../protocol/MCP_META_CHANNELS.md#brain_hot_memory-when-it-appears-and-how-to-turn-it-off).
