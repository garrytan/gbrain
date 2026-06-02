---
title: "Keyboard Shortcut Rule System"
type: note
created: 2026-05-10
updated: 2026-05-10
source: chatgpt-export
conversation_id: 6a00c840-047c-83e8-b757-81f3086ff6f6
message_count: 1
tags: [chatgpt, import]
---
# Keyboard Shortcut Rule System

> Conversation ID: 6a00c840-047c-83e8-b757-81f3086ff6f6
> Created: 2026-05-10T18:02:42Z
> Updated: 2026-05-10T18:25:19Z
> Messages: 1

---

## User

fBuild me a world-class rule that I can guardrail, that I can implement into our systems. Any time we ship a new feature, we automatically evaluate if it needs a keyboard shortcut or not and what that keyboard shortcut should be. We register it into the central keyboard shortcut registry so that it automatically populates on the keyboard shortcut helper screen that lists them all.
The feature automatically gets a tooltip that shows the keyboard shortcut, and the keyboard shortcut is functional and works and has test coverage in both the web app and the Mac app and the Electron app. The test coverage is to make sure that those keyboard shortcuts don't still work and don't get overwritten by system shortcuts or something.
I would generally do some research to figure out what are the world-class things and figure out how to build this rule system, right? We want linear power user type shit where it's like:
- I can scroll through issues of J&K (I have Command K, Command Prompt).
- I can get to the chat through a keyboard shortcut.
- I should be able to toggle the sidebar.
- I should be able to toggle the waveform, the audio player.
- I should be able to get to lyric mode for playing a song.
- If a song is playing, I should be able to assign a task to someone with a keyboard shortcut.
- Search, all that kind of stuff, all the things that you would mainly use.
I basically want you to go out and look at what are world-class applications that are keyboard-first and linear. Look at command center type apps, look at Power User apps, look at audio apps, look at Mac Native apps. Figure out how to do this. Figure out what shortcuts we should avoid because they're going to be overridden by the browser or the operating system is going to conflict with them or something like that. Figure out how we make it so that it's Mac-first, but if someone is on the PC, it's not a total pain in the ass. Try to avoid a shortcut that's easy on a Mac but really hard on a PC or something like that.
Our customers are heavily Mac users. You make music, usually just on a Mac. It's your fucking audio driver bullshit and stuff, and all the audio applications just run better on Macs. They always have. Most studios are Mac-based.
Help me build this as a rule, and then help me build self-healing for it too. Make a recommendation of how to do that to make it ever improving.


## See Also
- [[chatgpt/chatgpt_gym-essentials-shortcut-setup]]
- [[chatgpt/chatgpt_airbnb-rule-violations]]
- [[chatgpt/chatgpt_auth-system-with-toast-pin]]
- [[chatgpt/chatgpt_building-jovie-knowledge-system]]
- [[chatgpt/chatgpt_bulk-cut-cycle-system]]
