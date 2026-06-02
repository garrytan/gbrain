---
title: "Detecting AI Jank"
type: guide
created: 2026-04-24
updated: 2026-04-24
source: chatgpt-export
conversation_id: 69eb1f5e-98a4-83e8-bd1e-ab13a5e4ebf7
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Detecting AI Jank

> Conversation ID: 69eb1f5e-98a4-83e8-bd1e-ab13a5e4ebf7
> Created: 2026-04-24T07:44:31Z
> Updated: 2026-04-24T08:05:39Z
> Messages: 6

---

## User

we need to detect jank in our ai chat.

messages disappear and reappear at multiple oints in the rpcoess of conversation. sometimes chat just dioesnt respond. the product just "feels" unstable because of this. 

i dont understand how to quantify "jank" enough un ui particulary with streaming elements and ai.

---

## Assistant

Mr. White, I’ll turn “jank” into measurable chat instability: message persistence, streaming continuity, latency, layout shifts, rendering stalls, state churn, and response failures.

---

## Assistant

Mr. White, quantify this as **chat stability**, not generic “UI performance.”

For AI chat, “jank” means the user loses confidence that the conversation state is real. The product can have acceptable FPS and still feel broken if messages disappear, reappear, reorder, reset, or silently stall.

## 1. Define jank as observable violations

Use this taxonomy:

| Category | User-visible symptom | Metric |
|---|---|---|
| **Message continuity jank** | Message disappears, reappears, duplicates, changes order | message flap rate, remount count, reorder count |
| **Streaming jank** | Assistant starts, stops, resets, jumps backward, token stream freezes | time to first token, stall count, token rollback count |
| **Scroll jank** | Chat jumps while reading, input moves, latest message moves unexpectedly | unexpected scroll delta, anchor displacement |
| **Layout jank** | Bubbles shift, skeletons collapse, markdown/images resize late | chat-specific layout shift |
| **Responsiveness jank** | User clicks send and nothing seems to happen | send-to-feedback latency, INP |
| **Reliability jank** | Request never resolves, no error shown, UI stuck loading | silent failure rate, stuck response rate |

Standard browser metrics help, but they are incomplete. INP measures interaction responsiveness across clicks, taps, and keyboard input; web.dev considers ≤200ms good and >500ms poor. That helps quantify “I clicked send and the UI felt dead.” citeturn740486view0turn740486view1 CLS/layout-shift helps quantify visual instability when visible elements move between frames. citeturn119490view0 Long Animation Frames are useful for finding slow UI frames; a LoAF is a rendering update delayed beyond 50ms, and Chrome’s API can observe these in real user sessions. citeturn119490view1turn119490view2

## 2. Create a “jank-free conversation” metric

Your top-level product KPI should be:

**Jank-Free Conversation Rate**

A conversation is jank-free when all of these are true:

```text
No message disappears after being visible.
No message reorders after being visible.
No assistant stream stalls for >2s without visible status.
No token rollback occurs.
No unexpected scroll jump >48px.
No send action lacks visible feedback within 150ms.
No response remains stuck for >30s without an error/retry state.
```

Then track:

```text
jank_free_conversation_rate =
  conversations_with_zero_jank_events / total_conversations
```

This is better than average latency because users remember the broken-feeling sessions.

Target progression:

```text
<90%      visibly unstable
90–95%    tolerable but users will complain
95–98%    decent
98%+      feels solid
99%+      premium/chat-native quality
```

## 3. Instrument the chat lifecycle

Every user message should have a single immutable lifecycle:

```text
user_pressed_send
→ user_message_rendered
→ assistant_placeholder_rendered
→ request_started
→ stream_connected
→ first_token_received
→ first_token_painted
→ stream_completed
→ final_message_persisted
```

Track these timings:

| Metric | Definition | Good target |
|---|---|---|
| **Send-to-user-bubble** | click send → user message visible | <100ms |
| **Send-to-assistant-placeholder** | click send → visible “thinking” / empty assistant bubble | <150ms |
| **Request start latency** | click send → network request started | <200ms |
| **Time to first token** | click send → first model token received | product-dependent, but track p50/p95 |
| **First token paint latency** | first token received → first token visible | <100ms |
| **Chunk-to-paint latency** | stream chunk received → rendered | p95 <100–200ms |
| **Stream stall count** | no new token/status for N seconds during active stream | 0 preferred |
| **Completion-to-persist** | final token → saved final state | <500ms |

The critical product rule: **after the user sends a message, something visible must happen immediately**. Even if the model takes 5 seconds, the UI should confirm causality in <150ms.

## 4. Track message continuity directly

This is probably where your biggest issue is.

Each message should have:

```ts
{
  conversationId,
  clientMessageId,   // created immediately on send
  serverMessageId,   // attached later, never replaces identity
  requestId,
  role,
  sequenceIndex,
  streamRevision,
  createdAt,
  renderState
}
```

Then instrument these events:

```text
message_visible
message_hidden
message_removed
message_reappeared
message_reordered
message_remounted
message_content_length_decreased
message_id_changed
message_duplicate_detected
```

Important metrics:

| Metric | What it catches |
|---|---|
| **Message flap rate** | Message visible → hidden/removed → visible again |
| **Message remount count** | React/component identity instability |
| **Message reorder count** | Sorting, refetch, optimistic update bugs |
| **Token rollback count** | Stream text shrinks or resets |
| **Duplicate message rate** | Optimistic + server message both shown |
| **Persistence overwrite rate** | Local stream gets replaced by stale server fetch |

A simple definition:

```text
message_flap =
  message was visible for ≥1 frame,
  then absent/hidden,
  then visible again within 10s
```

Track:

```text
message_flap_rate =
  message_flap_events / messages_rendered
```

For a chat product, this should be effectively zero.

## 5. Track scroll and viewport stability

AI chats often feel broken because the viewport loses its anchor.

Measure the position of the most relevant visible message before and after each render commit:

```text
anchor_message_id
anchor_top_before
anchor_top_after
delta_px = anchor_top_after - anchor_top_before
```

Create an event when:

```text
abs(delta_px) > 48px
AND user did not scroll
AND render was caused by streaming/refetch/layout
```

Metrics:

```text
unexpected_scroll_jump_count
p95_anchor_displacement_px
bottom_lock_breaks
input_bar_displacement_px
```

Also separate two modes:

```text
User is at bottom → auto-scroll can follow stream.
User is reading above bottom → preserve viewport anchor.
```

A lot of “jank” comes from treating both modes the same.

## 6. Add browser-level performance observers

Use browser metrics to catch actual UI thread issues.

```js
// Layout shifts: catches visible movement.
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (!entry.hadRecentInput) {
      window.analytics.track("layout_shift", {
        value: entry.value,
        sources: entry.sources?.map(s => ({
          node: s.node?.dataset?.messageId || s.node?.tagName
        }))
      });
    }
  }
}).observe({ type: "layout-shift", buffered: true });


// Long animation frames: catches slow frames / render blocking.
if (PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.analytics.track("long_animation_frame", {
        duration: entry.duration,
        blockingDuration: entry.blockingDuration,
        renderStart: entry.renderStart,
        styleAndLayoutStart: entry.styleAndLayoutStart
      });
    }
  }).observe({ type: "long-animation-frame", buffered: true });
}
```

Use these alongside your custom chat metrics. Generic CLS/LoAF tells you “the browser got unstable.” Chat metrics tell you “message 123 disappeared after stream revision 8.”

## 7. Create a weighted Chat Jank Score

For each conversation:

```text
chat_jank_score =
  10 * silent_failure_count
+  8  * message_disappear_count
+  6  * token_rollback_count
+  5  * duplicate_message_count
+  4  * unexpected_scroll_jump_count
+  3  * stream_stall_count
+  2  * long_animation_frame_count
+  1  * layout_shift_over_threshold_count
```

Then dashboard:

```text
p50 chat_jank_score
p95 chat_jank_score
% conversations with score = 0
top jank event type
top route/device/browser
top release/version correlated with jank
```

The most important number is:

```text
% conversations with score = 0
```

## 8. Likely root causes to check

Given “messages disappear and reappear,” I would audit these first:

| Symptom | Likely cause |
|---|---|
| Message disappears after send | Optimistic local message replaced by server fetch |
| Message reappears duplicated | Client temp ID and server ID treated as separate messages |
| Streaming text resets | Final persisted response overwrites streaming buffer |
| Messages reorder | Sorting by server timestamp after optimistic render |
| Whole thread flickers | Suspense/loading boundary around entire message list |
| Message remounts repeatedly | React key uses array index or mutable ID |
| Chat stalls silently | Stream connection died without timeout/error state |
| Scroll jumps | Auto-scroll always enabled, no anchor preservation |
| Markdown/images cause jumps | Dynamic content height changes without reserved space |
| Virtualized list flickers | Variable-height rows with unstable measurements |

The highest-leverage fix is usually: **stable message identity from creation through persistence**.

Do this:

```text
clientMessageId is permanent.
serverMessageId is metadata.
React key = clientMessageId or canonical stable ID.
Never key by array index.
Never replace the message object wholesale during stream/finalization.
Merge server state into existing client message.
```

## 9. Minimal dashboard I’d build first

Create one dashboard with:

```text
Jank-Free Conversation Rate
Message Disappear/Reappear Rate
Unexpected Scroll Jump Rate
Stream Stall Rate
Silent Failure Rate
Send-to-Visible-Feedback p95
Time-to-First-Token p95
First-Token-to-Paint p95
Long Animation Frames per Conversation
Chat CLS / Layout Shift in message container
```

Segment by:

```text
release version
browser
device class
conversation length
model/provider
streaming vs non-streaming
logged-in state
network quality
```

## 10. Practical definition for your team

Use this internally:

> Chat jank is any user-visible break in conversational continuity, responsiveness, or visual stability during message creation, streaming, persistence, or scrolling.

That definition is measurable, QA-testable, and maps directly to user trust.

---

## User

give me the mvp of this in a prompt i can have claude code tackle. it should include testing and then run ing gstack skills /qa --exhaustive to trigger and repair said tests.

---

## Assistant

I’ll turn this into a copy-pasteable implementation prompt scoped to MVP instrumentation, regression tests, and a forced exhaustive QA repair loop.

---

## Assistant

Mr. White, use this prompt with Claude Code:

```text
You are working in this repo as a senior frontend/product engineer.

Goal: implement an MVP system to detect, test, and prevent AI chat “jank.”

Context:
Our AI chat feels unstable. During conversations, messages sometimes disappear and reappear, reorder, duplicate, reset while streaming, or the chat simply stops responding without clear feedback. We need an MVP that makes this measurable and catches regressions in tests.

Do not overbuild a full observability platform. Build the smallest useful version that:
1. Detects message continuity jank.
2. Emits structured jank events.
3. Adds tests for the most likely failure modes.
4. Runs QA and repairs failures.

First, inspect the codebase and find:
- Chat message rendering components.
- Message list / thread components.
- Streaming response handling.
- Optimistic user message handling.
- Persistence/refetch logic.
- Existing analytics/event tracking utilities.
- Existing unit/integration/e2e test framework.

Implement the MVP using existing project conventions.

Core definitions:

A “jank event” is any user-visible break in chat continuity, especially:
- A visible message disappears and later reappears.
- A message changes identity during optimistic-to-server reconciliation.
- A message duplicates.
- Messages reorder unexpectedly.
- Assistant streaming text rolls backward or resets.
- Assistant stream stalls without visible status.
- User sends a message and no visible feedback appears quickly.
- Chat scroll jumps while the user is reading older messages.

MVP implementation requirements:

1. Stable message identity

Ensure every locally-created message gets a stable clientMessageId immediately.

Rules:
- clientMessageId must remain stable for the life of the message.
- serverMessageId should be attached later as metadata.
- React keys must use a stable message ID, never array index.
- Server updates/refetches should merge into existing messages rather than replacing visible messages wholesale.
- Optimistic user messages should reconcile with server messages without disappearing, duplicating, or remounting.

2. Jank instrumentation

Create a small chat jank monitor utility/hook/module.

It should track visible messages per conversation and emit structured events such as:

- chat_jank.message_disappeared
- chat_jank.message_reappeared
- chat_jank.message_duplicated
- chat_jank.message_reordered
- chat_jank.message_id_changed
- chat_jank.token_rollback
- chat_jank.stream_stall
- chat_jank.no_visible_feedback_after_send
- chat_jank.unexpected_scroll_jump

Each event should include, where available:
- conversationId
- clientMessageId
- serverMessageId
- role
- previousState
- nextState
- sequenceIndex
- streamRevision
- route/page
- timestamp
- app version/build if available

Use the project’s existing analytics/logging utility if one exists. If none exists, implement a small internal event emitter/logger that can be tested and later wired to analytics.

Avoid logging message text/content unless the codebase already has a safe, privacy-approved analytics pattern. Prefer IDs, lengths, counts, and state transitions.

3. Streaming stability tracking

For assistant streaming messages:
- Track content length over time.
- Emit token_rollback if content length decreases unexpectedly during normal append streaming.
- Track time since last stream chunk/status update.
- Emit stream_stall if the active stream has no chunk/status update for more than 2 seconds.
- When a stream stalls, the UI should show a visible status or error/retry affordance if the existing UX supports it.

4. Send feedback tracking

When the user sends a message:
- The user message should render immediately.
- An assistant placeholder/thinking/loading state should render quickly.
- Emit no_visible_feedback_after_send if there is no visible user message or assistant placeholder within 150ms.

5. Scroll stability tracking

Implement minimal scroll jank detection for the chat container:
- Detect whether the user is at the bottom.
- If the user is reading above the bottom, preserve the visible anchor through message updates.
- Emit unexpected_scroll_jump if the visible anchor moves by more than 48px without user scroll input.

Do this in the simplest safe way using existing scroll/container logic. Do not rewrite virtualization unless required.

6. Tests

Add tests using the repo’s existing testing stack. Prefer existing patterns.

At minimum, add tests for:

A. Optimistic send stability
- User sends a message.
- Message appears immediately with a stable clientMessageId.
- Server response arrives with serverMessageId.
- Existing message is updated/merged.
- Message does not disappear.
- Message does not duplicate.
- React key/identity remains stable where testable.

B. Refetch during active stream
- Assistant response is streaming.
- Conversation refetch or server sync occurs.
- Existing visible messages remain visible.
- Streaming content does not reset.
- No duplicate assistant message appears.

C. Token rollback detection
- Simulate stream chunks: "Hello", "Hello wor", then "Hello".
- Assert chat_jank.token_rollback is emitted.

D. Stream stall detection
- Start an assistant stream.
- Advance fake timers beyond 2 seconds without a chunk/status update.
- Assert chat_jank.stream_stall is emitted.
- Assert visible loading/stalled/error status exists if applicable.

E. No visible feedback after send
- Simulate send where no user bubble or assistant placeholder appears within 150ms.
- Assert chat_jank.no_visible_feedback_after_send is emitted.

F. Message disappear/reappear detection
- Render a message.
- Remove it from visible list.
- Re-add it within the same conversation.
- Assert message_disappeared and message_reappeared are emitted.

G. Reorder detection
- Render messages in order A, B, C.
- Update list to A, C, B without an allowed reason.
- Assert message_reordered is emitted.

H. Scroll anchor stability
- User is scrolled above bottom.
- New streaming content arrives or refetch occurs.
- Assert scroll position/anchor is preserved.
- Assert unexpected_scroll_jump is not emitted for valid preservation.
- Add a negative test where anchor jumps >48px and assert the jank event is emitted.

If the repo already has e2e tests, add one realistic e2e smoke test:
- Open chat.
- Send a message.
- Mock/trigger streaming response.
- Verify user message remains visible, assistant message streams, no duplicate messages appear, and UI reaches a completed state.

7. Dashboard/output MVP

Expose a small helper that computes a per-conversation jank summary:

{
  conversationId,
  jankEventCount,
  messageDisappearCount,
  duplicateCount,
  reorderCount,
  tokenRollbackCount,
  streamStallCount,
  unexpectedScrollJumpCount,
  noVisibleFeedbackCount,
  isJankFree
}

This can be used in tests and later analytics.

8. Acceptance criteria

The work is complete only when:
- Chat messages use stable identity through optimistic send, streaming, server persistence, and refetch.
- Jank events are emitted for the listed failure modes.
- Tests cover the listed MVP cases.
- Existing tests still pass.
- No message content is logged in analytics unless already approved by existing project patterns.
- No broad rewrite of the chat system is done unless unavoidable.
- Any unavoidable architectural change is documented in the final summary.

Execution instructions:

1. Inspect the repo.
2. Make a short implementation plan.
3. Implement the smallest robust version.
4. Add/modify tests.
5. Run the relevant local test suite.
6. Fix failures.
7. Run:

gstack skills /qa --exhaustive

8. Use the QA output to repair failing tests, regressions, or obvious edge cases.
9. Re-run the targeted tests and then re-run:

gstack skills /qa --exhaustive

10. Repeat until tests pass or until there is a clearly documented external blocker.

Final response should include:
- Files changed.
- What jank events were implemented.
- What tests were added.
- Commands run.
- Test/QA results.
- Any remaining risks or follow-up work.
```

I’d make Claude implement this as an MVP before deeper observability. The first win is proving whether messages are being removed/recreated, duplicated during reconciliation, or overwritten by stale refetches.
