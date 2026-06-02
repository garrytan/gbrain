---
title: "Memory and Agent Workflow"
type: essay
created: 2026-05-31
updated: 2026-05-31
source: chatgpt-export
conversation_id: 6a1bc529-6df8-83e8-9339-f62598ef7561
message_count: 20
tags: [chatgpt, import, code, long-form]
---
# Memory and Agent Workflow

> Conversation ID: 6a1bc529-6df8-83e8-9339-f62598ef7561
> Created: 2026-05-31T05:20:42Z
> Updated: 2026-05-31T22:29:48Z
> Messages: 20

---

## User

I'm just thinking about Jovi and um And what I want to just figure out right now is like, memory is the biggest thing. Memory makes everything better. Um, And also, um, what our agent workflow should be. I really would like to look and see, like, should it be agent SDK or should it be Trigger.dev? I need to make a decision today because we have issues that are about to ship with Trigger.dev and I'm wondering if that's not the move. Because we've talked about Versal workflows, we've talked about Trigger, there's Cloudflare stuff, there's all kinds of options now. There's, um, Anthropic has an SDK, um, OpenAI has an SDK and OpenAI one actually looks kind of good, and I'm just wondering if we should be building our own harness or if we should be leaning on another harness, um, and just, you know what I mean? Like, I don't know that it necessarily makes sense to recreate what OpenAI has already done for us, is kind of what I'm getting at. Um, and I wonder if this Versal thing is even gonna be competitive. I don't know, just... I wanna make sure that, like, I've previously described kind of how memory works, should work, and all this stuff, but... The high level of it is basically I want to be able to do things where like any entity that gets mentioned gets enriched constantly, every time it gets enriched, and then anytime, and then just generally, right? So like, currently, you can type into the chat and you can tag a song of yours, or you can tag an artist, and those show as rich chips. I want you to be able to tag any people and other kinds of entities. And so I want you to be able to say, okay, we went through and we found a photo of you and Steve Aoki. Boom, we tagged Steve Aoki, right? Now, Joby knows there's an association with you and Steve Aoki. Well, that's cool. We can go get Steve Aoki's, we can use XR or something and go out to the web and get Steve Aoki's information, right? We can, we should pull his wiki, we should pull his socials, right? And then when we go and post that photo, oh, we have his socials, we can tag him, right? Properly on the social platforms. But then we can do things like, oh, it's his birthday. Now, let's surface a photo to post with him, right? But also, then we could do things like, oh, Randy Jackson, right? Oh, we saw Randy Jackson in your email. Well, okay. But then we also found a photo of him. Okay, let's put that together. Well, now we should enrich that, right? And then we should be like, okay, well, what else data do we have with Randy? Well, oh, Randy's in your email, and also the email mentions a studio session. So let's go to the calendar for that date. Oh, boom, we found the studio session. It's got a location. The photo also matches that location. The location's Jim Henson Studios. That's an entity. So now we tag that entity and we create a link, right? Now, anytime Jim Henson Studios comes up in the zeitgeist, anytime Randy Jackson comes up in the zeitgeist, these are things that we have assets. Oh, here's a video from that studio session that doesn't even have Randy in it. Here's a photo of you and Kermit the Frog from the bathroom at Jim Henson Studios. Here's a photo of you and Randy together. Randy's birthday, any time. Randy, then we should pull in, oh, American Idol, that's his company, right? So now we know American Idol, boom, anytime American Idol is mentioned, we should now be able to be like, okay, Randy Jackson, you know what I mean? And then, okay, you know, he's in his email. Okay, maybe Randy, then there's, you know, maybe we mentioned a song, right? Well, now that song should become an entity. And now later, we have the master files, okay, that can get tagged to that. Oh, and then a split sheet comes along, and then boom, it's tagged. Oh, and there's another writer on the song. So now that writer gets associated with all this content, right? And then, okay, now the song gets released and it's time to put it out, well, now we need content. Well, oh, here's, we know the date of the studio session. Go to that date for our voice memos. Here's a bunch of voice memos. Let's parse those voice memos and find interesting clips. Oh, there's a clip of you actually singing the first line of the song. Let's take that and then take the first line of the song from the actual master, mash them together in a before-after TikTok video, and boom, you've got some viral social content. And we can overlay this B-roll of you and Randy together, right? I mean, like, this is how you create, this is how you create game-changing content, what I described right there. And it's all done by memory and all it takes is memory and connectors that pull in those different things, right? And then some skills to make that content. So kind of like based on what I told you of where I'd like this thing to go, think about what's the best way we can ship fast with it. I'm thinking that like maybe we should just be doing Composeo or something so that we can ship a shit ton of connectors and we can slowly replace them with our own proprietary ones later. Ship with like some kind of harness out the gate, like Agent SDK or whatever Anthropic has or any of these. And then... Some kind of memory layer. I don't know if it's Honcho. I don't know if it's G-brain and our own database or something. I don't know if it's like vectorized or something or vertex or something in the cloud and Cloudflare. I don't know if it's like a proprietary memory layer or we have our own database or how I have no idea how to think about these things, but what I want you to do is kind of think about that, what that world-class workflows will look like, work backwards, and then spit out to me exactly what we should be shipping now in order to make this happen.

---

## Assistant

Mr. White, I’ll treat this as a same-day shipping decision: verify the current tooling, map it to your entity-memory graph, then recommend what to ship, avoid, and defer.

---

## Assistant

Early read: keep the agent harness and durable workflow runner separate. The defensible layer is your product-owned entity-memory graph, while SDKs and runners can remain swappable.

---

## Assistant

Mr. White,

## Same-day decision

**Ship with Trigger.dev as the durable workflow runner, OpenAI Agents SDK as the agent harness, and your own Jovie Memory Core as the source of truth.**

Do **not** pivot the current Trigger.dev work to Vercel Workflows, Cloudflare Workflows, Anthropic Managed Agents, or a fully custom harness today.

The right split is:

| Layer | Decision | Why |
|---|---:|---|
| **Durable workflows** | **Trigger.dev now** | You already have work about to ship; it handles long jobs, retries, queues, waits, callbacks, human checkpoints, observability, and runtime flexibility. |
| **Agent loop / tool calling** | **OpenAI Agents SDK** | It gives you agent primitives, tools, handoffs, guardrails, tracing, MCP support, sessions, and human-in-the-loop patterns without building your own loop. |
| **Connectors** | **Connector interface + selective Composio** | Use Composio to move fast on read-only/low-risk integrations, but keep it behind your own abstraction and avoid betting core OAuth/write flows on it immediately. |
| **Memory** | **Own the memory layer** | Jovie’s moat is the entity graph, provenance, permissions, asset links, and enrichment history. External memory tools can help indexing, but they should not own your canonical truth. |
| **Vector search** | **pgvector first; optional Graphiti/Zep later** | Vector search helps retrieval, but your real product needs a temporal entity/event/asset graph. |

---

## The key architecture point

**Agent SDKs and workflow systems solve different problems.**

The **OpenAI Agents SDK** is for deciding, calling tools, handing off between agents, tracing, using MCP tools, guardrails, sessions, and human approvals. OpenAI’s docs describe the SDK around agents, handoffs, guardrails, function tools, MCP, sessions, tracing, and human-in-the-loop support. citeturn684073view0turn684073view2turn684073view3turn684073view1

**Trigger.dev** is for keeping jobs alive and reliable: long-running work, retries, queues, idempotency, waits, callbacks, observability, versioning, human checkpoints, and runtime freedom for things like FFmpeg, browsers, Python scripts, and media jobs. That maps very directly to Jovie’s ingestion, enrichment, correlation, and content-generation workflows. citeturn990899view1turn990899view3turn990899view2

So the answer is **Trigger.dev plus OpenAI Agents SDK**, rather than one replacing the other.

---

## My recommendation

### 1. Keep Trigger.dev

Do not rip it out today.

Use Trigger as the **durable execution spine** for:

- ingesting photos, videos, voice memos, emails, calendar events, files, and chat mentions
- running enrichment jobs
- retrying flaky APIs
- waiting on OAuth callbacks
- waiting on user approvals
- running long media generation jobs
- coordinating multi-step workflows like “photo → person → email → calendar → location → song → opportunity”
- maintaining observability around each pipeline run

Trigger’s strongest fit for Jovie is that your workflows will be **messy, long-running, integration-heavy, and media-heavy**. A lot of agent frameworks look good in clean demos. Jovie’s real workflows will hit rate limits, broken APIs, missing metadata, bad entity matches, failed transcodes, OAuth refresh issues, and human approval branches. Trigger is built closer to that reality.

### 2. Use OpenAI Agents SDK inside Trigger tasks

Use OpenAI Agents SDK for the **reasoning and tool-use layer**, especially:

- entity extraction
- entity disambiguation
- enrichment planning
- opportunity generation
- content ideation
- multi-step research
- retrieval synthesis
- “why this matters” explanations
- tool approval boundaries

Do **not** let the agent directly mutate canonical memory. The agent proposes observations and links. Deterministic code validates, scores, dedupes, and writes.

The clean pattern:

```txt
Trigger task starts
  → load source record
  → call OpenAI Agent SDK for extraction/planning
  → validate structured output
  → write candidate observations
  → resolver merges/dedupes entities
  → enrichment jobs fan out
  → memory compiler updates entity/event cards
  → opportunity engine evaluates triggers
  → approval item created for user
```

This gives you the benefit of OpenAI’s harness without turning your database into an agent scratchpad.

### 3. Keep Vercel Workflows as a 30-day evaluation, not today’s pivot

Vercel Workflows is real and competitive. It is generally available, supports TypeScript/Python workflows, durable steps, retries, persistence, observability, waits, hooks, streaming, external events, and durable agent patterns. citeturn554810view4

It may become attractive if Jovie is deeply Vercel-native and you want workflow execution close to your web app. But switching today would cost focus. The right move is to put Trigger behind a small internal interface:

```ts
interface WorkflowRunner {
  start(name: string, payload: unknown): Promise<RunId>
  waitForEvent(runId: RunId, event: string): Promise<void>
  emit(event: string, payload: unknown): Promise<void>
}
```

Then you can evaluate Vercel Workflows later without rewriting product logic.

### 4. Use Cloudflare selectively

Cloudflare Workflows is useful for Workers-native, edge-adjacent, durable multi-step work with automatic retries and persisted state. Cloudflare Vectorize is useful for semantic search near Workers. citeturn821624search1turn821624search2turn270660search3

For Jovie, Cloudflare is probably better for:

- edge ingestion
- webhook handling
- lightweight enrichment
- asset delivery
- R2 storage
- maybe vector search if you go Cloudflare-heavy

It should not be the main orchestration choice today for complex media, connector, and agent workflows.

### 5. Treat Anthropic Managed Agents as interesting, not core

Anthropic’s Agent SDK and Managed Agents are promising, especially for coding-style agents, sandboxed environments, long-running agents, sessions, and memory stores. Their docs describe Claude Code as a programmable agent SDK with tools, context management, and sessions; Managed Agents add cloud/self-hosted sandboxing and persistent sessions. citeturn405057view0turn405057view1turn175157search0

Their memory-store direction is interesting, but it is document-store-like memory with constraints and beta surface area. It is not the canonical memory system for Jovie’s entity graph, assets, rights, user permissions, evidence, and cross-connector provenance. citeturn377269search0turn377269search7

Use Anthropic where Claude is best. Do not architect Jovie Memory around Anthropic Managed Agents.

---

## Composio decision

**Use Composio, but narrowly and behind your own connector abstraction.**

Composio gives you speed: 1,000+ toolkits, many thousands of tools, per-user authentication, OAuth/API key handling, triggers, and MCP/direct API access. citeturn422784view1turn422784view2turn422784view3

But I would not make Composio the trusted core of Jovie’s connector layer yet. Composio disclosed a May 2026 security incident and recommended precautionary credential actions, including OAuth revocation and API-key rotation/deletion steps. citeturn422784view0

Use it this way:

| Connector type | Use Composio? | Reason |
|---|---:|---|
| Read-only prototypes | **Yes** | Fast learning. |
| Low-risk enrichment tools | **Yes** | Good acceleration. |
| Gmail/Calendar MVP | **Maybe** | Acceptable for prototype if scoped read-only and auditable. |
| Social posting | **No at first** | Too sensitive; build native once you know exact needs. |
| Google Photos / iCloud / high-value media | **Prefer native** | Core user trust surface. |
| Music distribution, rights, royalty, payments | **Native** | Too central to outsource blindly. |

Build:

```ts
interface ConnectorProvider {
  connect(userId: string, provider: Provider): Promise<AuthSession>
  listRecords(userId: string, cursor?: string): Promise<SourceRecord[]>
  getRecord(userId: string, externalId: string): Promise<SourceRecord>
  subscribe?(userId: string): Promise<WebhookSubscription>
}
```

Then implement:

```txt
ComposioConnectorProvider
GoogleNativeConnectorProvider
InstagramNativeConnectorProvider
DropboxNativeConnectorProvider
LocalUploadConnectorProvider
```

This lets you ship connectors fast while preserving the option to replace them.

---

# The memory architecture you actually need

The product you described is **not “chat memory.”** It is a **temporal, permissioned, evidence-backed knowledge graph over people, places, songs, assets, events, files, conversations, and opportunities.**

Vector search alone will not solve this. Agent session memory will not solve this. A generic memory provider will not solve the core moat.

You need a canonical memory model.

## Jovie Memory Core

Start with Postgres as the system of record.

Use:

- **Postgres** for canonical entities, relationships, observations, events, permissions, and audit logs
- **pgvector** for semantic retrieval over text, image captions, transcripts, emails, notes, and entity summaries
- **Object storage** for raw media, extracted frames, audio, transcripts, documents, and source blobs
- **Trigger.dev** for ingestion/enrichment/correlation jobs
- **OpenAI Agents SDK** for extraction, reasoning, and planning
- **Optional Graphiti/Zep later** as a secondary temporal graph/retrieval index

pgvector is a practical default because it keeps vector similarity search inside Postgres alongside the rest of your data. citeturn103980search0turn103980search3

Graphiti/Zep is worth evaluating because it is designed around temporal entity/fact graphs, changing facts, provenance, and hybrid retrieval across vector, keyword, and graph traversal. citeturn270660search1turn270660search8turn270660search23

Honcho is also relevant because it is built around stateful agents, entities, users, agents, groups, relationships, and changing memory over time. It may be useful as an experiment, but I would not put it in charge of Jovie’s canonical asset/entity system. citeturn270660search0turn270660search22

GBrain is philosophically close to what you want: ingestion across emails, meetings, voice, people, companies, and overnight memory consolidation. Treat it as inspiration for the “compiled brain” pattern, not as a drop-in product substrate. citeturn124468search12

---

# Canonical schema to ship now

Ship this as **Memory Core v0**.

## Core tables

```txt
source_records
  id
  user_id
  connector
  external_id
  source_type          // email, calendar_event, photo, video, audio, chat, file, web, social
  raw_uri
  captured_at
  observed_at
  permissions_scope
  checksum
  metadata_json

assets
  id
  user_id
  source_record_id
  asset_type           // photo, video, audio, document, master, stem, split_sheet
  storage_uri
  perceptual_hash
  transcript_id
  caption
  captured_at
  location_id
  metadata_json

entities
  id
  user_id
  entity_type          // person, artist, song, location, company, event, project, platform, asset
  display_name
  canonical_slug
  confidence
  status               // candidate, confirmed, rejected, merged
  created_at
  updated_at

entity_identities
  id
  entity_id
  provider             // instagram, spotify, wikidata, musicbrainz, gmail, contacts, imdb, etc.
  external_id
  handle
  url
  confidence
  verified_status

entity_aliases
  id
  entity_id
  alias
  source_record_id
  confidence

observations
  id
  user_id
  subject_entity_id
  predicate
  object_entity_id
  value_json
  source_record_id
  confidence
  observed_at
  valid_from
  valid_to
  extractor_version
  review_status        // proposed, accepted, rejected

entity_edges
  id
  user_id
  from_entity_id
  to_entity_id
  edge_type            // knows, collaborated_with, appeared_with, wrote_song, recorded_at, attended
  source_observation_id
  confidence
  valid_from
  valid_to

asset_entity_mentions
  id
  asset_id
  entity_id
  mention_type         // face, tag, caption, transcript, metadata, email_reference
  bounding_box_json
  timestamp_start
  timestamp_end
  confidence

events
  id
  user_id
  event_type           // studio_session, release, meeting, show, birthday, campaign
  title
  start_at
  end_at
  location_entity_id
  confidence
  source_record_id

event_participants
  id
  event_id
  entity_id
  role                 // attendee, artist, producer, writer, photographer, location

enrichment_jobs
  id
  entity_id
  job_type             // wikidata, socials, birthday, musicbrainz, contacts, web_search
  status
  priority
  last_attempt_at
  result_json

opportunities
  id
  user_id
  opportunity_type     // birthday_post, release_content, throwback, trend_response, relationship_reactivation
  title
  reason_json
  related_entities
  related_assets
  suggested_actions
  status

approval_items
  id
  user_id
  action_type
  proposed_payload_json
  risk_level
  status
  approved_by
  approved_at

memory_snapshots
  id
  entity_id
  summary
  facts_json
  open_questions_json
  updated_at
```

The most important design rule:

> **Every memory fact must point back to evidence.**

A memory without provenance is a liability. Jovie should always know:

```txt
What do we believe?
Why do we believe it?
Where did it come from?
How confident are we?
Who is allowed to see it?
When was it true?
What changed?
```

That is the difference between a toy assistant and a real creator operating system.

---

# The workflow model

## Deterministic spine, agentic edges

Use deterministic code for:

- persistence
- permissions
- entity merges
- job scheduling
- retries
- connector sync
- dedupe
- audit trails
- publishing gates

Use agents for:

- extraction
- reasoning
- enrichment planning
- relationship inference
- summarization
- opportunity generation
- content ideation

The agent should produce structured proposals like:

```json
{
  "entities": [
    {
      "type": "person",
      "name": "Randy Jackson",
      "confidence": 0.82,
      "evidence": ["email_123", "photo_456"]
    }
  ],
  "events": [
    {
      "type": "studio_session",
      "title": "Studio session at Jim Henson Studios",
      "participants": ["Randy Jackson"],
      "location": "Jim Henson Studios",
      "confidence": 0.76
    }
  ],
  "relationships": [
    {
      "from": "Randy Jackson",
      "type": "appeared_with",
      "to": "Tim",
      "source": "photo_456"
    }
  ]
}
```

Then your resolver decides whether that becomes canonical memory.

---

# The first product workflow to ship

Ship one killer workflow end-to-end instead of ten partial abstractions.

## “Memory from a studio session”

Input:

- user tags a person in a photo
- photo has timestamp/location
- Gmail and Calendar are connected
- voice memos or files may exist around the same date

Pipeline:

```txt
1. Photo ingested
2. Vision model captions photo and extracts people/location/context
3. User or model tags Randy Jackson
4. Jovie creates/updates Person entity: Randy Jackson
5. Enrichment job pulls public info, socials, birthday, known roles
6. Correlator searches nearby calendar events
7. Correlator searches nearby emails
8. Location resolver identifies Jim Henson Studios
9. Jovie creates Event entity: studio session
10. Jovie links:
    - Tim ↔ Randy
    - Randy ↔ studio session
    - studio session ↔ Jim Henson Studios
    - photo ↔ Randy
    - photo ↔ studio session
11. Jovie searches voice memos from that date
12. Transcription finds useful clips
13. Opportunity engine proposes:
    - birthday post
    - throwback post
    - release promo
    - before/after TikTok
14. User sees “why Jovie thinks this”
15. User approves content generation
```

This is the demo that proves the company.

---

# What should ship now

## Week-zero implementation plan

### 1. Keep the current Trigger.dev issues

But define them as infrastructure, not product logic.

Ship:

```txt
packages/workflows
  triggerRunner.ts
  workflowEvents.ts
  workflowSchemas.ts
```

All workflows should be named and versioned:

```txt
memory.ingest.source_record.v1
memory.extract.entities.v1
memory.resolve.entity.v1
memory.enrich.entity.v1
memory.correlate.event.v1
memory.generate.opportunity.v1
content.generate.asset_plan.v1
content.await_approval.v1
content.publish.v1
```

### 2. Add OpenAI Agents SDK as `AgentHarness`

Do not scatter direct SDK calls everywhere.

Create:

```txt
packages/agents
  AgentHarness.ts
  OpenAIAgentHarness.ts
  prompts/
  schemas/
  tools/
```

Interface:

```ts
interface AgentHarness {
  extractEntities(input: SourceRecord): Promise<EntityExtractionResult>
  inferRelationships(input: RelationshipContext): Promise<RelationshipProposal[]>
  generateOpportunities(input: MemoryContext): Promise<OpportunityProposal[]>
  planContent(input: ContentBrief): Promise<ContentPlan>
}
```

This keeps you free to use Claude, Gemini, local models, or Vercel AI SDK later.

### 3. Build Memory Core v0

Ship the schema above, but start with these tables first:

```txt
source_records
assets
entities
entity_identities
observations
entity_edges
asset_entity_mentions
events
event_participants
enrichment_jobs
opportunities
approval_items
```

Add pgvector columns to:

```txt
source_records.embedding
assets.embedding
entities.summary_embedding
observations.embedding
```

### 4. Generalize rich chips

Current state: songs/artists can be tagged as rich chips.

Next state:

```txt
@Person
@Artist
@Song
@Location
@Company
@Studio
@Event
@Project
@Asset
@File
@Release
```

Every chip creates either:

```txt
confirmed entity
```

or:

```txt
candidate entity + observation
```

This is the lowest-friction way to train the memory graph with user intent.

### 5. Build connector abstraction before Composio

Do not wire Composio directly into product logic.

Ship:

```txt
packages/connectors
  ConnectorProvider.ts
  ComposioConnectorProvider.ts
  NativeGoogleConnectorProvider.ts
  LocalUploadConnectorProvider.ts
```

Use Composio for:

- Gmail read-only
- Calendar read-only
- Slack/Notion/Drive prototypes
- enrichment tools

Use native connectors for:

- user media libraries
- social publishing
- high-volume Gmail/Calendar once validated
- any connector central to the product moat

### 6. Ship the first enrichment set

Start with:

```txt
person.enrich.public_profile
person.enrich.social_handles
person.enrich.birthday
location.enrich.place_profile
song.enrich.music_metadata
company.enrich.public_profile
```

For artists and songs, eventually add:

```txt
Spotify
Apple Music
MusicBrainz
Discogs
Genius
ASCAP/BMI/SESAC where feasible
YouTube
TikTok
Instagram
```

But the v0 should simply prove that an entity can be enriched repeatedly and safely.

### 7. Build the opportunity engine

This should be mostly deterministic at first.

Rules:

```txt
If person birthday within 14 days
  and user has high-confidence asset with person
  → create birthday_post opportunity

If song release date within 30 days
  and song has studio_session event
  and session has voice memos/photos/videos
  → create release_content opportunity

If location is trending or mentioned in user context
  and user has assets at location
  → create location_throwback opportunity

If person appears in email/calendar/photo
  and no recent interaction
  → create relationship_reactivation opportunity
```

Agents can rank and explain opportunities. Rules should create the first draft.

---

# What to avoid

## 1. Do not build your own agent harness from scratch

You will waste time recreating:

- tool calling
- tracing
- retries around tool calls
- handoffs
- guardrails
- MCP compatibility
- human approval state
- structured outputs
- session handling

Use OpenAI Agents SDK for this layer.

## 2. Do not use OpenAI/Anthropic memory as Jovie Memory

Agent sessions are useful working memory. Jovie Memory is product memory.

Your core memory has to understand:

- assets
- rights
- people
- songs
- sessions
- files
- masters
- split sheets
- locations
- campaigns
- permissions
- provenance
- confidence
- time
- social handles
- publishing outcomes

That is your database.

## 3. Do not make vectors the memory layer

Vectors answer:

```txt
“What is semantically similar to this?”
```

Jovie needs to answer:

```txt
“Which assets include Randy Jackson, were created at Jim Henson Studios, relate to this unreleased song, include usable voice memo material, and are safe to suggest for a birthday post?”
```

That requires graph + metadata + permissions + temporal evidence.

## 4. Do not let agents directly merge entities

Entity resolution should be controlled.

Bad:

```txt
Agent decides Randy Jackson in email = Randy Jackson in photo = American Idol Randy Jackson and writes it permanently.
```

Good:

```txt
Agent proposes match.
Resolver scores it.
User confirmation or high-confidence evidence promotes it.
All evidence remains attached.
```

## 5. Do not give Composio broad write scopes early

Use read-only scopes first. Add write scopes only after:

- connector abstraction exists
- audit logs exist
- approval gates exist
- per-user permission boundaries exist
- token revocation flows exist
- native replacement path exists

---

# Final stack

## Ship now

```txt
Frontend / app:
  Next.js / existing Jovie app

Durable workflows:
  Trigger.dev

Agent harness:
  OpenAI Agents SDK

LLM/provider abstraction:
  AgentHarness interface
  optional Vercel AI SDK later for provider routing

Connectors:
  ConnectorProvider interface
  Composio for fast read-only prototypes
  native connectors for core surfaces

Memory:
  Postgres
  pgvector
  object storage
  explicit graph tables
  observations/provenance/audit log

Media:
  FFmpeg-capable workers through Trigger
  object storage for raw and derived assets

Retrieval:
  SQL filters first
  graph traversal second
  vector search third
  agent synthesis last

Approvals:
  approval_items table
  Trigger waitpoints / human checkpoints
```

## Evaluate later

```txt
Vercel Workflows:
  Revisit after v0 if Vercel-native workflows become materially simpler.

Cloudflare Workflows:
  Use for edge/webhook/lightweight jobs, not core memory orchestration yet.

Graphiti/Zep:
  Evaluate as secondary temporal graph index after Memory Core v0 exists.

Honcho:
  Evaluate for agent/user memory behavior, not canonical asset memory.

Anthropic Managed Agents:
  Use for specialized Claude workflows or research/coding agents, not core memory.
```

---

# The decision in one sentence

**Continue shipping Trigger.dev, add OpenAI Agents SDK inside it, build Jovie’s own evidence-backed entity memory in Postgres/pgvector, use Composio only behind a connector abstraction, and focus the next release on one end-to-end memory workflow that turns scattered assets into a content opportunity.**

---

## User

OK, what I'd like you to do now is ground this in Jovie's actual architecture currently and then end linear issues and stuff and what needs to happen. I want you to give me a giant spec prompt I can give to Codex and have it spin up sub-agents to take us from where we are to what I just described, laying out all that in front of everything. Have it use a swarm in isolated work trees and assign them all scopes, issues, and stuff for this. Have it go and turn this into a shipped thing. Explicitly describe what should be built now and what should be deferred with an issue open and then assigned. Have it triage the existing issues and update them or delete them or replace them based on any changes that are going to happen to the stack here. Do keep in mind that our Postgres is on neon and stuff like that. Make all those recommendations and the implementation plan, and then let's start going. 

---

## Assistant

I’ll ground this against the live repo and Linear state first, then turn it into a Codex-ready orchestration prompt with scoped sub-agents, migration boundaries, and issue triage instructions.

---

## Assistant

The repo already has many needed seams: pnpm/turbo, Next 16, Neon/Drizzle, connector/workflow/agent tables, existing ingestion, and guarded migrations. I’m checking schema, Trigger/Hermes, chat, and Linear next.

---

## Assistant

Mr. White, I’m grounding this against the repo and Linear before writing the Codex prompt. One finding: the AgentOS ADR’s Vercel-primary choice applies to internal ops, not the creator-memory runtime.

---

## Assistant

I found Jovie already has a partial connector/memory substrate on Neon with Google OAuth, Gmail/Calendar paths, workflow and agent run tables, plus a Vercel dry-run proof. The immediate work is a stack correction and schema fix, especially the Google provider enum mismatch, rather than a greenfield rebuild.

---

## Assistant

I created the Memory Core / Content Engine Linear project and found the key repo constraint: internal AgentOS stays WDK/Vercel-oriented, while customer-facing memory workflows get a scoped Trigger.dev path.

---

## Assistant

Created the Linear project **Memory Core / Content Engine** and started translating the plan into scoped work against Jovie’s current Neon/Drizzle repo architecture.

---

## Assistant

I created the new Linear project and parent v0 issue, and I’m converting the architecture into scoped child tickets with current repo constraints included.

---

## Assistant

I found a repo-level architecture conflict: AgentOS currently prefers WDK/Vercel Workflow, while Jovie Memory should use Trigger. I separated Memory Core into its own Linear project.

---

## Assistant

I’ve created the urgent Linear project and parent v0 issue, and I’m turning the architecture decision into scoped child issues. I’m also reconciling older AgentOS, Trigger, Vercel, and WDK tickets so Codex follows one stack direction.

---

## Assistant

I created a Linear project and parent shipping issue for the customer-facing Memory Core path, separate from internal AgentOS WDK/runtime experiments. The repo already has WDK and Vercel workflow artifacts, while connector and memory primitives live in `apps/web`.

---

## Assistant

I created the new Linear project and parent issue, then started breaking the architecture decision into milestones and actionable tickets while triaging older WDK/Trigger items.

---

## Assistant

I’ve created the Linear project and parent issue for the Memory Core / Content Engine track, and I’m converting the stack decision into scoped child issues. Next I’m reconciling older AgentOS, Trigger, and WDK issues so Codex gets a clean queue.

---

## Assistant

I created the new Linear project and parent issue, then started breaking it into implementation slices and triaging older WDK/Trigger AgentOS tickets into a cleaner Codex queue.

---

## Assistant

I also found a concrete repo blocker: connector tables and Google OAuth exist, but the connector enum lacks `gmail` and `google_calendar`. That should be M0 before broader memory workflows.

---

## Assistant

I created the Linear project, milestones, and parent issue, then canceled a duplicate schema issue from a retry. I’m filling the implementation queue and reconciling older Trigger/WDK issues into a clean Codex execution graph.


## See Also
- [[chatgpt/chatgpt_orchestrator-agent-workflow]]
- [[chatgpt/chatgpt_agent-first-strategy-for-jovie]]
- [[chatgpt/chatgpt_agent-mode-prompt]]
- [[chatgpt/chatgpt_agent-orchestration-summary]]
- [[chatgpt/chatgpt_agent-os-development-direction]]
