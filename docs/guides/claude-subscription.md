# Run GBrain on your Claude subscription

The `claude-cli` recipe sends chat calls through the local `claude` binary,
which authenticates with your own Claude Code login, so a brain with no API
key can still extract facts, expand queries, synthesize and think. This page
is the one-command way to put every chat surface on that route, what the
route does not cover, and what it means for your plan's usage limits.

**This is opt-in.** Nothing in GBrain selects this route by default, and
nothing here is a recommendation to prefer it: you run the command, read the
dry run, and apply it. Every call on the route, including the ones background
jobs make while you are away from the keyboard, draws on the same session and
weekly limits as your own Claude Code use, and whether unattended use fits
your plan's terms is for you to check against Anthropic's current text (see
[Terms](#terms)).

**Say to your agent:** *"Put gbrain's model calls on my Claude subscription
instead of an API key. I know background jobs will use my plan's limits."*

**Say to your agent:** *"Show me which gbrain model surfaces would still
resolve to another provider."*

## Prerequisites

- Claude Code 2.0.60 or newer installed and logged in (`claude` on `PATH`,
  or `GBRAIN_CLAUDE_CLI_BIN` pointing at it). The
  [claude-cli recipe page](../ai-providers/claude-cli.md) covers the
  subprocess flags, the env scrub and troubleshooting.
- An embedding plan that is not `claude-cli`: Claude has no embedding model.
  Keep a local embedder (`ollama`, `llama-server`), a keyed one (`openai`,
  `google`, `voyage`), or run keyword-only with embeddings off. `gbrain
  providers explain` lists the options; `gbrain doctor --only
  embedding_provider` reports the one in effect.

## Turn it on

```bash
gbrain models route claude-cli            # dry run: the keys it would set
gbrain models route claude-cli --apply    # write them
gbrain models                             # the routing now in effect
gbrain doctor --only subscription_routing --json
```

The preset sets, in the brain's DB config plane:

| Key | Value | Why |
|---|---|---|
| `models.default` | `claude-cli:claude-sonnet-5-5` | every surface no tier or per-task key covers |
| `models.tier.utility` | `claude-cli:claude-haiku-5-5` | expansion, synopses, classification |
| `models.tier.reasoning` | `claude-cli:claude-sonnet-5-5` | synthesis, chat, the drift and pattern judges |
| `models.tier.deep` | `claude-cli:claude-opus-5-5` | `think`, standing questions |
| `models.tier.subagent` | `claude-cli:claude-sonnet-5-5` | the `gbrain agent run` tool loop |
| `models.aliases.haiku` / `sonnet` / `opus` | the matching `claude-cli:` id | an alias in any other key stays on the route |
| `facts.extraction_model` | `claude-cli:claude-haiku-5-5` | fact extraction otherwise follows the reasoning tier |
| `models.dream.extract_atoms` | `claude-cli:claude-haiku-5-5` | atom extraction reads its own key before any tier |
| `models.dream.edge_contradictions` | `claude-cli:claude-haiku-5-5` | the edge-contradiction judge reads its own key before any tier |
| `models.brainstorm.judge` | `claude-cli:claude-sonnet-5-5` | the brainstorm judge reads its own key before any tier |
| `models.standing_questions` | `claude-cli:claude-opus-5-5` | pinned questions read it, then the retired `models.auto_think`, before the deep tier |
| `models.route` | `claude-cli` | tells `gbrain doctor` which provider to check against |

It changes nothing else. Pricing stays at the recipe's nominal API-list rate,
so `cycle.extract_atoms.budget_usd`, `facts.drain_budget_usd` and the other
dollar caps keep throttling how much a background pass can send; `gbrain
pricing set 'claude-cli:*' --rate 0` removes that throttle. The
`chat_fallback_chain`, the reranker and the nightly quality probe's judge
panel are left as you had them; the doctor check below names them if they
point elsewhere.

## Check it

`gbrain doctor --only subscription_routing` walks every surface `gbrain
models` reports (the four tiers, every per-task route, the nightly probe's
reader, extractor and judge slots), the live reranker and each fallback-chain
entry, and lists the ones that resolve to another provider: each says whether
it would bill that provider (its key is present here) or fail (no key). It
also reports the embedding provider and whether it is local, keyed, missing
its key or unset. Keys only in the daemon's `~/.gbrain/env` read as absent
here, the same caveat `gbrain models` prints.

`gbrain models doctor` still probes reachability with one small request per
configured chat and expansion model; on `claude-cli` each probe spawns the
CLI once.

## Turn it off

```bash
gbrain models route claude-cli --undo            # preview the restore
gbrain models route claude-cli --undo --apply    # restore the values from before --apply
```

The first `--apply` stores the previous value of every key it writes under
`models.route.undo`, so undo returns the brain to that state and clears
`models.route`. If you set the keys by hand instead, undo unsets each key in
the table above; `gbrain config unset <key>` does the same one at a time.

## What it means for your plan

- **Background jobs use your plan's limits.** Autopilot, the maintenance
  sweep, fact drains, `gbrain dream` and the nightly probe call the model
  while you are not at the keyboard, and every one of those calls draws on
  the same session and weekly usage windows as your interactive Claude Code
  use. Anthropic's advertised limits assume ordinary, individual use. Keep
  the dollar caps on and start with one phase at a time (`gbrain config set
  autopilot.auto_drain.max_usd_per_day …`, `cycle.extract_atoms.budget_usd`,
  `facts.drain_budget_usd`) so a large backlog cannot use up a window
  overnight.
- **When a window is used up, calls fail** with `claude-cli API error 429:
  You've hit your session limit`. A [chat fallback chain](chat-fallback.md)
  to a keyed model keeps jobs running on that key; without one, the job
  retries later. The `subscription_routing` check names a fallback entry on
  another provider so you know it is there.
- **Latency.** Each call is a `claude -p` subprocess: several seconds of cold
  start before the first token, so a drain of hundreds of pages takes hours,
  not minutes.
- **No embeddings, no streaming, no images** on this route (see the recipe
  page's constraints table).

## Terms

The subscription is yours and the terms that govern it are Anthropic's; this
guide does not interpret them, and they change. Before relying on this route
for unattended work, read the current versions:

- Claude Code legal and compliance:
  https://code.claude.com/docs/en/legal-and-compliance
- Using the Claude Agent SDK and `claude -p` with a Claude plan:
  https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Consumer Terms of Service: https://www.anthropic.com/legal/consumer-terms

As of October 2026 those pages say that subscription sign-in is meant for
ordinary use of Claude Code and other Anthropic applications, that the
advertised usage limits for Pro and Max plans assume ordinary, individual
usage, that developers building products on Claude should use API key
authentication, and that `claude -p`, the Agent SDK and third-party apps
draw on your subscription limits where they are permitted. GBrain runs the
unmodified `claude` binary under your own login and never shares it; whether
a nightly job on your brain is "ordinary, individual usage" is a question
for the current text, not for this page.
