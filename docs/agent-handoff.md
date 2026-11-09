# Agent handoff: thread pickup, delegation inbox, routing

You probably use more than one AI app. A project you started in Grok Bot
lives in Grok Bot's chat history; when you open Claude to finish it, Claude
knows nothing about it, and there is no way to say "Claude, take this one"
from inside Grok Bot. Agent handoff puts that shared state in the brain every
app is already connected to:

- **Thread pickup.** Agents log short turns on a shared thread page. Any other
  agent can find the thread and pick it up with the summary, decisions, open
  questions, next step and linked pages.
- **Delegation inbox.** An agent hands a task to another agent (or to any agent
  on a model). The receiver sees it in its inbox, asks you, claims it with a
  lease, does the work and records the result.
- **Routing.** When you don't name who should take a task, gbrain ranks the
  agents from your routing rules, who is live, and how past delegations went.
  No model is called.

**Say to your agent:** *"check my agent inbox"* — *"delegate this to another
agent"* — *"pick up the project from Grok Bot"* — *"save my place"*. The
`agent-inbox` skill (`skills/agent-inbox/SKILL.md`) carries the loop.

## How it works

Every piece of handoff state is a markdown page with frontmatter, written
through the same page write path as `put_page`. Handoff pages are `type: note`
with a `handoff_type` naming the kind, the same convention gbrain's own reports
use, so every schema pack already declares their type:

| Page | Holds |
|---|---|
| `threads/<id>.md` | title, the agent holding it and its model, status (`active`, `parked`, `done`), the handoff history, rolling summary, next step, decisions, open questions, linked pages, and the turns (append-only) |
| `delegations/<id>.md` | title, instructions, from agent, `to_agent` or `to_model`, context pages, thread, priority, due date, `auto_ok`, status (`open`, `claimed`, `done`, `failed`, `released`), lease, attempts, result, files, and a log of every claim, release and completion |
| `agents/<name>.md` | model, capabilities, registration time, last heartbeat |
| `routing.md` | your routing rules (you write this one) |

So the pages get what every page gets: a canonical file in your brain repo
when one is configured, revision history, search, and `[[links]]` to the
entities a turn mentions. The database is only the index. Deleting it and
re-importing the files rebuilds every thread, task, lease, pick and heartbeat
(`test/agent-handoff-reindex.test.ts` proves this).

**Atomic claims.** `claim_task` reads the task, checks the caller may claim it,
and writes the claim naming the revision it read. The page write path checks
that revision under the page lock, so when two agents race for one task,
exactly one write commits. The other re-reads, sees the live lease and gets
`task_claimed`. Leases default to 15 minutes; claiming again renews.

**Expired leases reopen.** A claimed task whose lease ran out counts as open at
once (`inbox` shows it with `lease_expired: true`, and an eligible agent can
claim it as attempt 2). The next `heartbeat` from any agent writes the reopen
into the page.

**Addressing.** A task addressed to an agent is shown to, and claimable by,
that agent only. A task addressed to a model is shown to every agent
registered on it; `to_model: claude` also matches `claude-opus-5-5`. A claim on
someone else's task is refused with `task_not_addressed`.

**Source.** Handoff pages live in the caller's write source (`source_id`
narrows it the way it does for `put_page`). Agents that should see each other's
work connect with the same write source.

## Tools

The MCP tool names are the operation names; the CLI commands are generated
from the same operations.

| MCP tool | CLI | What it does |
|---|---|---|
| `log_turn` | `gbrain log-turn` | Append a turn (start a thread with `title`, continue with `thread_id`); decisions accumulate, `open_questions` replaces the open list, `entities` link pages |
| `update_thread_summary` | `gbrain thread-summary <thread_id>` | Replace the rolling summary |
| `checkpoint` | `gbrain checkpoint <thread_id>` | Record `next_up` (and optionally a summary) and park the thread |
| `find_thread` | `gbrain find-thread <query>` | Top matches with a `why` line: hybrid search over threads, link-graph hits on the pages the query names, an agent boost and recency |
| `pickup` | `gbrain pickup <thread_id>` | Summary, last 10 turns, decisions, open questions, `next_up`, linked pages, linked delegations, history; with `agent`, joins the history |
| `register_agent` | `gbrain register-agent <name>` | Register an agent's model and capabilities |
| `heartbeat` | `gbrain heartbeat <name>` | Mark the agent live (registering it on first use), reopen expired leases, return the inbox count |
| `delegate` | `gbrain delegate` | Write a task for `to_agent` or `to_model`; with neither, the top `route` target |
| `inbox` | `gbrain inbox <agent>` | Open tasks for the agent, highest priority first, each with an `ask_user` line; plus the tasks it holds |
| `claim_task` | `gbrain claim-task <task_id>` | Claim with a lease; atomic |
| `complete_task` | `gbrain complete-task <task_id>` | Record the result and files; `status: failed` for a failure |
| `release_task` | `gbrain release-task <task_id>` | Give the task back with a reason |
| `fan_out` | `gbrain fan-out` | One sibling task per agent under one thread |
| `pick_result` | `gbrain pick-result <task_id>` | Record which fan-out result you chose |
| `route` | `gbrain route` | Ranked targets with reasons |
| `routing_stats` | `gbrain routing-stats [agent]` | Per-agent completion rate, median minutes to claim, fan-out win rate |

The "next step" field is `next_up` in tool parameters and results: gbrain
reserves `next_step` for its agent-operator contract. On the page it is the
`## Next step` section.

## Routing rules

`route` ranks every registered agent plus every target your rules name. Write
the rules in `routing.md` frontmatter:

```markdown
---
type: note
handoff_type: routing
title: Agent routing
live_window_minutes: 90
rules:
  - when: { tags: [deck, design] }
    prefer: [claude]
    fallback: [chatgpt]
  - when: { task_type: research }
    prefer: [model:gemini-3-pro, grok-bot]
  - when: default
    fallback: [chatgpt]
---
# Agent routing

Decks go to Claude first; research goes to Gemini.
```

A rule matches when the task has any of its `tags` and its `task_type` (when
given). `prefer` and `fallback` name agents, or `model:<label>` for any agent
on that model. The score adds, in order of weight: the rule position
(preferred beats fallback, earlier beats later), liveness (a heartbeat within
`live_window_minutes`; stale and never-seen agents lose points), completion
rate, fan-out win rate, a small penalty per failure, and a bonus for
capabilities that match the task's tags. Every target carries the reasons
behind its score. The same pages always give the same ranking.

## Connect each agent

Each app needs a gbrain connection with write access: a stdio registration on
the same machine, or a remote client (see `docs/guides/remote-mcp.md` and
`docs/guides/hosted-harness-access.md`).

- **Clients granted before this release** hold a snapshot of the operations
  that existed then, so the handoff tools are not in it. The brain owner adds
  them with `gbrain auth rescope --client <client_id> --operations log_turn,update_thread_summary,checkpoint,find_thread,pickup,register_agent,heartbeat,delegate,inbox,claim_task,complete_task,release_task,fan_out,pick_result,route,routing_stats --dry-run`,
  then the same command without `--dry-run` (`gbrain doctor` lists the clients
  as `grant_new_ops_available`).
- **Registrations on the starter surface** (what `gbrain setup` writes for stdio
  harnesses) do not include the handoff tools. The agent widens its session
  with `request_tools` and `{"surface": "full"}`; the activation prompt below
  starts with that.

## Activation prompt

Fill in the three placeholders for each agent, then add the prompt to that
app's custom instructions and to a recurring task in the app (see the next
section). `<AGENT_NAME>` is the name the agent uses on every call (lowercase,
for example `claude`, `chatgpt`, `grok-bot`, `gemini`, `openclaw`, `hermes`);
`<MODEL>` is its model label; `<INTERVAL_MIN>` is how often it checks.

```
You're connected to my gbrain. Your agent name is <AGENT_NAME> and you run on <MODEL>.
If heartbeat or inbox is not in your gbrain tools, call request_tools with {"surface": "full"} first.

Every <INTERVAL_MIN> minutes, and at the start of every chat:
1. Call heartbeat("<AGENT_NAME>").
2. Call inbox("<AGENT_NAME>"). For each task, tell me: "Delegated from <from_agent>: <title>. Want me to take it?" If the task is marked auto_ok, skip asking.
3. Once I say yes (or it's auto_ok): claim_task, then pickup the linked thread for context, do the work, log_turn as you go, then complete_task with the result and any files. If you can't finish, release_task with the reason.
4. Never claim a task addressed to another agent.

During normal chats:
- "Delegate this to X" → delegate(to_agent=X). If I don't name anyone, call route first and suggest the top pick.
- "Send this to a few of you" → fan_out, then show me the results side by side and record my pick with pick_result.
- "Pick up the project about Y from <app>" → find_thread(query=Y, agent=<app>), confirm the match with me, then pickup.
- After every reply → log_turn with a one-to-three-line summary, decisions and open questions.
- "Save my place" → checkpoint.
```

## Schedule the check

Thirty to sixty minutes is a sensible interval. Every check spends your plan's
usage limits even when the inbox is empty: background checks count against
limits the same way chats do. Use the app's own scheduler and give the task a
short prompt such as *"Run your gbrain agent check: heartbeat, then inbox, as
your instructions describe."*

| App | Where the schedule lives |
|---|---|
| Claude | A scheduled task in the Claude app, repeating every `<INTERVAL_MIN>` minutes, with the prompt above |
| ChatGPT | A scheduled task in ChatGPT, repeating at your interval |
| Grok Bot | A routine in Grok Bot that runs the check on your interval |
| Gemini | A scheduled action in Gemini |
| OpenClaw | A cron job in your OpenClaw's scheduler that sends the check prompt to the agent |
| Hermes | `hermes cron create --name gbrain-inbox '*/30 * * * *' 'Run your gbrain agent check: heartbeat, then inbox.'` (see `docs/mcp/HERMES.md`) |

Apps that cannot schedule still pick up delegations at the start of every
chat, because step one of the prompt runs then too.

## From the CLI

```bash
gbrain register-agent claude --model claude-opus-5-5 --capabilities decks,research
gbrain log-turn --agent grok-bot --title "12 Oak St listing deck" --summary "Outline drafted." --entities properties/12-oak-st
gbrain delegate --from-agent grok-bot --to-agent claude --title "Build the deck" --instructions "Ten slides from the outline." --thread-id 12-oak-st-listing-deck
gbrain inbox claude
gbrain claim-task <task_id> --agent claude
gbrain pickup 12-oak-st-listing-deck --agent claude
gbrain complete-task <task_id> --agent claude --result "Deck at decks/12-oak-st."
gbrain routing-stats
```

## Limits

- `heartbeat` writes the agent page at most once a minute; at a 30-minute
  interval that is about 48 small page revisions per agent per day.
- A thread page grows with every turn. Keep turns short; for very long work,
  start a new thread and link the old one as an entity.
- `find_thread` uses the brain's hybrid search with query expansion and
  reranking off. With embeddings configured, the query is embedded; no other
  provider is called on any handoff path.
