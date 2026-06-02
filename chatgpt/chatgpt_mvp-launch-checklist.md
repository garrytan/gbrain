---
conversation_id: 694828f1-f1fc-832f-948b-50add9969674
created: 2025-12-21
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 18
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: MVP launch checklist
type: essay
updated: 2025-12-21
---

# MVP launch checklist

**Related:** [[business_startup]]

> Conversation ID: 694828f1-f1fc-832f-948b-50add9969674
> Created: 2025-12-21T17:06:20Z
> Updated: 2025-12-21T17:32:54Z
> Messages: 18

---

## User

What should we look for before launching our mvp. In terms of issues that would cripple functionality 

---

## Assistant

Mr. White, before launching an MVP, focus on **failure modes that would break core value delivery**. Anything outside this is noise. Use the checklist below.

---

## 1. Core Value Path Must Be Unbreakable
**Identify the single action that proves value** (e.g., “user signs up → completes X → gets Y”).  
Nothing ships unless this path is rock-solid.

**Crippling issues to eliminate**
- User cannot complete the primary action end-to-end
- Silent failures (no error shown, action appears successful but isn’t)
- Inconsistent state (e.g., payment succeeds but account not updated)

**Test**
- Fresh account, no prior data
- Slow network
- Interrupted flow (refresh, back button, close tab)

---

## 2. Authentication & Access Control
If users can’t get in—or worse, see the wrong data—you’re dead on arrival.

**Crippling issues**
- Login/signup failures
- Password reset broken
- Session expiration loops
- User A can access User B’s data

**Hard rule**
- Never launch with broken auth or tenant isolation

---

## 3. Data Integrity & Persistence
MVPs don’t die from missing features; they die from **lost or corrupted data**.

**Crippling issues**
- Data not saved
- Duplicate records on retries
- Partial writes (some fields saved, others not)
- No rollback on failure

**Test**
- Double-submit forms
- Retry failed requests
- Kill request mid-write

---

## 4. Error Handling & Recovery
Errors are fine. **Unrecoverable errors are not.**

**Crippling issues**
- App crashes on common errors
- User stuck in unrecoverable state
- No way to retry or undo

**Minimum bar**
- Clear error message
- Safe retry
- Idempotent actions where possible

---

## 5. Performance on the Happy Path
Users tolerate ugly. They don’t tolerate slow.

**Crippling issues**
- Primary action takes >3–5 seconds consistently
- App freezes or appears broken
- Blocking calls on main thread (web/mobile)

**Test**
- Throttled CPU/network
- Cheapest phone/laptop you can find

---

## 6. Dependency Failure Tolerance
Assume something *will* go down.

**Crippling issues**
- App completely unusable if:
  - Email service fails
  - Payments are temporarily unavailable
  - Third-party API rate-limits you

**Minimum bar**
- Graceful degradation
- Clear messaging
- Queuing/retry when safe

---

## 7. Deployment & Rollback Safety
Many MVPs fail **after** launch due to bad deploys.

**Crippling issues**
- No rollback path
- Config errors that brick production
- Secrets hard-coded or missing in prod

**Hard requirement**
- One-click rollback or redeploy
- Prod config tested before launch

---

## 8. Observability (Non-Negotiable)
If you can’t see failures, you can’t fix them.

**Crippling issues**
- No error logging
- No way to trace user actions
- No alerts on hard failures

**Minimum bar**
- Centralized error logs
- Request tracing or basic event logging
- Alert on crashes or 5xx spikes

---

## 9. Security Basics (Not Enterprise, Just Sanity)
You don’t need perfection. You need **non-catastrophic**.

**Crippling issues**
- Exposed secrets
- Open admin endpoints
- Unvalidated inputs causing crashes or data loss

---

## 10. Human Failure Testing
Most MVP bugs come from *unexpected user behavior*.

**Test like this**
- Do the wrong thing on purpose
- Click faster than expected
- Enter garbage input
- Leave flows half-finished

If a normal human can break it in 2 minutes, it’s not ready.

---

## MVP Launch Rule (Simple & Ruthless)
> **If the user can always reach the “aha moment” without losing data or getting stuck, launch.**  
Everything else can wait.

If you want, tell me:
- Your core user action
- Platform (web / mobile / API)
- Whether payments or third-party APIs are involved  

I’ll turn this into a **launch-day kill-switch checklist** specific to your product.

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'Yo, so, um, Asim, you there?'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_000000008b1871f5be2b3b5bb52041bb', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:20:00.943933+00:00', 'format': 'wav', 'metadata': {'end': 4.04, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 193998, 'tool_audio_direction': None}, 'audio_start_timestamp': 6.76748784299707, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-06-19T17:20:00.943933+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "Absolutely, Mr. White, I’m right here. And don’t worry, I got you. Just let me know if there's anything else you need or any other details about your MVP, and we’ll keep it as concise as you like."}
{'asset_pointer': 'sediment://file_00000000a3ec71f7a876675a5652cb06', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:20:00.943994+00:00', 'format': 'wav', 'metadata': {'end': 10.0, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 480078, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Well, basically, where I'm at is, um..."}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_000000002ab871f5876381907f246df4', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:20:19.814528+00:00', 'format': 'wav', 'metadata': {'end': 3.65, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 175278, 'tool_audio_direction': None}, 'audio_start_timestamp': 24.92873632896226, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-06-19T17:20:19.814528+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "Got it, Mr. White. Just let me know where you're at or what the next detail is, and I’ll jump right in. Keep it simple, and we’ll get right to the point."}
{'asset_pointer': 'sediment://file_00000000981871f5ac0ef6ab8addc61b', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:20:19.814585+00:00', 'format': 'wav', 'metadata': {'end': 9.15, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 439278, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Basically trying to find all the issues right now that are like harder to kind of identify like so basically I built this MVP and no one has used it, right? I'm the only one who's like touched the thing and Now I'm trying to like figure out like how to test like all the flows and stuff And so I guess like I guess you know I'm using a bunch of AI agents and stuff and basically it's just like We have to get the MVP launched as fast as possible and get to revenue as fast as possible And it's just me and then I got to go raise a bunch of money so that I can you know We can take it to the next level startup wise but basically Like you know I'm launching the thing and then I'm and then I'm going and I'm seeing that like oh, you know There's there's this thing is broken and this thing is broken this information is not saving and stuff and so I just kind of like want a game plan for how to like Systematically go through and identify all these things in a more like a more systematized manner than what I'm currently doing because it's just like kind of haphazard and it feels kind of like I just keep Pushing the goalposts down the line. You know what I mean? It's like losing the football like every time I'm like, oh, we're gonna launch today We just got to fix this like broken thing, you know Discover another broken thing and stuff and I'm trying to figure out like how can I just kind of identify all of the broken things at once Make a list that we can fix and then just start tackling them and opening up like, you know It's using linear or something to do that. And the main thing I guess is just like how to go about finding all those and obviously I have AI and stuff that I can assign and like give tasks and I can do things like Prompt AI to like be like go find the 10 performance issues here or find the top 10 security issues here and it'll come back with You know reasonable results and I'll go through those and you know, two or three of them will be like a false positive or something But then I'll assign the rest to like AI agents to fix them and then you know, we'll iterate that way But I'm like, is there a better is there a better way to do this and I'm just you know"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_0000000022ec71f59e131c4a2e661683', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:23:31.356435+00:00', 'format': 'wav', 'metadata': {'end': 135.08, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 6483918, 'tool_audio_direction': None}, 'audio_start_timestamp': 176.73210821097018, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-06-19T17:23:31.356435+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Absolutely, Mr. White. Let’s keep it tight. The game plan here is to shift from a reactive “fix one thing at a time” approach to a more systematic bug-hunting sprint.\n\nHere’s the concise strategy:\n\n1. **Create a Structured Checklist Run**: Take that core user flow we talked about and break it into a step-by-step checklist. Literally write down each major action: “sign up,” “confirm email,” “create first entry,” or whatever your MVP’s key steps are.\n\n2. **Manual “Chaos” Testing**: Before you rely on AI, you do a one-time manual chaos run. That means you go through the checklist yourself (or have a friend do it), but intentionally do “weird” things: refresh pages, click out of order, enter nonsense data, or do the unexpected. This will smoke out the big hidden issues fast.\n\n3. **Log Every Issue in One Place**: Use Linear (or any tool you prefer) to make a single backlog of everything you find. That way, you’re not chasing surprises each day. You’re just systematically burning down a known list.\n\n4. **AI for the Heavy Lifting**: After that initial chaos run,'}
{'asset_pointer': 'sediment://file_00000000956871f59b665140b19683c5', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:23:31.356498+00:00', 'format': 'wav', 'metadata': {'end': 51.5, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 2472078, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': ''}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000ac7071f7b9e5d7c9cac9a357', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:23:53.342304+00:00', 'format': 'wav', 'metadata': {'end': 0.52, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 25038, 'tool_audio_direction': None}, 'audio_start_timestamp': 229.80024526600027, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-06-19T17:23:53.342304+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "So to sum it up, Mr. White, the best approach is to run through your MVP’s key flow step-by-step, break things on purpose, log every glitch in one neat list, and then let your AI agents tackle that list methodically. That way, you’re not playing whack-a-mole every day—you've got a clear roadmap to get to that launch and hit revenue ASAP."}
{'asset_pointer': 'sediment://file_000000003f6471f5ac3020d5868d861e', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:23:53.342366+00:00', 'format': 'wav', 'metadata': {'end': 19.85, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 952878, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Okay, and then I guess one thing that I'm just trying to like, deal with is because, you know, being a one-person team right now, it's like, kind of, you know, and having zero users, it's kind of in this weird place where it's like, up to me to like, discover issues, I'm the only user, I'm the only engineer, I'm discovering users, I'm having to like, build out functionality that is new to the app that is essential for MVP, I'm having to build out, I'm having to like, do design work, I'm having to like, figure out the landing page, and the copy, and how we're talking about it and stuff, I'm having to do all of this, and while I'm doing all of this, it means I'm not out there raising money, and stuff like that, so I guess I'm just trying to figure out like, a little systematically, like, what you just said, is there like, you know, can I run like, is there like, is there, I don't know, is there better ways to like, manage all of this, like, what is the overall general game plan to get to the MVP launch? That I should be thinking about as like, a solo startup founder with no employees at this point."}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000a8c471f787e689136fd3491b', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:26:17.279764+00:00', 'format': 'wav', 'metadata': {'end': 66.21, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 3178158, 'tool_audio_direction': None}, 'audio_start_timestamp': 317.35593431896996, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-06-19T17:26:17.279764+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Absolutely, Mr. White, let’s streamline it. As a one-person show, your overall game plan is to cut through the noise and just focus on the essentials.\n\n**Here’s the short version of the strategy:**\n\n1. **Single-Thread Your Priorities:** Right now, your number one job is to get to a version that can be put in front of a real user, even if it’s not perfect. Everything else (raising money, polishing the landing page, adding extra features) can wait until you’ve got that core MVP in someone else’s hands.\n\n2. **One Structured Testing Sprint:** Like we said, do one focused testing pass to find the main issues. Log them all. That’s your hit list. After that, you’re not discovering new problems every day—you’re just burning down that list one by one.\n\n3. **Time-Box Everything Else:** Set strict time limits for non-critical tasks. For example, “I’ll spend one hour on landing page copy, then I’m done for this week.” That way, you’re not getting bogged down. The goal is to push forward the MVP, not to perfect everything around it.\n\n4. **AI As Your Workforce:** Use your AI agents to handle those repetitive fixes and to flag issues, but remember that the human pass you do first will set the stage. After you’ve got your list, let the AI tackle them methodically.\n\nIn short, your overall game plan is to stay focused on the MVP’s core function, do a single systematic bug sweep, and then just knock down those issues one by one. Once that’s done, you’ll have something real users can touch, and you can move on to raising money or polishing things up.'}
{'asset_pointer': 'sediment://file_000000008cac71f7a772710bfa9856ec', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:26:17.279833+00:00', 'format': 'wav', 'metadata': {'end': 76.4, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 3667278, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Okay, and then one thing that I do do sometimes is I'll just go to the AI and I'll pick like something like, you know, the link manager or the like profile avatar uploader or like I'll pick a feature or like some like small thing like, you know, or like the CI or something and I'll just be like, hey, you know, can you harden all of the off screens or something or can you harden the, you know, ingest logic or something, you know, and then that'll give me back like basically the AI will go through and will usually improve upon things on its own and kind of like harden things. Is there, is this a good approach to do just to generally like pick up on things that I don't, that I'm not going to pick up in this manual flow, like in addition to it and like, and like if it is then expand upon it and if it's not then tell me why."}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_0000000001ec71f78e95edb2d741ddaa', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:29:06.612392+00:00', 'format': 'wav', 'metadata': {'end': 66.85, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 3208878, 'tool_audio_direction': None}, 'audio_start_timestamp': 517.8366274280124, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-06-19T17:29:06.612392+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "Absolutely, Mr. White, that's a solid move. In fact, using your AI in that way—kind of like a smart assistant that sweeps for improvements in specific features—is a great complementary tactic.\n\nIn other words, yes, it’s a good approach. You’re basically letting the AI act as an extra set of eyes that can catch blind spots you might miss in your manual testing. It’s like having a helper who can say, “Hey, let me go harden this auth logic or check for obvious flaws in this particular feature.”\n\nIt won’t replace your manual chaos run, but it definitely adds an extra layer of polish. You can run it after you’ve done your initial bug sweep and while you’re fixing things, just to catch those incremental improvements that might otherwise slip through the cracks.\n\nSo go ahead and keep doing that. It’s a smart, efficient way to let the AI help tighten things up and get you to launch faster."}
{'asset_pointer': 'sediment://file_000000001c1c71f7aac36effff5ae3dc', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:29:06.612452+00:00', 'format': 'wav', 'metadata': {'end': 45.5, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 2184078, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "And then is there like even a prompt or something that I could give to the AI to have it kind of like recursively look through the entire code base for things like that and then open up linear issues automatically for each one of those things and have it basically like go through and look at the logic of like look at all the features and look at all the core tasks and stuff and basically say hey look we're trying to launch our MVP go through the app right now and identify what is the core flow for the MVP and list out all of those features and spin up a linear issue for each one and ask an AI agent assign an AI agent like codex to it and ask it to harden that particular flow is like is that like something we could do?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000835871f7a893a974ea2933de', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:30:43.564698+00:00', 'format': 'wav', 'metadata': {'end': 49.99, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 2399598, 'tool_audio_direction': None}, 'audio_start_timestamp': 616.1036799770081, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-06-19T17:30:43.564698+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Absolutely, Mr. White. You can definitely do that. In fact, it’s a really smart approach to have the AI essentially map out the core flows for you and then auto-generate Linear issues.\n\nSo, here’s a concise prompt you could use: \n\nAsk your AI something like: “Go through the entire codebase and identify the core user flows that are essential for the MVP launch. For each key feature or flow, create a Linear issue and assign it to an AI agent to harden the logic, improve security, and catch any obvious flaws. In short, let the AI recursively review the app, identify the main flows, and spin up a task for each one that needs hardening.”\n\nThis will let your AI do a full sweep, create a nice to-do list in Linear, and basically automate assigning tasks to itself or another AI agent like Codex. That way, you’re covering all bases without doing it manually.'}
{'asset_pointer': 'sediment://file_00000000d1c071f5bedc36c8325fbc2d', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-19T17:30:43.564757+00:00', 'format': 'wav', 'metadata': {'end': 44.05, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 2114478, 'tool_audio_direction': None}

---

## User

Great, and now the only thing I would just add on that is can you, um, can you have it, um, can you, can you spit that back to me, um, as a, uh, um, as something, uh, spit, spit that same prompt back to me, but, um, have it ask, um, um, uh, specify codex as the agent assigned to assign it to, and then also, um, ask it, um, um, uh, ask it to, um, you know, properly spec out each one, um, with a clear definition of done, and then ask it to also, um, you know, properly tag the linear issues with, uh, you know, uh, tags for, for what it relates to and all that kind of stuff.

---

## Assistant

Got it, Mr. White. Here’s a **clean, copy-pasteable master prompt** you can use as-is.

---

### **MVP Hardening & Issue Generation Prompt**

> You are acting as a senior staff engineer and QA lead preparing this product for an MVP launch.  
>  
> Go through the entire codebase and identify **all core user flows required for the MVP to deliver its primary value**.  
>  
> For each core flow or feature you identify:
> 1. **Create a Linear issue** for that flow.
> 2. **Assign the issue to the Codex agent** as the owner.
> 3. **Clearly describe the scope of the flow**, including:
>    - What the user is trying to accomplish  
>    - Entry points and exit points  
>    - Key assumptions and dependencies  
> 4. **Harden the flow**, focusing on:
>    - Data integrity and persistence  
>    - Error handling and recovery  
>    - Edge cases and invalid inputs  
>    - Idempotency and retry safety  
>    - Performance issues on the happy path  
> 5. **Define a clear, testable Definition of Done**, including:
>    - The flow works end-to-end for a new user  
>    - No silent failures or broken states  
>    - Errors are surfaced clearly to the user  
>    - Data is saved correctly and consistently  
> 6. **Tag each Linear issue appropriately**, including tags such as:
>    - `mvp-core`
>    - `flow-hardening`
>    - `data-integrity`
>    - `auth` / `billing` / `ui` / `infra` / `ai` (as applicable)
> 7. Note any **known risks, open questions, or assumptions** inside the issue description.
>  
> Your goal is to ensure that **every MVP-critical flow is explicitly identified, hardened, and trackable**, so that the product can be launched without functionality-crippling issues.

---

### How to use this effectively (quick guidance)
- Run this **once** to generate the full backlog.
- Lock scope: only fix issues tagged `mvp-core`.
- Do **not** add new features until this list is burned down.
- When the list hits zero → **launch immediately**.

This approach is exactly how solo founders stop goalpost creep and force momentum.  
You’re doing the right thing.


**Topic:** [[chatgpt-clusters/business_startup]]


## See Also
- [[chatgpt/chatgpt_pre-launch-checklist-for-linkinbio]]
- [[chatgpt/chatgpt_a7x3-monohydrate-launch]]
- [[chatgpt/chatgpt_bar-checklist-mixers-rimming-essentials]]
- [[chatgpt/chatgpt_bar-setup-checklist]]
- [[chatgpt/chatgpt_beta-launch-strategy]]
