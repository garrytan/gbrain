# Give your coding agent a memory: GBrain + Claude Code / Codex

Coding agents got very good at code. They're still amnesiac about everything
else. Claude Code and Codex forget your last conversation, can't tell you what
you decided three meetings ago, and re-derive context you already have written
down somewhere. GBrain is the retrieval layer that fixes that: search, synthesis,
and a self-wiring knowledge graph, wired into your agent over MCP.

There are two ways to do this. Pick the one that matches where you are:

- **Path A — I already run a brain** (OpenClaw, Hermes, or any `gbrain serve`
  host) and I want my Claude Code / Codex to reach the same brain. → [jump to Path A](#path-a-connect-an-agent-to-a-brain-you-already-have)
- **Path B — I have nothing yet.** Spin up a local brain in 2 seconds and wire it
  into my coding agent. → [jump to Path B](#path-b-start-from-nothing-local-brain-local-agent)

Both end in the same place: an agent that searches your brain before it answers,
and writes new knowledge back as you work. The last section,
[Now make it actually useful](#now-make-it-actually-useful), is the same for both
and is the part that changes how you work.

Prerequisite for either path: `bun install -g github:garrytan/gbrain`.

---

## Path A: connect an agent to a brain you already have

You already have a populated brain (the OpenClaw / Hermes case: it's on your
agent host, full of meetings, people, and ideas). You want Claude Code on your
laptop, and Codex too, to query it. This is the remote path: the host serves
HTTP, your laptop agents connect with a token.

### A1. On the host: serve over HTTP

If your host isn't already serving HTTP MCP, start it:

```bash
gbrain serve --http --bind 0.0.0.0 --public-url https://your-host.example.com
```

Two flags matter and people skip them:

- **`--bind 0.0.0.0`** — the default bind is `127.0.0.1` (loopback only), which
  silently refuses every remote connection. If your agent "can't reach the
  brain" and you didn't pass this, that's why. `gbrain serve --http` warns you at
  startup when `--public-url` is set without `--bind`.
- **`--public-url`** — the externally reachable HTTPS URL (your Render/Railway
  URL, ngrok domain, Tailscale Funnel, etc.). It's the issuer the OAuth/MCP
  layer advertises.

Watch the startup banner. It now prints a `Skills:` line:

```
║  Skills:    published                                  ║
```

If it says `not published`, your connected agents will be able to search and
write but won't see your skill catalog (the OpenClaw skills that make your setup
special). Turn it on:

```bash
gbrain config set mcp.publish_skills true
```

(New brains from `gbrain init` default this ON. Brains upgraded from before
v0.41.36 stay OFF until you opt in, so this is the common gotcha for existing
OpenClaw users.)

### A2. On the host: mint a token

```bash
gbrain auth create "laptop-agents"
```

Copy the `gbrain_…` token it prints. It's a long-lived, full-access secret. Treat
it like a password; prefer a scoped OAuth client for anything cloud-hosted (see
[DEPLOY.md](../mcp/DEPLOY.md)).

### A3. On the laptop: one command per agent

```bash
# Claude Code
gbrain connect https://your-host.example.com/mcp --token gbrain_xxx --install

# Codex
gbrain connect https://your-host.example.com/mcp --token gbrain_xxx --agent codex --install
```

`--install` runs the agent's `mcp add` for you AND smoke-tests the token: it
actually calls `get_brain_identity` before handing off, so a wrong or expired
token fails right now, not silently on the agent's first request. You'll see:

```
Added MCP server 'gbrain' -> https://your-host.example.com/mcp.
Verified: {"version":"0.42.x","engine":"postgres","page_count":146646,...}
```

Drop `--install` to print a paste-ready block instead (useful when the host and
the agent are different machines, or you want to read before you run). Codex
reads the bearer from `$GBRAIN_REMOTE_TOKEN` at runtime, so the token never lands
in Codex's config file. Keep that variable exported in your shell profile.

### A4. Verify

In the agent: *"Call get_brain_identity, then search my brain for [a topic you
know is in there]."* You should get your own pages back. Done.

Full per-client detail: [Claude Code](../mcp/CLAUDE_CODE.md),
[Codex](../mcp/CODEX.md), [Perplexity](../mcp/PERPLEXITY.md).

---

## Path B: start from nothing (local brain, local agent)

No OpenClaw, no server, no token. The lowest-friction path in the whole product:
a local PGLite brain in the same process your agent spawns. Zero server, zero
tunnel.

### B1. Create a local brain

```bash
gbrain init --pglite      # 2 seconds; embedded Postgres via WASM, no Docker
```

### B2. Put something in it

A brain with nothing in it answers nothing, so an empty brain on day one feels
broken. Two ways to fill it:

```bash
# Bulk-import a folder of markdown you already have:
gbrain import ~/notes/

# Or capture as you go (one thought at a time):
gbrain capture "Decided to use PGLite as the default engine: zero-config beats Postgres for <1000 files."
```

You don't have to import everything up front. The capture-as-you-go habit (see
the next section) means the brain fills with the decisions and context you
generate while working, and is genuinely useful by day two.

### B3. Wire it into your coding agent

```bash
# Claude Code
claude mcp add gbrain -- gbrain serve

# Codex
codex mcp add gbrain -- gbrain serve
```

That's the whole wire-up. No token, no URL, no tunnel. The agent spawns
`gbrain serve` as a stdio subprocess and talks to your local brain directly.

### B4. Verify

In the agent: *"search my brain for PGLite"* (or whatever you just captured). You
get the page back. The same brain is now query-able from the CLI
(`gbrain query "..."`) and from your agent.

---

## Now make it actually useful

Connecting is the easy part. The value comes from teaching your agent a few
habits. These are the patterns that turn a coding agent into a knowledge-aware
one. Paste the protocol below into your agent's instructions file
(`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex / Cursor / others), then lean
on the patterns.

### The brain-first protocol (paste this in)

```markdown
## Brain-first protocol

You have a knowledge brain connected over MCP. Before answering any question
about people, companies, decisions, projects, or past context:

1. **Search first.** Call `search` (or `query` for a synthesized answer) against
   the brain BEFORE answering from memory or asking me. If the brain has the
   answer, use it. Never ask "who is X?" or "what did we decide about Y?" before
   searching — the brain probably already knows.
2. **Write back.** When I make a decision, mention a new person/company, or land
   on an idea worth keeping, write it to the brain with `put_page` (entity pages
   under people/, companies/; decisions under decisions/ or notes/). One insight,
   one page, linked.
3. **Cite.** When you answer from the brain, name the page you used.
```

### The four patterns worth stealing

These come straight from a production OpenClaw setup. They translate directly to
any coding agent with GBrain connected:

**1. Brain-first lookup (never ask what you can retrieve).** The single highest-
value habit. Before the agent asks you "which repo?" or "who owns this?", it
searches. Try: *"What did we decide about the auth rewrite?"* and watch it pull
the decision page instead of asking you to re-explain.

**2. Ambient capture (your brain as a side effect of working).** Don't make
saving a separate chore. Tell the agent: *"As we work, capture any decision or
new idea to the brain without interrupting."* After a month of this, you have
hundreds of linked pages and patterns you didn't know were there.

**3. Briefing from your brain (not from the internet).** *"What do I need to know
before my 2pm with the Acme team?"* pulls your meeting history, the people,
what's still open, what the brain doesn't know yet. The agent does your prep
because it read your context. (`query` gives you the synthesized answer with
citations; this is the example on the [README](../../README.md).)

**4. whoknows (expertise routing).** *"Who do I know who's shipped a rate
limiter in Postgres?"* The `find_experts` tool ranks people in your brain by
relevance + recency. Useful the moment your brain has more than a handful of
people in it.

That's the spine of it. Two commands to connect, one protocol to paste, four
habits to build. Your agent stops being amnesiac.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agent "can't reach the brain" (Path A) | `gbrain serve --http` bound to loopback | Restart with `--bind 0.0.0.0` |
| `list_skills` returns nothing / errors | Skill publishing OFF on the host | `gbrain config set mcp.publish_skills true` |
| Token rejected on first call | Wrong/expired token | Re-mint with `gbrain auth create`; `--install` smoke-tests it for you |
| `unknown tool: capture` | `capture` is CLI-only, not an MCP tool | Use `put_page` over MCP; `capture` only on the CLI |
| Empty results (Path B) | Brain has nothing in it yet | `gbrain import ~/notes/` or `gbrain capture "..."` |

## Next steps

- Go full autonomous: the overnight enrichment daemon ([dream cycle](../../CHANGELOG.md)) fixes citations, dedupes people, builds scorecards while you sleep. See `gbrain autopilot --install`.
- Run a real agent platform on top: [personal-brain tutorial](personal-brain.md).
- Scale to a team: [company-brain tutorial](company-brain.md).
- Every MCP client's exact setup: [`docs/mcp/`](../mcp/).
