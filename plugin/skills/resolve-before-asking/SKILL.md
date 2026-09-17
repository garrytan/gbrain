---
name: resolve-before-asking
version: 1.0.0
description: |
  Gate on identity questions to the user. Before any "who is X?" (or role /
  relationship question) reaches the user, exhaust the brain's lookup chain:
  think → search + page read → mounted sources → timeline/graph → web. If
  escalation survives the chain, ask WITH a hypothesis, never a bare unknown.
  Also owns the no-placeholders-at-ingest rule: pages created during bulk
  ingestion get their relationship/role resolved immediately.
triggers:
  - "resolve before asking"
  - "before asking the user"
  - "unidentified contact"
  - "unknown relationship"
  - "should I ask who"
  - "don't know who this is"
  - "to be filled by content analysis"
  - "placeholder on this page"
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
upstream: resolve-before-asking@fc834ee
---

# Resolve Before Asking — Exhaust the Brain Before Bothering the User

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> for the base lookup chain (search → query → get_page → external APIs). This
> skill extends that chain one hop further, to the human boundary: asking the
> user is the LAST resort, after the brain AND external escalation, not a
> shortcut around them.

> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) —
> pages touched by the ingest-resolution section file by primary subject
> (`people/`, `companies/`).

## Purpose

**Never ask the user "who is X?" when the answer already exists in the brain.**

The memory answers before the human is bothered — that is the product promise.
This skill defines the lookup chain that runs before any entity-identification
question is sent to the user, and the escalation format when asking really is
justified.

## The Bug This Kills

The pattern: the agent encounters an entity with a rich brain page — timeline
entries, meeting history, an imported message archive — and instead of reading
them, asks the user "who is X?". This is lazy escalation. It spends the user's
attention on questions the system can answer itself.

Examples of the bug (anonymized):

- **alice-example** — her brain page already carried a role line ("Chief of
  Staff at acme-example") and a long meeting history → the agent still asked.
- **charlie-example** — a thick imported email thread whose subject lines all
  pointed at one shared project → the agent still asked.

## When This Fires

This is a harness-routing convention, not a mechanical guarantee: route here
whenever ANY of these are true —

1. A reply draft contains "who is [name]?" or equivalent.
2. A draft asks about someone's role, relationship, or identity.
3. You are about to present an entity as "unknown" or "unidentified".
4. A brain page has `[To be filled by content analysis]` or similar
   placeholder text.
5. You are composing a list of people and leaving any as "unknown
   relationship".

## The Lookup Chain (run in order; STOP at the first clear answer)

### Step 1: `think` — cross-brain synthesis (solves most cases)

```bash
gbrain think "Who is {entity}? What is their relationship to the user? What role do they play? Use all available context — meetings, timeline, imported archives, facts."
```

`think` synthesizes across ALL brain data. If the entity has a page with
imported-activity stats, timeline entries, and meeting history, `think` will
connect the dots. Over MCP, `entity("{entity}")` first gives a zero-LLM card
(aliases, last-touched, top edges); `synthesize` is the heavy cross-page
answer when the card isn't enough.

**If this returns a clear answer → STOP. Use the answer. Do not ask the user.**

### Step 2: `search` + full page read

```bash
gbrain search "{entity}" --limit 5
gbrain get {entity-slug}
```

What to look for:

- `relationship` field in frontmatter — filled means resolved.
- Role signals repeated in timeline entries ("advisor", "colleague at
  acme-example", "chief of staff").
- Facts table — any role/relationship facts.
- Meeting history — what did they attend? With whom?

**If timeline entries repeat a consistent role → STOP. The role is obvious.
Do not ask the user.**

### Step 3: Query each mounted source the brain actually has

Don't hardcode channels. Check what the brain holds, then query it:

```bash
gbrain sources list
gbrain query "emails with {entity}" --limit 10
gbrain query "meetings with {entity}" --limit 5
```

Whatever is mounted — an email archive, calendar imports, chat transcripts,
meeting notes — a handful of subject lines or meeting titles usually reveals
the relationship:

- Invoice / scheduling / billing subjects → professional services.
- Recurring 1:1 titles with consistent co-attendees → colleague.
- Dinner / weekend-plan messages → personal friend.

### Step 4: Timeline + graph walk

```bash
gbrain timeline {entity-slug} --limit 20
gbrain backlinks {entity-slug}
gbrain graph {entity-slug} --depth 2
```

Dated events, who references this entity, and what it connects to. A person
who back-links from a company page and three meeting pages is not an unknown.

### Step 5: Web search (external escalation, per brain-first)

Only after steps 1–4 return nothing useful. Run a generic web search on
`"{entity name} {company/domain hints accumulated in steps 1-4}"`. Fold
anything found back into the brain page before using it (the brain-ops
read-enrich-write cycle), so the next lookup doesn't repeat the work.

### Step 6: Escalate to the user (LAST RESORT) — ask WITH a hypothesis

Only after ALL previous steps return nothing conclusive:

- State what you searched.
- State what you found — even partial signals.
- Ask a SPECIFIC, confirmable question: not "who is X?" but "Is {entity} the
  {best guess assembled from partial signals}?"

Use [ask-user](../ask-user/SKILL.md) for the choice-gate mechanics (2–4
options, escape hatch, stop the turn).

## Confidence Thresholds

- **High confidence (don't ask):** `think`/`synthesize` gives a clear answer,
  OR 3+ timeline entries carry a consistent role description, OR the page's
  relationship field is filled.
- **Low confidence (ask, leading with your best guess):** contradictory
  signals or very sparse data. Ask — but the question opens with your
  hypothesis, and states the contradiction if there is one.

There is no third state. Either the brain answered (use it) or it didn't
(finish the chain, then ask with a hypothesis).

## No Placeholders at Ingest

When ANY ingestion pipeline (email import, calendar enrichment, chat
transcripts, meeting ingestion) creates or significantly updates a person or
company page, resolve the entity's identity and relationship immediately —
never leave placeholder text. Pages like

- `[To be filled by content analysis]`
- `> Contact from the user's personal network.`
- an empty `## Context` section

are bugs, especially when the ingestion batch itself contains hundreds of
signals about who the person is. Run this as a post-ingestion pass over every
page the batch created or updated:

1. **Check for placeholders.** Scan the touched pages for markers
   (`[To be filled`, `Unknown relationship`, `TBD`). No placeholders AND
   relationship filled → skip, already resolved.
2. **Run the chain** (steps 1–4 above; at ingest time, step 1 alone usually
   suffices because the batch just wrote the signals `think` needs).
3. **Extract:** relationship type (friend / colleague / advisor / family /
   founder), professional role (title + company), key context (how they know
   the user, what era).
4. **Update the page** (`put_page`): fill the `relationship` frontmatter
   field, replace the placeholder description with a real one-liner, update
   the `## Context` or intro paragraph.
5. **Batch efficiency** for bulk runs (100+ pages): resolve in batches of
   10–20; prioritize by captured-activity volume (more activity = more likely
   the user meets this name in a briefing); skip pages already substantive.

### Email-domain shortcut (hypothesis generator, not proof)

Before running the chain, the sender's domain often seeds the hypothesis:

| Domain shape | Hypothesis |
|---|---|
| `@acme-example.com` — a company already in the brain | Likely acme-example employee. Confirm against the company page + shared meetings, then fill. |
| Corporate domain NOT in the brain | New company. Run the chain; consider seeding a `companies/` page. |
| Personal domain (gmail, etc.) | No shortcut — run the full chain. |

### Quality bar

A resolved page passes this test: if the user encounters the name in a
briefing, triage, or meeting prep, the page's first line says who they are
WITHOUT the user needing to ask.

- Bad: `> Contact from the user's personal network.`
- Good: `> Operations lead at acme-example — handles invoicing and vendor
  onboarding for the user.`

## Contract

This skill guarantees:

- No identity/role/relationship question reaches the user until the lookup
  chain (steps 1–5) has run for that entity.
- Every escalation states what was searched, what was found, and leads with a
  hypothesis — never a bare "who is X?".
- No placeholder text survives an ingestion batch on pages this skill touches;
  relationship/role fields are filled at write time.
- Writes land only under the `writes_to:` directories, filed by primary
  subject per `_brain-filing-rules.md`.
- Privacy contract preserved: no real names, no fork-specific filesystem path
  literals, no upstream-fork references in examples.

## Output Format

Two possible outputs:

**(a) Resolved silently** — the identity is used in the current flow; if a
page had a placeholder, it is filled (`put_page`) as a side effect. No message
to the user about the lookup.

**(b) Escalation with a hypothesis** — formatted per the ask-user choice gate:

```
🔀 **Is {entity} the {best guess}?**

Searched: think, search + page read, mounted sources, timeline/graph, web.
Found: recurring invoices from @widget-co.com; two meetings alongside the
acme-example team. Nothing names their role directly.

1. **Confirm** — {entity} is {best guess}
2. **Correct me** — it's someone else (tell me who)
3. **Skip** — leave unresolved for now
```

After emitting the gate, stop the turn (see ask-user).

## Anti-Patterns

- ❌ "Who is X?" with no prior lookup.
- ❌ "What's their relationship to you?" when the brain page has dozens of
  timeline entries.
- ❌ Presenting a list of unknowns without running the chain on each one.
- ❌ Leaving `[To be filled by content analysis]` on a page whose ingestion
  batch carried hundreds of signals.
- ❌ Asking about someone whose email address names their employer
  (`jane@acme-example.com`).
- ❌ Using `memory_search` for entity lookups — memory tools search session
  notes, not the brain knowledge graph; brain-first.md bans this. Use
  `search` / `query` / `entity`.
- ❌ Treating a nonzero `search` hit count as chain-complete — read the page;
  run `query` for synonym phrasings before concluding "not in the brain".
- ❌ Escalating with false confidence: partial signal is a hypothesis, not a
  resolution. If signals contradict, the escalation states the contradiction.

## Dedup (sharp boundaries)

- **[query](../query/SKILL.md)** — owns the lookup verb mechanics (3-layer
  search, synthesis, citations) for answering the user's questions. This
  skill consumes those same tools but owns a decision, not a lookup: WHETHER
  an identity question is allowed to reach the user at all.
- **[brain-ops](../brain-ops/SKILL.md)** — owns the general read-enrich-write
  cycle for every brain interaction. This skill is the gate on one specific
  exit ramp of that cycle: the identity question to the human.
- **[ask-user](../ask-user/SKILL.md)** — owns HOW to ask (choice-gate format,
  option limits, stopping the turn). This skill owns WHETHER asking is
  justified and WHAT the question must contain (searched / found /
  hypothesis).
- **[enrich](../enrich/SKILL.md)** — owns creating and updating entity pages
  with the tiered enrichment protocol. The "No Placeholders at Ingest"
  section here is the acceptance bar those writes must meet; when a
  placeholder needs filling, run this skill's chain, then write via the
  enrich/brain-ops conventions.
- **[conventions/brain-first.md](../conventions/brain-first.md)** — owns
  brain-before-external-API ordering for all lookups. This skill inherits
  that ordering and adds the final boundary: external-before-human.
- A dedup-before-create entity guard (phonetic/alias matching before a new
  page is created) is a DIFFERENT failure class — that guard prevents
  duplicate pages at write time; this skill prevents needless questions at
  ask time. Cross-reference, don't merge, if/when it ships.

## The Standard

Would the user look at this person's brain page — the imported archive, the
employer-revealing email domain, the timeline entries all repeating the same
role — and think it was reasonable that the agent asked who this person is?

If the answer is no, the chain wasn't run. Run it.
