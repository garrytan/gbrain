---
title: "AI Infrastructure and Connectors"
type: essay
created: 2026-05-16
updated: 2026-05-16
source: chatgpt-export
conversation_id: 6a07c631-2110-83e8-a70b-a2fe0a7c0743
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# AI Infrastructure and Connectors

> Conversation ID: 6a07c631-2110-83e8-a70b-a2fe0a7c0743
> Created: 2026-05-16T01:19:46Z
> Updated: 2026-05-16T01:32:42Z
> Messages: 4

---

## User

So one thing I want to try to understand now, as we're starting to ship aggressively, is kind of formalizing what our AI infrastructure is here. So if you could ground this ground this in what we're actually doing. Before I just start adding connectors on my Google Calendar connector and Gmail metrics, I think they're the most beneficial straight off the bat. The Google Calendar connector, particularly because you're scheduling releases and you're scheduling events and stuff. I want to see those, and I want to send back and forth so you're going to dates and stuff and making sure that your tour dates and your bands and towns are in sync. Then we can surface, like, "Oh, you have a concert that should be added to your calendar," and stuff like that, right? You want the agent to have that context, and then you want the Google Gmail context, right?
I want to move towards the simple harness kind of idea of what we've been talking about. We're using Versal, and I guess Versal workflows is the way to go on this. We want to do merch and stuff: merch design and generation and stuff, album art generation, all those things. I want to be able to do, like, I have all these photos on Apple Photos and stuff that I want to load into Jovie and give it that context.
Help me think about what we should start showing first. Really, what I want to do is just throw clogged code on formalizing this workflow and stuff. What do I need?
- I need to design UI for connectors. Perfect, I can do that.
- Tell me what design I need, what cards I need, what tooling I need, and how we write props.
- How do we think about the instruction and stuff?
Help me understand this, because I don't really know what the best way is to make vertical agents and stuff. I'm kind of waning this, because I know code but I don't know this whole agent shit and this furnace shit.
I guess I've got three hours to burn through a max plan of clogged code for the week. We already have an agent swarm system set up, so I could just throw CPU power at this right now. I want to take full advantage of that. Give me the prompt that I can give to my agent, and I'll use my swarm skills and stuff so you don't have to explain the swarming and everything. What I should have it spin up agents to do right now that would empower us to start shipping connectors and stuff? Should we use composio or something, or are there open source Gmail connectors we should use, or are there common systems we can use? Help me think about this.

---

## Assistant

I’ll ground this as an execution plan: connector architecture, UI/cards/props, tool and instruction design, plus a copy-paste prompt for your coding agents.

---

## Assistant

Calendar should lead as the visible action connector, Gmail as discovery context, with Apple Photos deferred until the harness exists. I’m also checking OAuth versus Composio/Nango and Workspace MCP tradeoffs.

---

## Assistant

Mr. White, I’d ship **Google Calendar + Gmail context first**, with a small reusable connector/agent harness underneath. Treat merch, album art, and Apple Photos as **second slice**, because Calendar/Gmail immediately unlocks “your music life is in sync” moments: tour dates, release dates, booking emails, missed events, follow-ups, and suggested calendar additions.

## The core architecture

Think of Jovie AI infra as five layers:

1. **Connectors**: OAuth, token storage, provider sync, provider webhooks.
2. **Context objects**: normalized facts Jovie can reason over: `calendar_event`, `email_signal`, `tour_date`, `release`, `artist_asset`, `suggested_action`.
3. **Tools**: typed functions the agent can call: `list_events`, `search_emails`, `propose_calendar_event`, `generate_merch_concept`.
4. **Workflows**: durable multi-step jobs: sync, extract, propose, wait for approval, execute.
5. **Vertical agents**: task-specific orchestrators with narrow context, narrow tools, output schema, and approval rules.

Use **Vercel Workflow** for multi-step durable jobs because it supports resumable workflows, durable steps, sleep, and hooks for external/human events; that maps well to “scan Gmail → extract concert → propose event → wait for user approval → add calendar event.” citeturn107930view0 Use **Vercel Queues** only where you need lower-level fanout/event ingestion; Vercel’s own docs position Queues for direct event delivery control and Workflow for higher-level long-running business logic. citeturn285262view4 Use **Vercel AI SDK / AI Gateway** for model calls, tool calling, structured outputs, routing, budget monitoring, and model fallbacks. citeturn285262view2turn285262view3turn687087view0

## What to show first in Jovie

First product surface:

**Connectors page**
- Google Calendar card
- Gmail card
- Apple Photos / Media Import card, initially “Upload / import photos” rather than full iCloud connector
- Future cards: Spotify, YouTube, Instagram, Shopify, Printful/merch vendor, Dropbox/Drive

**Home/dashboard module**
- “Upcoming music calendar”
- “Suggested events to add”
- “Emails that look actionable”
- “Tour/release conflicts”
- “Creative assets ready for merch/art”

The first magic moment should be:

> “Jovie found 3 event-like signals from Gmail and 2 missing events from your artist/tour data. Add them to Calendar?”

That is a better first demo than pure chat.

## Connector cards and props

Build these cards:

### 1. `ConnectorCard`

Shows status, permissions, health, and actions.

```ts
type ConnectorCardProps = {
  id: 'google_calendar' | 'gmail' | 'apple_photos' | 'google_drive';
  name: string;
  description: string;
  icon: React.ReactNode;
  status: 'not_connected' | 'connecting' | 'connected' | 'syncing' | 'error' | 'revoked';
  lastSyncAt?: string;
  health?: {
    state: 'healthy' | 'degraded' | 'needs_reauth' | 'not_synced';
    message?: string;
  };
  capabilities: Array<{
    id: string;
    label: string;
    enabled: boolean;
    risk: 'low' | 'medium' | 'high';
  }>;
  scopes: Array<{
    providerScope: string;
    label: string;
    reason: string;
    sensitivity: 'basic' | 'sensitive' | 'restricted';
  }>;
  primaryAction: {
    label: string;
    action: 'connect' | 'manage' | 'reconnect' | 'sync_now';
  };
  secondaryActions?: Array<{
    label: string;
    action: string;
  }>;
};
```

### 2. `PermissionReviewCard`

Shows why Jovie needs each permission.

```ts
type PermissionReviewCardProps = {
  provider: string;
  permissions: Array<{
    label: string;
    description: string;
    examples: string[];
    requiredFor: string[];
    risk: 'low' | 'medium' | 'high';
  }>;
};
```

### 3. `ContextPreviewCard`

Shows what Jovie learned without dumping private data.

```ts
type ContextPreviewCardProps = {
  source: 'calendar' | 'gmail' | 'photos';
  title: string;
  items: Array<{
    id: string;
    type: 'event' | 'email_signal' | 'asset' | 'suggestion';
    title: string;
    subtitle?: string;
    confidence?: number;
    provenanceLabel: string;
    action?: {
      label: string;
      actionId: string;
    };
  }>;
};
```

### 4. `SuggestedActionCard`

This is your approval UI.

```ts
type SuggestedActionCardProps = {
  id: string;
  title: string;
  explanation: string;
  sourceRefs: Array<{
    type: 'gmail_message' | 'calendar_event' | 'jovie_tour_date' | 'asset';
    label: string;
  }>;
  proposedAction:
    | {
        type: 'create_calendar_event';
        payload: {
          title: string;
          start: string;
          end?: string;
          location?: string;
          description?: string;
          attendees?: string[];
        };
      }
    | {
        type: 'draft_email';
        payload: {
          to?: string[];
          subject: string;
          body: string;
        };
      }
    | {
        type: 'generate_creative_asset';
        payload: {
          prompt: string;
          assetIds: string[];
          outputType: 'album_art' | 'merch_mockup' | 'poster';
        };
      };
  approvalRequired: true;
};
```

### 5. `AgentRunTimeline`

Shows trust: what the agent did, what it read, what it wants to do.

```ts
type AgentRunTimelineProps = {
  runId: string;
  status: 'queued' | 'running' | 'waiting_for_approval' | 'completed' | 'failed';
  steps: Array<{
    id: string;
    label: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    toolName?: string;
    startedAt?: string;
    completedAt?: string;
    summary?: string;
  }>;
};
```

## Build these backend primitives

Minimum schema:

```ts
ConnectorAccount
- id
- userId
- provider
- status
- encryptedAccessToken
- encryptedRefreshToken
- scopes[]
- expiresAt
- lastSyncAt
- createdAt
- updatedAt

ConnectorSyncState
- id
- connectorAccountId
- provider
- resourceType
- cursor
- watchChannelId
- watchResourceId
- watchExpiresAt
- lastFullSyncAt
- lastIncrementalSyncAt

ExternalObject
- id
- userId
- provider
- providerObjectId
- objectType
- rawRef
- normalizedJson
- hash
- firstSeenAt
- lastSeenAt

ContextFact
- id
- userId
- subjectType
- subjectId
- factType
- valueJson
- confidence
- provenance[]
- ttlExpiresAt

SuggestedAction
- id
- userId
- type
- title
- explanation
- payloadJson
- sourceRefs[]
- status: proposed | approved | rejected | executed | expired
- createdAt
- executedAt

AgentRun
- id
- userId
- agentType
- status
- inputJson
- outputJson
- toolCallsJson
- createdAt
```

Tool contract pattern:

```ts
type ToolSpec<Input, Output> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  risk: 'read' | 'write' | 'external_side_effect';
  requiresApproval: boolean;
  execute: (input: Input, ctx: ToolContext) => Promise<Output>;
};
```

Important rule: **write tools require an `approvalId`**. The agent can propose actions freely. Execution only happens after UI approval.

## Google Calendar implementation notes

Calendar is the best first connector.

Use:
- `calendar.events.readonly` for reading events.
- `calendar.events` only when users enable “Jovie can add/update events.”
- Store `nextSyncToken` after initial sync.
- Use incremental sync with `syncToken`.
- Handle `410` by wiping local calendar cache and running a full sync.

Google’s Calendar sync docs explicitly use an initial full sync followed by repeated incremental syncs with a stored `nextSyncToken`; if the server returns `410`, the client should clear local state and perform a new full sync. citeturn773492view0 Google Calendar push notifications require a webhook receiver and a notification channel per watched resource; notifications do not include full changed-resource details, so Jovie still needs to fetch changes after notification. citeturn498861view0

First Calendar tools:

```ts
calendar.listEvents({ timeMin, timeMax, calendarIds })
calendar.findConflicts({ eventDraft })
calendar.proposeCreateEvent({ sourceRef, eventDraft })
calendar.createEvent({ approvalId })
calendar.syncIncremental({ connectorAccountId })
calendar.renewWatch({ connectorAccountId })
```

First UI actions:
- “Connect Google Calendar”
- “Show upcoming music events”
- “Add missing event”
- “Detect date conflicts”
- “Renew calendar sync” hidden/admin/debug

## Gmail implementation notes

Start Gmail as **signal extraction**, not “AI reads your entire inbox.” Use it to find actionable music-business signals: booking confirmations, venue holds, tour dates, release deadlines, merch/vendor updates, invoices, collab threads.

Google recommends narrow scopes where possible; Gmail `gmail.readonly`, `gmail.modify`, and `gmail.metadata` are restricted scopes, and storing/transmitting restricted-scope data can require a security assessment. citeturn630987view0 That means your production UX should be explicit: “Jovie scans selected music-related messages to detect dates, tasks, and opportunities.”

Gmail sync path:
- Full sync initially: `messages.list` + batched `messages.get`
- Store latest `historyId`
- Partial sync with `history.list`
- Use push notifications later to trigger partial sync
- Fall back to periodic sync because history can expire and notifications can drop

Google’s Gmail docs describe full sync, partial sync using `history.list`, and storing `historyId`; they also note history records are generally available for at least a week but can become unavailable, requiring full sync. citeturn994408view2 Gmail push notifications require Cloud Pub/Sub, a topic/subscription, a `watch` request, daily-ish renewal because watches expire within 7 days, and graceful fallback because notifications can be delayed or dropped. citeturn994408view0turn994408view1

First Gmail tools:

```ts
gmail.searchSignals({
  query,
  after,
  before,
  labels,
  maxResults
})

gmail.extractEventCandidates({
  messageIds
})

gmail.proposeCalendarEvents({
  eventCandidates
})

gmail.summarizeThreadForAction({
  threadId,
  allowedPurpose: 'booking' | 'release' | 'merch' | 'collab'
})
```

Do **not** ship auto-send email in v1. Drafting is okay as a suggested action. Sending should require explicit approval.

## Composio vs direct Google APIs

Use **direct Google APIs for the product connector**. Use Composio only as a fast internal prototype or comparison harness.

Reason:
- Jovie’s long-term moat is your own normalized context layer, not vendor-specific agent tools.
- Gmail/Calendar data is sensitive; direct OAuth keeps token custody, scopes, sync state, and compliance posture under your control.
- Google already gives you first-party Calendar/Gmail sync and push primitives.
- Composio is useful for quick agent experiments: it advertises Gmail MCP/direct API for read/send/search/label, Calendar MCP/direct API for scheduling/checking availability, and managed OAuth/token refresh/scopes. citeturn459880view0turn459880view1turn459880view3

One current wrinkle: Google announced Workspace MCP server public developer preview on May 1, 2026, including Gmail, Drive, Calendar, Chat, and People tools. citeturn573988view1 Treat that as useful for dev/tooling and future agent compatibility, while still building Jovie’s own sync/context model. Google’s developer docs also say their Workspace developer MCP server can fetch official Workspace docs/snippets, while the page notes that an MCP server connecting directly to Workspace APIs is still tied to a feature request path in that developer-tools context. citeturn573988view0

## Apple Photos / media context

Do **not** make Apple Photos the first “connector” in the same way as Google Calendar/Gmail.

Start with:
- Web upload / drag-drop
- Mobile native picker later
- Optional macOS/iOS importer later
- Store images as `ArtistAsset`
- Generate captions, tags, color palette, faces/objects, style notes, embeddings
- Use those assets for album art, posters, merch mockups

Apple’s documented developer surface here is native PhotoKit/PhotosUI: PhotoKit lets apps access image/video assets managed by Photos, and Apple’s Photos picker provides a privacy-preserving way for users to select assets. citeturn763465search0turn763465search16 Apple’s privacy model also includes limited Photos library access where users choose specific assets an app can access. citeturn763465search3 So for Jovie web, the immediate product should be “import media into Jovie,” with a native importer later.

## Merch / album art generation

Make this a workflow after connectors are live:

```ts
creative.generateConcepts({
  artistId,
  assetIds,
  brief,
  outputType: 'album_art' | 'shirt_graphic' | 'poster' | 'social_tile'
})

creative.generateImage({
  conceptId,
  model,
  aspectRatio,
  brandConstraints
})

creative.createMockup({
  generatedAssetId,
  productType: 'tee' | 'hoodie' | 'poster' | 'vinyl_cover'
})
```

Vercel AI Gateway currently supports image generation through AI SDK, including multimodal image models and image-only models; its docs show generated image files/results can be saved from model outputs. citeturn632174view0

## Vertical agent model

A vertical agent in Jovie should be:

```ts
type VerticalAgent = {
  id: string;
  purpose: string;
  allowedTools: string[];
  contextBuilder: (input: unknown) => Promise<ContextPack>;
  instruction: string;
  outputSchema: z.ZodSchema;
  approvalPolicy: ApprovalPolicy;
  evals: EvalCase[];
};
```

Example agents:

**ReleaseOpsAgent**
- Reads: release dates, Calendar, Gmail signals
- Writes: proposed calendar events, proposed tasks
- Never sends email
- Output: `SuggestedAction[]`

**TourCalendarAgent**
- Reads: tour dates, venues, Calendar
- Writes: proposed Calendar creates/updates
- Detects conflicts
- Output: missing events + conflicts

**InboxSignalAgent**
- Reads: Gmail messages within allowed query/time window
- Extracts: dates, people, venues, obligations
- Output: `EmailSignal[]`

**CreativeAssetAgent**
- Reads: artist profile, imported photos, brand notes
- Writes: generated concepts/assets
- Output: creative brief + generated asset jobs

**MerchAgent**
- Reads: creative assets, artist identity, store/vendor config
- Writes: proposed merch products/mockups
- Output: merch concepts, not live products unless approved

## The instruction strategy

Each agent instruction should include:

```txt
You are the Jovie [domain] agent.

Goal:
Produce useful, low-risk suggestions for [specific domain].

Data policy:
Use only the context supplied in the context pack and the allowed tools.
Do not browse or fetch unrelated user data.
Minimize private data in outputs.
Preserve source references for every claim.

Tool policy:
Read tools may be called when needed.
Write tools may only create SuggestedAction records.
External side effects require explicit user approval and an approvalId.

Output:
Return JSON matching the provided schema.
Every suggestion must include: title, explanation, confidence, sourceRefs, proposedAction.
```

The key is **context pack first, model second**. Do not give the model an open-ended Gmail or Calendar firehose. Build narrow context packs like:

```ts
type ContextPack = {
  user: { id: string; timezone: string };
  artist?: { id: string; name: string; handles: string[] };
  window: { start: string; end: string };
  knownEvents: NormalizedEvent[];
  calendarEvents: CalendarEventSummary[];
  emailSignals: EmailSignal[];
  assets: ArtistAssetSummary[];
  constraints: string[];
};
```

## What to spin up agents to do right now

Run these in parallel.

### Agent 1: Connector architecture

Deliver:
- DB schema/migrations for `ConnectorAccount`, `ConnectorSyncState`, `ExternalObject`, `ContextFact`, `SuggestedAction`, `AgentRun`
- TypeScript interfaces
- encrypted token storage helper
- provider registry

### Agent 2: UI connectors

Deliver:
- `/settings/connectors`
- `ConnectorCard`
- `PermissionReviewCard`
- `ContextPreviewCard`
- `SuggestedActionCard`
- mocked states for Calendar/Gmail/Photos
- empty/loading/error/connected states

### Agent 3: Google Calendar connector

Deliver:
- OAuth start/callback
- list calendars
- initial event sync
- incremental sync with `nextSyncToken`
- create proposed event, then execute event after approval
- webhook route scaffold
- tests with mocked Google API responses

### Agent 4: Gmail connector

Deliver:
- OAuth start/callback
- message search
- metadata/body fetch behind clear capability flag
- full sync + `historyId`
- signal extraction schema
- Pub/Sub webhook route scaffold
- no send-email tool

### Agent 5: Workflow harness

Deliver:
- Vercel Workflow functions:
  - `syncConnectorWorkflow`
  - `extractSignalsWorkflow`
  - `proposeCalendarEventsWorkflow`
  - `executeApprovedActionWorkflow`
- run ledger
- approval hook/resume path

### Agent 6: Agent/tool registry

Deliver:
- `ToolSpec` abstraction
- Zod schemas
- `ReleaseOpsAgent`
- `TourCalendarAgent`
- `InboxSignalAgent`
- structured output parser
- failure logging

### Agent 7: Creative/media slice

Deliver:
- `ArtistAsset` schema
- upload/import UI
- asset tagging job
- creative generation job schema
- album art / merch concept card mock

### Agent 8: Security/evals

Deliver:
- approval-gate tests
- no-write-without-approval tests
- scope display tests
- prompt injection tests for Gmail body content
- token redaction in logs
- fixture-based evals for “email contains concert date → suggested calendar event”

## Prompt to give your coding agents

```txt
You are working in the Jovie codebase. Build the first version of Jovie’s AI connector + vertical agent harness.

Assume a Next.js/TypeScript app deployed on Vercel. Use the project’s existing DB/auth/style conventions. Do not invent a new stack if one already exists. If the app already has Prisma/Drizzle/Supabase/etc., use it. If there is an existing component system, use it.

Goal:
Ship a production-shaped MVP for Google Calendar + Gmail connectors, plus the reusable harness for AI agents to consume connector context and propose actions. The first user-facing magic moment is: “Jovie found event-like signals from Gmail and known Jovie artist/tour/release data, compared them to Google Calendar, and suggested missing calendar events for approval.”

Architecture:
1. Connectors handle OAuth, token storage, sync state, provider webhooks, and normalized provider objects.
2. Context objects are normalized facts: calendar events, email signals, tour dates, releases, artist assets, suggested actions.
3. Tools are typed functions with Zod input/output schemas.
4. Workflows are durable multi-step jobs: sync, extract, propose, wait for approval, execute.
5. Vertical agents are narrow task orchestrators with allowed tools, context packs, output schemas, and approval policy.

Hard rules:
- No external side effects without explicit user approval.
- Write tools require an approvalId.
- Gmail send is out of scope for v1. Draft/propose only.
- Minimize Gmail access and output. Do not dump raw email bodies into UI.
- All tool calls, model calls, and suggested actions must be logged in AgentRun.
- Use sourceRefs/provenance on every generated suggestion.
- Tokens must be encrypted/redacted and never appear in logs.
- Build with mocked provider fixtures if production OAuth credentials are absent.

Implement these data models or equivalent:
- ConnectorAccount
- ConnectorSyncState
- ExternalObject
- ContextFact
- SuggestedAction
- AgentRun
- ArtistAsset if not present

Implement UI:
- /settings/connectors
- ConnectorCard
- PermissionReviewCard
- ContextPreviewCard
- SuggestedActionCard
- AgentRunTimeline
- Cards for Google Calendar, Gmail, and Apple Photos/Media Import
- Mock states: not_connected, connected, syncing, error, needs_reauth

Connector cards should accept props shaped like:
{
  id,
  name,
  description,
  icon,
  status,
  lastSyncAt,
  health,
  capabilities,
  scopes,
  primaryAction,
  secondaryActions
}

Google Calendar connector:
- OAuth start/callback routes
- Store scopes and token expiry
- Initial sync for upcoming/past configurable window
- Store nextSyncToken
- Incremental sync with syncToken
- Handle 410 by clearing local calendar cache and full syncing
- Tool specs:
  - calendar.listEvents
  - calendar.findConflicts
  - calendar.proposeCreateEvent
  - calendar.createEvent, requires approvalId
  - calendar.syncIncremental
  - calendar.renewWatch
- Webhook route scaffold for Calendar push notifications
- Suggested event creation UI

Gmail connector:
- OAuth start/callback routes
- Search messages using narrow query/time window
- Fetch metadata by default
- Fetch body only when needed for signal extraction and capability is enabled
- Store latest historyId after full sync
- Partial sync with history.list
- Pub/Sub webhook route scaffold
- Tool specs:
  - gmail.searchSignals
  - gmail.extractEventCandidates
  - gmail.proposeCalendarEvents
  - gmail.summarizeThreadForAction
- No gmail.send tool in v1

Workflow harness:
- Add Vercel Workflow-compatible workflows or project-equivalent durable jobs:
  - syncConnectorWorkflow(connectorAccountId)
  - extractSignalsWorkflow(userId, sourceWindow)
  - proposeCalendarEventsWorkflow(userId, artistId?, timeWindow)
  - executeApprovedActionWorkflow(approvalId)
- Add run status: queued, running, waiting_for_approval, completed, failed
- Add approval/resume endpoint for SuggestedAction approval

Agent registry:
- Define ToolSpec<Input, Output>
- Define ContextPack
- Define VerticalAgent
- Implement:
  - ReleaseOpsAgent
  - TourCalendarAgent
  - InboxSignalAgent
- Agents must return strict JSON matching SuggestedAction[] or EmailSignal[] schemas.
- Agents may propose actions; they may not directly perform side effects.

Media/creative placeholder:
- Add Apple Photos/Media Import card.
- Implement upload/import UI if easy.
- Add ArtistAsset schema or placeholder.
- Add creative job schema for album_art, merch_mockup, poster.
- Do not attempt full iCloud Photos server sync in this PR.

Testing:
- Add fixtures:
  - Gmail booking email with date/venue
  - Calendar missing that event
  - Calendar already has matching event
  - Conflicting event
  - Prompt-injection email body trying to override instructions
- Tests must verify:
  - event candidate extraction
  - duplicate detection
  - suggested action creation
  - no createEvent without approvalId
  - tokens are redacted in logs
  - Gmail send does not exist

Deliverables:
- Working UI with mocked data
- Working provider abstractions
- Calendar/Gmail connector scaffolds with real routes where credentials exist
- Agent/tool/workflow harness
- Tests
- README section explaining how to add the next connector
- PR summary listing exactly what works, what is mocked, and what env vars are required
```

## My recommendation for the next 3 hours

Ship in this order:

1. **Connector UI + schema + registry**
2. **Google Calendar OAuth/sync/propose event**
3. **Gmail search/extract/propose**
4. **Workflow + approval gate**
5. **Creative/media placeholder**

This gives you a reusable system and a shippable demo. Calendar/Gmail prove the “Jovie knows your music life” thesis. Media/merch becomes much stronger once the same harness already exists.
