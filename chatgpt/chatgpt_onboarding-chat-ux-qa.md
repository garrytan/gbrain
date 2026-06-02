---
title: "Onboarding Chat UX QA"
type: note
created: 2026-05-14
updated: 2026-05-14
source: chatgpt-export
conversation_id: 6a05303c-8014-83e8-bafb-c9bbad3c24c5
message_count: 1
tags: [chatgpt, import]
---
# Onboarding Chat UX QA

> Conversation ID: 6a05303c-8014-83e8-bafb-c9bbad3c24c5
> Created: 2026-05-14T02:15:28Z
> Updated: 2026-05-14T02:50:49Z
> Messages: 1

---

## User

i need exhaustive /qa on this whol eonbaording chat now.

not only should you look for breakage but i need the chat interface to be world class with 0 ux/ui issues in every state. the artist and entity chips need to looks great and tool calling should look amazing. Heavily test for:
- jitter and jank
- screen refreshing
- messages disappearing and re-appearing
- text font smoothing
- any kind of layout shifting, all the way from start to the final thing
Also, audit the actual chat responses and stuff to see if it should be properly handling objections and user reviewing and all that shit. All of that needs to be generally hardened.

Help me improve the above response by asking it to build testing, looking at what the world-class onboarding experiences are of chat interfaces like Stanley for Twitter and shit like that, where you're user-interviewing before you're even explaining the products. It is all grounded in what we're trying to do with all the experiences and stuff, and all of the different UI states of that chat and enriched data. It is showing the pop out and everything in the expanded mode, making sure that all the UX and all that shit is solid. Basically want to have a 5.5 inside codex just set at an incredibly high bar test, and then loop until it passes and then ship it. 
