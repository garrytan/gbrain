---
title: "GBrain Wikilink Query"
type: guide
created: 2026-06-01
updated: 2026-06-01
source: chatgpt-export
conversation_id: 6a1ce1f8-f6b0-83e8-a5c3-b45c24af6c8e
message_count: 5
tags: [chatgpt, import, code, long-form]
---
# GBrain Wikilink Query

> Conversation ID: 6a1ce1f8-f6b0-83e8-a5c3-b45c24af6c8e
> Created: 2026-06-01T01:36:31Z
> Updated: 2026-06-01T01:37:51Z
> Messages: 5

---

## User

efm real quick we're using gbrain garytan/gbrain on github internally. is he correct that we have to manually label all of our wikilinks and stuff that's not a built-in thing that it could just do? two is this seems like it might almost be more convoluted than just using obsidian. is there any advantage over just using obsidian and are we on the correct path? is there a world where we use both or does that not make sense? 

---

## Assistant

I’ll verify the repo behavior first, then answer the architecture call: GBrain vs Obsidian vs both, specifically for Jovie/internal memory.

---

## Assistant

Mr. White, answer:

## 1. Does GBrain require manual wikilinking?

**Mostly yes for high-quality explicit links.**

GBrain does have auto-link behavior, but the repo describes it as pattern-based: it auto-links when pages contain `[[wiki/people/bob]]`-style references, and it extracts entity refs from markdown/wikilinks/typed-link syntax into graph edges. That means **it is not magically reading arbitrary prose and perfectly deciding all canonical wikilinks by default**. It can infer structure from existing syntax, aliases, and schema rules, but intentional page links still matter. citeturn560734view0

So the practical rule:

| Thing | GBrain can do | You probably still do |
|---|---|---|
| Search notes semantically | Yes | No manual work |
| Index markdown files | Yes | Minimal |
| Follow explicit `[[...]]` links | Yes | You/agents need to create them |
| Create graph edges from typed syntax | Yes | Use conventions |
| Perfectly infer every internal relationship from normal prose | Treat as unreliable | Add links/aliases/facts where important |

The repo also has alias support and page-title boosting, which reduces the need for perfect wikilinks, but that is search/retrieval help, not a full replacement for explicit graph structure. citeturn199582view2

## 2. Is this more convoluted than Obsidian?

**For human note-taking: yes.**

Obsidian is better if the job is:

- write notes fast
- browse visually
- manually curate a vault
- think in public/private markdown
- use a local-first personal knowledge base

GBrain is better if the job is:

- give agents persistent memory
- query across many notes with citations
- synthesize answers instead of returning files
- run background ingestion/enrichment
- manage company/team brain access controls
- turn links/entities/facts into a graph agents can traverse

The repo’s own framing is that “search gives raw pages” while GBrain gives synthesized answers, citations, graph traversal, and gap analysis. That is the advantage over Obsidian-style search/backlinks. citeturn560734view0

## 3. Are you on the correct path?

**Yes, if the goal is agent memory for Jovie.**

For Jovie, the valuable path is:

> **GBrain = machine/agent memory layer**  
> **Obsidian = human-editable knowledge surface**

Do not treat GBrain as “better Obsidian.” Treat it as an **agent memory backend** that can ingest your markdown, resolve people/companies/projects, retrieve context, and write structured knowledge back.

For Jovie specifically, the win is not “nice notes.” The win is that Codex/Claude/Hermes can ask:

- “What did we decide about artist memory?”
- “What are the open product principles for onboarding?”
- “What investor positioning are we using this week?”
- “What context should the agent know before touching this Linear issue?”
- “What old decision conflicts with this new plan?”

Obsidian alone will not reliably do that as an agent substrate.

## 4. Should you use both?

**Yes. Best architecture: both, with markdown as the bridge.**

Recommended setup:

```text
Obsidian vault
  = human-facing canonical notes

GBrain
  = indexed/synced/queryable agent brain

Linear/GitHub/Slack/Gmail/etc.
  = source systems

Agents
  = read GBrain first, write structured updates back
```

### Practical operating model

Use **Obsidian for canonical strategy docs**:

```text
/Jovie/
  Product Vision.md
  Agent Memory Architecture.md
  Onboarding.md
  GTM.md
  Investor Narrative.md
  Decisions.md
```

Use **GBrain for agent operations**:

```text
people/
companies/
projects/
decisions/
meetings/
issues/
research/
```

Use explicit wikilinks only for the stuff that matters:

```md
Jovie’s memory system should route artist context through [[projects/jovie-agent-memory]]
and store long-term artist facts under [[concepts/artist-operating-system]].
```

Do not manually link every noun. Link the **entities you expect agents to reason across**.

## My recommendation

Stay on GBrain, but keep it boring:

1. **Do not over-design the vault.**
2. **Do not manually wikilink everything.**
3. **Create a small linking convention.**
4. **Use Obsidian as the human editor.**
5. **Use GBrain as the agent/search/synthesis layer.**
6. **Have agents add links/facts over time where retrieval failed.**

The correct Jovie path is:

```text
Markdown-first knowledge base
+ Obsidian for humans
+ GBrain for agents
+ schema/light conventions
+ gradual enrichment
```

That gives you the upside without turning memory into a side quest.

---

## User

Well, I'm talking about purely the operation stuff, not products.

---

## Assistant

Mr. White, then I’d narrow the recommendation:

## For pure operations, Obsidian is probably the better primary system

If this is about:

- SOPs
- daily/weekly operating checklists
- hiring notes
- vendor notes
- bar ops
- fundraising process
- investor CRM notes
- content calendar
- personal/company decision logs
- meeting notes
- “what did we decide?”
- “what do I do next?”

Then **Obsidian-first makes more sense**.

GBrain may be useful later, but it is probably too much infrastructure if the goal is simply to keep ops knowledge organized and searchable.

## The main issue with GBrain for ops

Ops knowledge is only valuable if it is:

1. **fast to capture**
2. **easy to edit**
3. **easy to browse**
4. **obvious where things live**
5. **low-friction enough that you keep using it**

Obsidian wins that.

GBrain is more useful when you need agentic retrieval, graph traversal, and structured entity memory. For human operations, that can become a side quest.

## Best setup

Use **Obsidian as the source of truth**.

Use GBrain only as an optional indexing/query layer later.

```text
Obsidian
= where ops knowledge lives

GBrain
= optional agent-readable layer over the same markdown
```

Do this:

```text
/Company Ops
  /SOPs
  /Decisions
  /Meetings
  /Investors
  /Vendors
  /Hiring
  /Finance
  /Content
  /Personal Ops
```

Then use a few lightweight conventions:

```md
status: active
owner: Tim
area: fundraising
last_reviewed: 2026-05-31
```

And simple links only where useful:

```md
Related: [[Investor Pipeline]], [[Weekly Review]], [[Fundraising Narrative]]
```

## Do you need to manually wikilink everything?

No.

For ops, manually linking everything is a trap.

Use wikilinks only for:

- people
- companies
- recurring processes
- major decisions
- core projects
- SOPs you reference often

Example:

```md
After the call with [[Daniel]], update [[Investor Pipeline]] and add next steps to [[Weekly Review]].
```

That is enough.

## Correct path

I’d change the path slightly:

### Use Obsidian now

Because you need operational leverage immediately.

### Keep markdown clean

So GBrain can index it later.

### Add GBrain only when agents need it

Use it when you actually need things like:

- “summarize all investor conversations from the last month”
- “find contradictions across SOPs”
- “brief me before this meeting”
- “turn this messy call transcript into updated ops docs”
- “show every unresolved decision related to fundraising”

## My call

For pure operations:

```text
Obsidian primary.
Markdown canonical.
GBrain optional.
No heavy manual wikilinking.
No custom memory infra unless agents are actively using it.
```

You are directionally correct, but I would **de-risk by making Obsidian the daily driver** and treating GBrain as an agent layer, not the operating system itself.


## See Also
- [[chatgpt/chatgpt_1001tracklisting-search-query]]
- [[chatgpt/chatgpt_2024-election-outcome-query]]
- [[chatgpt/chatgpt_add-gbrain-as-mcp]]
- [[chatgpt/chatgpt_clarify-bronson-depot-query]]
- [[chatgpt/chatgpt_connect-gbrain-to-chatgpt]]
