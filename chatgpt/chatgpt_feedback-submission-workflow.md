---
title: "Feedback Submission Workflow"
type: note
created: 2026-03-06
updated: 2026-03-06
source: chatgpt-export
conversation_id: 69aa1bac-b3b8-832a-9595-4fe114cb1e8d
message_count: 4
tags: [chatgpt, import]
---
# Feedback Submission Workflow

> Conversation ID: 69aa1bac-b3b8-832a-9595-4fe114cb1e8d
> Created: 2026-03-06T00:14:26Z
> Updated: 2026-03-06T00:27:48Z
> Messages: 4

---

## User

We should allow sharing feedback directly through the chat interface, and for now, that should be one of the primary suggestions. And then when you, and that should flow off a deterministic workflow, it should not use AI, and it should just prompt you to share your feedback, and then when you share it, it should get submitted through our existing feedback API so that it lands in the admin dashboard. We should also maybe consider if it makes sense or not, so this is a question for you, if it makes sense to switch feedback over to, instead of it being in an admin thing or something, if it makes sense to open them as linear issues, and then we can either accept or reject them. I don't know if that makes sense. Or maybe instead of that, maybe we put a button in the admin, yeah, this sounds better actually. Put a button in the admin interface on the feedback page that is like a, for each item, have like a copy as markdown button, and then have maybe like a copy all as markdown button, and then that should be enough that I can just copy those items and paste them into any AI agent to have them work on it. We also need to make sure that the waitlist gating is properly working, and has proper test coverage. And we need to implement some test coverage rules, like, you know, skipping test coverage on like UI things that are constantly changing, but having thorough test coverage elsewhere where it matters, like, not having it where it's gonna slow down, but ensuring that it's written at the time of creation for things that it makes sense for, and updating the agents MD file accordingly. So just list out all those issues as bullet points that I can copy and paste.

---

## Assistant

- **Add chat-based feedback submission (deterministic workflow)**
  - Add a primary suggestion in the chat interface allowing users to submit feedback directly.
  - The flow must be deterministic and **must not use AI**.
  - Trigger a simple prompt asking the user to share feedback.
  - On submission, send the feedback through the **existing feedback API** so it appears in the admin dashboard.

- **Ensure chat suggestion placement**
  - Surface the feedback submission option prominently in the suggestion list within the chat UI.
  - Treat it as one of the primary suggestions available to users.

- **Admin interface: Copy feedback as Markdown**
  - Add a **“Copy as Markdown”** button for each feedback item in the admin feedback page.
  - The copied content should include:
    - Feedback text
    - Metadata if useful (user, timestamp, context, etc.)
  - Format output cleanly as Markdown suitable for pasting into AI agents or issue trackers.

- **Admin interface: Copy all feedback as Markdown**
  - Add a **“Copy All as Markdown”** button on the feedback page.
  - Output all visible feedback items in structured Markdown format.
  - Ensure formatting is optimized for pasting into AI agents or project planning tools.

- **Waitlist gating verification**
  - Audit the waitlist gating logic to ensure it is functioning correctly.
  - Confirm gating is enforced across all relevant entry points.

- **Add test coverage for waitlist gating**
  - Implement thorough automated tests validating waitlist behavior.
  - Include tests covering:
    - Allowed users
    - Blocked users
    - Edge cases around access state changes.

- **Establish test coverage guidelines**
  - Define rules for when tests are required.
  - Skip strict coverage requirements for **rapidly changing UI components**.
  - Require tests for:
    - Core logic
    - APIs
    - Gating systems
    - Deterministic workflows
    - Data processing or backend services.

- **Require tests at feature creation**
  - For areas where tests are required, ensure test coverage is written **at the time the feature is created**, not retroactively.

- **Avoid test overhead that slows development**
  - Apply coverage selectively to avoid slowing iteration speed.
  - Focus testing where correctness and reliability are critical.

- **Update `agents.md`**
  - Document the new testing rules and expectations.
  - Include guidance on:
    - Where tests are required
    - Where tests may be skipped
    - Standards for deterministic workflows vs AI workflows.

---

## User

I need to make sure that the audio player is functional in the releases sidebar, and it uses the 30-second sample that we're pulling in from MusicFetch. What's up, baby?

---

## Assistant

Mr. White,

- **Releases sidebar audio player uses MusicFetch 30-second sample**
  - Verify the sidebar player requests the `preview_url` (or equivalent 30-sec sample field) returned by MusicFetch for each release.
  - Block full-track URLs from being used in the sidebar player.

- **Playback functionality in sidebar**
  - Play / pause works reliably.
  - Switching releases stops the previous audio and starts the newly selected release.
  - Progress updates during playback; resets on stop/end.
  - On end, player state returns to idle (or shows replay) without errors.

- **Fallbacks and error states**
  - If no 30-sec sample exists, disable play and show “No preview available”.
  - Handle 403/404/timeouts with a user-visible error and silent retry/backoff (no infinite loops).

- **Preload and UX**
  - Use `preload="none"` or controlled prefetch to avoid bandwidth spikes in the sidebar.
  - Prevent multiple concurrent audio instances across the app (singleton player or shared audio context).

- **Test coverage**
  - Unit tests: mapping from MusicFetch response → sidebar audio source.
  - Integration tests: play/pause, switch release, end-of-track, and no-preview behavior.
  - Mock audio element events (`canplay`, `timeupdate`, `ended`, `error`) to avoid flaky tests.

“What’s up” acknowledged.


## See Also
- [[chatgpt/chatgpt_automated-role-submission]]
- [[chatgpt/chatgpt_music-submission-email]]
- [[chatgpt/chatgpt_playlist-submission-table]]
- [[chatgpt/chatgpt_role-submission-automation]]
- [[chatgpt/chatgpt_speedrun-application-submission]]
