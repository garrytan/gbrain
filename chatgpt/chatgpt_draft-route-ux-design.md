---
conversation_id: 6a08f15d-a490-83e8-a19b-92877bf11974
created: 2026-05-16
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Draft Route UX Design
type: note
updated: 2026-05-16
---

# Draft Route UX Design

**Related:** [[design_ux]]

> Conversation ID: 6a08f15d-a490-83e8-a19b-92877bf11974
> Created: 2026-05-16T22:36:15Z
> Updated: 2026-05-16T22:36:25Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_000000009c0471f88e1f9eb73f2dbe53', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 500, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 93122, 'width': 1900}

---

## Assistant

1. Draft Route (Recommended)  
Best UX for speed and perceived responsiveness.

Flow:
- User clicks New Thread
- Immediately navigate to `/draft/[localId]`
- Render optimistic thread shell instantly
- Start streaming/generating immediately
- Server creates canonical thread in background
- When real thread ID returns:
  - silently replace URL with canonical route using `router.replace`
  - preserve scroll/input/stream state
  - no full rerender

This is effectively how Linear/ChatGPT-style apps should behave.

Why this wins:
- Instant navigation
- No blank waiting state
- No “Welcome Back Tim” flash
- No skeleton mismatch
- Allows speculative UI before persistence
- Easier to support offline/retry/error states

Critical implementation detail:
The provisional draft route and real route must share the SAME React tree shape and state container. Otherwise you get:
- flicker
- remounts
- streaming resets
- message disappearance
- skeleton flashes

You want:
- stable chat shell
- stable message list component
- stable input component
- stable suspense boundaries

Only the backing thread ID changes.

2. Local URL ID  
Similar idea but worse semantics.

Example:
`/thread/local_abc123`

Then later:
`/thread/realId`

Problem:
- fake IDs leak into app logic
- harder cache semantics
- analytics pollution
- edge cases around refresh/share/open-in-new-tab

Draft namespace is cleaner:
`/draft/abc`
→
`/thread/xyz`

3. Server First  
Worst perceived UX.

Flow:
- click
- spinner
- wait for DB
- wait for route
- navigate later

This is exactly the sluggish feeling you described.

Causes:
- dead click feeling
- skeleton flashes
- transition instability
- compounded latency

Your actual problem is not just latency. It’s unstable UI topology during navigation.

Recommendation:
- optimistic draft route
- shared shell
- no loading screen between states
- URL replace after canonicalization
- preserve stream state across route replacement
- absolutely no skeleton after first paint

The skeleton should only ever appear:
- on true cold app boot
- never during intra-chat transitions

The current “Welcome Back Tim” intermediate state should be removed entirely from New Thread flow.


**Topic:** [[chatgpt-clusters/design_ux]]


## See Also
- [[chatgpt/chatgpt_apology-letter-draft]]
- [[chatgpt/chatgpt_ar-post-draft]]
- [[chatgpt/chatgpt_chris-voss-reply-draft]]
- [[chatgpt/chatgpt_chris-voss-response-draft]]
- [[chatgpt/chatgpt_draft-cocktail-menu-part1]]
