---
title: "Fixing Chat Jank Issues"
type: guide
created: 2026-05-23
updated: 2026-05-24
source: chatgpt-export
conversation_id: 6a123e1a-56cc-83e8-8acd-3e90987f741a
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# Fixing Chat Jank Issues

**Related:** [[coding_troubleshoot]]

> Conversation ID: 6a123e1a-56cc-83e8-8acd-3e90987f741a
> Created: 2026-05-23T23:54:02Z
> Updated: 2026-05-24T00:28:05Z
> Messages: 3

---

## User

chat jank is stilll an issue. despite shipping fixes for weeks. give me the world class prompt to fix it. The biggest thing is it loading and then hitting multiple skeletons and different patterns and stuff that don't match what actually should be there, and then somehow shipping the production with it not actually responding, stuff like that. Or responding and then messages disappearing later. Flicker and stuff. Things like settling, then like a good ten to twenty seconds later there's different content. 

---

## Assistant

I’ll craft this as a senior frontend/platform debugging prompt focused on the full chat rendering pipeline: state machines, streaming races, cache invalidation, production gating, regression coverage, and observable UI stability.

---

## Assistant

Mr. White, paste this into Codex/Cursor/Claude Code as the top-level task prompt.

```text
You are a world-class staff frontend/platform engineer. Your task is to eliminate chat UI jank, flicker, disappearing messages, late content swaps, skeleton mismatch, and production “chat does not respond” failures.

This is not a cosmetic task. Treat this as a reliability and state-consistency bug in the chat product.

Context:
The current chat experience has shipped multiple fixes over several weeks, but users still see:
- Initial loading followed by multiple skeleton states.
- Skeletons that do not match the actual final layout.
- Different loading patterns appearing in sequence.
- Chat sometimes ships to production while not actually responding.
- Messages appear, then disappear later.
- Assistant responses stream or render, then content changes 10–20 seconds later.
- Flicker during hydration, refetch, streaming, routing, or cache updates.
- “Settled” UI later replaced by different content.
- Inconsistent treatment of optimistic messages, server messages, cached messages, and streamed messages.

Your mandate:
Find and fix the root architectural causes. Do not add another superficial loading flag. Do not paper over the symptoms with timeouts. Build a deterministic, testable chat rendering pipeline.

Investigate first, then implement.

Phase 1 — Audit the actual chat lifecycle
Trace every state transition from:
1. route/page load
2. conversation fetch
3. empty state
4. previous messages loaded
5. user submits message
6. optimistic user message appears
7. assistant pending state appears
8. assistant stream starts
9. assistant stream updates
10. assistant stream completes
11. persistence/refetch/cache sync happens
12. navigation away/back
13. reconnect/retry/error
14. production build/hydration

Identify every source of truth for messages:
- local component state
- optimistic state
- streaming state
- server response
- cache/query library
- route loader/server component data
- websocket/SSE state
- local storage/session storage
- background refetches
- mutation responses

Produce a short written diagnosis in the PR explaining:
- where duplicated loading states come from
- where flicker comes from
- how messages can disappear
- how late refetches overwrite settled UI
- why production can ship with chat not responding
- which state source is now authoritative

Phase 2 — Define strict invariants
Implement the chat UI so these invariants are always true:

1. One authoritative message timeline
There must be one canonical ordered message list used for rendering. Other sources may feed it, but rendering must never directly alternate between independent lists.

2. Monotonic message lifecycle
A message may move forward through states only:
draft → optimistic/sending → sent → streaming → complete
or
draft → optimistic/sending → failed

A confirmed message must never disappear because of a refetch, remount, retry, cache replacement, or stream completion.

3. Stable IDs and keys
Every message must have a stable render key from creation through server confirmation.
If the server returns a different ID, reconcile the optimistic ID to the server ID without remounting the visible row.

4. No destructive refetch replacement
A background refetch must merge into the canonical timeline. It must not replace the visible message list wholesale if local optimistic, pending, streaming, or newer messages exist.

5. No skeleton cascade
There should be exactly one loading pattern for initial conversation load.
After the chat shell is visible, sending a message must use an inline pending/streaming assistant row, not full-page skeletons.
Never show multiple sequential skeleton layouts for the same region.

6. Skeletons must reserve final layout space
Any skeleton must match the dimensions and structure of the final rendered content closely enough to prevent layout shift.

7. Settled means settled
Once a message is marked complete, it must not be visually replaced 10–20 seconds later by stale cache data, hydration output, retry output, or delayed server reconciliation.
Late data may merge metadata, but it must not replace newer visible content with older content.

8. Streaming is append/update only
Streaming assistant content should update the existing assistant row.
It must not create duplicate assistant rows, remount the row, reset the scroll unexpectedly, or replace the whole conversation.

9. Errors are visible and recoverable
If send/stream/persist fails, keep the user message visible and show an inline failed/retry state.
Never silently remove the message.

10. Production readiness is gated
Chat must have automated tests and runtime guards that fail loudly before production if the send/stream path is broken.

Phase 3 — Implement the fix
Refactor the chat state into an explicit reducer/state machine if one does not already exist.

Expected design:
- A single `ChatTimeline` or equivalent owns the canonical renderable messages.
- Events feed the reducer:
  - `conversation.load.started`
  - `conversation.load.succeeded`
  - `conversation.load.failed`
  - `message.send.started`
  - `message.send.acknowledged`
  - `assistant.stream.started`
  - `assistant.stream.delta`
  - `assistant.stream.completed`
  - `assistant.stream.failed`
  - `conversation.refetch.succeeded`
  - `conversation.refetch.failed`
  - `message.retry.started`
- The reducer must be pure and unit-tested.
- Rendering should consume only the reducer output.
- Cache/query/server data should dispatch merge events, not directly replace rendered state.
- Streaming should update a single assistant message by stable ID.
- Optimistic user messages should survive cache misses, refetches, remounts, and retry failures.

Reconciliation rules:
- Prefer newer local/streaming content over older fetched content.
- Merge server-confirmed metadata into optimistic messages.
- Deduplicate by server ID, optimistic correlation ID, request ID, and content/time fallback only when necessary.
- Never drop a local message unless the user explicitly deletes it.
- Ignore stale responses from older requests when a newer request has already updated the same message.
- Cancel or ignore obsolete in-flight requests on conversation switch.

Loading UI rules:
- Initial route/conversation load: show one shell skeleton that matches final layout.
- Conversation exists but messages are loading: show stable message-area skeleton only once.
- User sends message: keep existing messages visible; append user message and assistant pending row.
- Streaming: replace assistant pending indicator with streamed text in the same row.
- Empty conversation: show empty state, not skeleton.
- Refetching existing conversation: do not show skeleton; use invisible/background refresh or subtle non-layout-shifting indicator only if needed.
- Error: show inline error without destroying the conversation layout.

Phase 4 — Add instrumentation
Add structured logs or telemetry for chat state transitions in development and production-safe debug mode.

Track:
- conversation ID
- request ID
- optimistic message ID
- server message ID
- assistant message ID
- event name
- previous state
- next state
- whether the event was ignored as stale
- whether a refetch merged or attempted replacement
- stream start/completion/failure
- time from send to first token
- time from send to completion
- render count/remount count for message rows if feasible

Add guards:
- warn/error if two assistant streaming rows exist for one user message
- warn/error if a complete message disappears from the timeline
- warn/error if a refetch would remove optimistic or streaming messages
- warn/error if a message key changes after first render
- warn/error if full-page skeleton appears after initial chat shell has rendered

Phase 5 — Add regression tests
Create automated tests that reproduce the known failures.

Required tests:
1. Initial load shows only one skeleton pattern before content.
2. Skeleton layout matches final message shell closely enough to avoid major layout shift.
3. Sending a message immediately appends the user message.
4. User message remains visible if the network request is slow.
5. User message remains visible if the server returns an error.
6. Assistant pending row becomes the streaming row without remounting.
7. Stream deltas update one assistant message, not multiple messages.
8. Background refetch during streaming does not remove or reset streamed content.
9. Late stale refetch after completion does not replace newer completed content.
10. Server acknowledgement reconciles optimistic ID without flicker.
11. Navigating away/back preserves or correctly reloads the canonical timeline.
12. Conversation switch ignores stale responses from the previous conversation.
13. Duplicate send/stream callbacks do not create duplicate messages.
14. Production build test verifies chat can submit and receive a mocked response.
15. Hydration test verifies server-rendered shell does not get replaced by a mismatched client skeleton.

Use fake timers and mocked delayed responses to simulate:
- 100ms response
- 2s response
- 20s delayed refetch
- out-of-order stream events
- stream failure
- mutation success followed by stale query result
- route remount
- cache invalidation during active stream

Phase 6 — Production hardening
Add a production smoke test or CI check that exercises the real built app against a mocked chat backend:
- open chat
- load conversation
- submit message
- assert user message appears
- assert assistant pending state appears
- emit mock stream tokens
- assert assistant response appears incrementally
- complete stream
- assert final message remains visible after refetch/invalidation
- assert no full-page skeleton appears after the first meaningful render

Add feature-level health checks:
- fail CI if the chat submit button can be enabled while no send handler is attached
- fail CI if required chat API env vars are absent in production build
- fail CI if the stream parser silently drops valid chunks
- fail CI if unhandled promise rejections occur during chat send/stream tests

Phase 7 — Performance and visual stability
Measure and reduce:
- unnecessary message row remounts
- layout shift
- repeated skeleton rendering
- scroll jumps
- full-list re-renders during token streaming

Implement:
- stable memoized message rows
- stable keys
- append/update semantics for stream deltas
- scroll anchoring that only auto-scrolls when the user is already near bottom
- no layout-affecting loading indicators during background refetch
- reserved space for composer, message rows, and assistant pending state

Acceptance criteria:
- No message disappears after appearing.
- No completed assistant response is replaced by older content later.
- No multiple skeleton patterns appear for the same chat surface.
- No full-page skeleton appears after the chat shell has rendered.
- Sending a message never clears existing messages.
- Streaming updates a single stable assistant row.
- Refetches merge, never destructively replace active timeline state.
- Production build has automated coverage for chat send and stream.
- The PR includes a concise root-cause explanation and a state diagram or lifecycle notes.
- The fix is covered by unit tests, integration tests, and at least one production-build smoke test.

Important implementation constraints:
- Do not solve this with arbitrary delays.
- Do not hide the issue with loading spinners.
- Do not introduce a second message array for rendering.
- Do not use array index as message key.
- Do not let query/cache results directly replace active local/streaming state.
- Do not clear the timeline during send, retry, stream start, or refetch.
- Do not remount the entire chat surface when a message changes.
- Do not show skeletons for background refetches.
- Do not mark a message complete until the stream and persistence state are reconciled.
- Do not silently swallow stream, send, parse, or persistence errors.

Deliverables:
1. Root-cause diagnosis.
2. Refactored deterministic chat state pipeline.
3. Loading/skeleton cleanup.
4. Stable optimistic/server reconciliation.
5. Race-condition handling for stale responses/refetches.
6. Instrumentation for timeline events.
7. Regression tests for the exact jank cases.
8. Production-build smoke test.
9. PR notes explaining the invariants and how future changes should preserve them.

Start by locating all chat-related components, hooks, query/cache code, streaming code, server actions/API routes, and tests. Then produce a brief implementation plan. After that, make the changes.
```

The key phrase is **“one canonical ordered message list used for rendering.”** Most chat jank like this comes from multiple competing render sources: server-loaded messages, optimistic messages, streaming messages, cache refetches, and route hydration all taking turns owning the UI.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
