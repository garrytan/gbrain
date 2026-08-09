# Use GBrain as Hermes' long-term memory

Yes. Hermes can use GBrain as its memory through the
[standalone GBrain memory provider](https://github.com/veltri-23/hermes-gbrain-memory).

**Hermes remembers what GBrain knows, and GBrain remembers what Hermes learns.**

This creates a two-way memory loop:

| Direction | What happens |
| --- | --- |
| GBrain to Hermes | Before Hermes answers, the provider searches GBrain and gives Hermes the pages most relevant to the current conversation. |
| Hermes to GBrain | After a useful conversation turn, the provider saves a durable memory back to GBrain. |

Hermes can therefore use knowledge already stored in GBrain, and GBrain can keep
learning from future Hermes conversations. A new session can recall something a
previous session learned without pasting the history back into the prompt.

This is more than adding GBrain as an optional tool. The provider connects to
Hermes' memory lifecycle, so recall and capture happen automatically during normal
conversations.

## Why this integration exists

GBrain already documents Hermes as an agent platform that can install GBrain and
call it through MCP. That is useful, but it is not the same as making GBrain the
agent's memory provider.

MCP access gives Hermes tools it can call. A memory provider participates in every
normal conversation: it recalls relevant knowledge before the answer and captures
useful new memory afterward. This integration closes that gap for Hermes.

The goal is to give Hermes users GBrain's retrieval, durable knowledge, and memory
organization without making them manage memory by hand. OpenClaw memory-provider
support is planned as follow-up work; this guide documents the Hermes integration
that exists in the linked draft implementation.

Tracking issue: [#3870](https://github.com/garrytan/gbrain/issues/3870).

## A concrete example

Suppose you tell Hermes that a project launch moved to Friday and that the customer
needs a migration plan first.

1. After the conversation, the provider saves the useful part to GBrain.
2. Days later, you ask a new Hermes session what still blocks the launch.
3. Before answering, Hermes searches GBrain and receives the saved launch context.
4. Hermes answers with the Friday deadline and migration-plan dependency, even though
   the original conversation is no longer in its prompt.

The same brain can also contain notes, documents, people pages, project history, and
other sources imported outside Hermes. Hermes can recall that existing knowledge too.

## Tested with real scale and real concurrency

This integration was tested beyond a small unit-test fixture. Recorded development
runs include:

| Test | Result |
| --- | --- |
| Live GBrain deployment | 1,305 pages and 15,661 chunks; 8/8 paraphrased questions recalled the expected memory |
| Growing conversation history | 8/8 recall at 50, 200, and 600 accumulated capture-shaped pages; roughly 150-180 ms |
| Fully embedded scale run | 8/8 recall at 10,000 pages; p50 206 ms |
| Large keyword-path scale run | 8/8 recall at 100,000 pages; p50 184 ms |
| Shared-server concurrency | 15 clients; 575 ms median; 0 errors |
| User isolation | 12 agents, 12 users, and 5 turns each; 0 cross-user reads |

The current Hermes framework and standalone-provider draft branches also have 556
automated tests passing with 6 skipped. Earlier development and security passes ran
additional overlapping suites and independent review operations. Those repeated runs
are kept as evidence, but are not added together as if every run were a unique test.

## What you need

- A working [GBrain](https://github.com/garrytan/gbrain) installation with an
  initialized brain.
- Hermes with standalone memory-provider support.
- The standalone GBrain provider installed in Hermes.

GBrain remains the system that stores, searches, and organizes memory. The provider
is the bridge that translates between Hermes' memory lifecycle and GBrain's MCP
interface. That bridge lets Python-based Hermes use TypeScript-based GBrain without
moving the brain, duplicating its data, or rewriting either project.

## Install and select the provider

Use Hermes' built-in plugin installer. You do not need to clone files or find
Hermes' plugin directory yourself.

```bash
hermes plugins install veltri-23/hermes-gbrain-memory --no-enable
hermes memory setup
```

The first command installs the GBrain adapter through Hermes' normal plugin
system. The second selects GBrain as the active memory provider and walks through
connection setup.

If the provider is already installed, run only:

```bash
hermes memory setup
```

You can also set the provider explicitly in Hermes' configuration:

```yaml
memory:
  provider: gbrain
```

Then run either setup command:

```bash
hermes memory setup
# or
hermes gbrain setup
```

Use `hermes memory setup`, not `hermes plugins enable`. GBrain registers as an
exclusive memory provider rather than a general-purpose plugin.

Keep only one active GBrain provider installation. If Hermes also contains an older
bundled copy, check which path Hermes resolved before enabling the provider.

## Choose how Hermes connects

### Local mode: simplest for one Hermes process

Local mode starts `gbrain serve` through standard input and output. It needs no open
port and no bearer token.

```yaml
plugins:
  gbrain:
    base_url: ""
    command: gbrain
```

Use this when Hermes and GBrain run on the same machine and only one Hermes process
needs the brain.

### Shared server: one brain for multiple Hermes profiles or agents

Shared mode connects Hermes to GBrain's HTTP MCP server. Create a token, start the
server, and configure Hermes with the server origin.

```bash
gbrain auth create hermes
gbrain serve --http --port 7842
```

Save the printed token once in the `.env` file under Hermes home:

```dotenv
GBRAIN_TOKEN=replace-with-printed-token
```

Then configure Hermes:

```yaml
plugins:
  gbrain:
    base_url: http://127.0.0.1:7842
    token_env: GBRAIN_TOKEN
    command: gbrain
```

Set `base_url` to the server origin, not to `/mcp`. The provider adds `/mcp` when it
sends a request.

For a server on another machine, protect it with TLS or a private tunnel and bearer
authentication. Do not expose an unauthenticated MCP endpoint.

## Memory separation and sharing

The provider keeps captured conversations separated by user or Hermes profile.
Automatic scope selection prefers a stable platform user identity, then a profile
identity. If neither is available, capture is disabled instead of writing memory to
an unknown owner.

```yaml
plugins:
  gbrain:
    scope: auto      # auto | user | profile | shared
    namespace: hermes
    capture: true
```

`scope: shared` allows explicitly shared operator knowledge to be read across
profiles. New conversation captures still write to the caller's private scope.
Existing GBrain pages outside the Hermes namespace remain available as operator
knowledge, which is how Hermes can use a brain that was populated before the provider
was installed.

## Useful settings

Most users can keep the defaults. These settings control how much memory Hermes reads
and whether conversations are captured:

```yaml
plugins:
  gbrain:
    base_url: http://127.0.0.1:7842 # blank uses local mode
    token_env: GBRAIN_TOKEN          # variable name, never the token value
    command: gbrain
    tools: auto                      # safe core tools; all is opt-in
    scope: auto
    namespace: hermes
    limit: 10
    max_pages: 8
    snippet_chars: 220
    char_budget: 2600
    capture: true
    timeout: 10.0
```

## Verify the connection

```bash
hermes gbrain status
```

This checks that Hermes selected the provider, can reach GBrain, and can perform a
recall. An empty brain can return no memories while the connection is healthy. Import
or create a page before treating an empty result as a connection failure.

For shared HTTP, test GBrain directly too.

POSIX shells:

```bash
gbrain auth test http://127.0.0.1:7842/mcp --token "$GBRAIN_TOKEN"
```

PowerShell:

```powershell
gbrain auth test http://127.0.0.1:7842/mcp --token $env:GBRAIN_TOKEN
```

## What happens if GBrain is unavailable?

Hermes continues the conversation without recalled memory. A slow or unavailable
brain does not block the assistant indefinitely. Conversation capture runs in a
bounded background queue, so a stalled brain cannot consume unbounded memory.

This fail-open behavior protects the conversation, but it also means Hermes may answer
without older context and a queued capture may be dropped while GBrain is unavailable.

## Advanced: tools and compatibility

The provider uses GBrain's `search` operation for automatic recall and `put_page` for
durable capture. It can also expose scoped versions of core GBrain tools such as
`recall`, `get_page`, `traverse_graph`, and `find_contradictions` to Hermes.

The provider performs the MCP initialization and tool-discovery handshake before it
selects a shared server. It is tested against GBrain's current MCP server and should
not be treated as a general bridge for arbitrary MCP servers.

GBrain operations marked local-only are not exposed through HTTP. Responses and writes
are filtered to the caller's allowed memory scope before they reach Hermes.
