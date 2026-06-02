---
title: "Sports graphics technology"
type: note
created: 2025-10-28
updated: 2025-10-28
source: chatgpt-export
conversation_id: 690033e0-879c-8328-b71a-4678753d3fe2
message_count: 2
tags: [chatgpt, import]
---
# Sports graphics technology

> Conversation ID: 690033e0-879c-8328-b71a-4678753d3fe2
> Created: 2025-10-28T03:10:08Z
> Updated: 2025-10-28T03:12:01Z
> Messages: 2

---

## User

On broadcast TV, how are sports game overlays and graphics packages dynamically updated? Are they using some kind of web interface or live scripting? Is there hardware that takes inputs? What are they using to do that? Is it something like Fusion or After Effects using a scripting API or something? Or is it more like React or Next.js or something generating something? Or how are they doing it? Or is there a custom hardware platform? What are they doing to do that?

---

## Assistant

Mr. White — short version: live sports overlays aren’t built in After Effects or React at air-time. They’re rendered by real-time “CG engines,” driven by data and an operator UI, and keyed over program video via key+fill (SDI or ST 2110) or NDI with alpha. HTML5/cloud engines are also common now, especially for smaller or remote shows.

# How it actually works (runtime)
- **Templates + data binding:** Designers build templates with fields (score, clock, stats). On air, a control app binds those fields to live data feeds (scoreboard, stats APIs) or to operator inputs, then plays the scene in real time. Examples: Viz Engine/Viz Trio, Ross XPression, Chyron PRIME. citeturn7search0turn6search12turn3search2turn6search4turn6search0  
- **Data sources:** Venue scoreboards (Daktronics All-Sport, Sportzcast/Scorebot) and external stats feeds (Sportradar, Opta/Stats Perform) push JSON/XML or serial data that auto-updates the scorebug/boards. citeturn0search15turn5search10turn5search12turn2search0turn2search1
- **Playout & control:** Operators trigger “take/animate out” from dedicated UIs (Viz Trio, XPression Remote Sequencer) or custom control panels (Ross DashBoard). Systems also support scripting (Lua/JavaScript) for logic and data handling. citeturn6search12turn6search4turn3search0turn2search2turn2search23

# What moves the pixels
- **Real-time CG engines (truck/arena level):**  
  - **Vizrt** (Viz Engine + Trio) — 2D/3D, data-driven playout, MOS/automation support. citeturn7search0turn0search3  
  - **Ross XPression** — on-brand, data-driven 2D/3D with multi-channel playout. citeturn0search4  
  - **Chyron PRIME/Lyric** — template authoring, strong data binding & scripting for live sports. citeturn6search0turn2search5turn2search14
- **HTML5/cloud engines (lightweight to mid-tier):** **Singular.live** and **Viz Flowics** render HTML5 graphics in-cloud or on-prem; great for remote/OTT and MOS-integrated workflows. (Yes, these are JavaScript/HTML/CSS under the hood.) citeturn0search14turn0search6
- **Open/affordable stack:** **CasparCG** (real-time playout) renders HTML templates; controlled via AMCP or tools like SPX. Common in collegiate/esports. citeturn4search15turn4search0turn4search7
- **AR/Virtual ads & on-field graphics:** Systems like **Viz Arena** and legacy “1st & Ten” tech lock graphics to the field using tracking/calibration. citeturn1search11turn1search0turn1search1

# I/O and “how does it get on air?”
- **Key + fill:** CG outputs two synchronized feeds: fill (color) and key (alpha matte) to the switcher’s DSK/USK. Over IP, ST 2110 carries key/fill as separate essences; NDI can carry straight RGBA with alpha. citeturn0search2turn3search13turn5search7
- **Scoreboard hardware inputs:** Dedicated boxes (Daktronics Live Score Bug; Sportzcast Scorebot/ScoreLink) convert scoreboard controller data to feeds your CG/overlay can consume. citeturn0search11turn0search8turn5search12
- **Triggers/automation:** GPI/O, macros, or IP protocols (RossTalk, REST/UDP) can auto-fire graphics from the switcher, replay, or timing events. citeturn3search3turn3search17

# So… is it Fusion/After Effects or React?
- **After Effects / Fusion:** used to **design** looks (pre-renders, textures), not to render live on a game. AE isn’t a deterministic real-time playout engine; it RAM-previews rather than guaranteed real-time output. citeturn7search8
- **React/Next.js:** not in the truck switcher; but **HTML5 engines** (Singular/Flowics/CasparCG templates) are just web tech, so teams often build templates/controls in vanilla JS or frameworks. citeturn0search14turn0search6turn4search10

# A typical scorebug path
Scoreboard console (All-Sport/Scorebot) → data feed (serial/IP/JSON) → CG template (XPression/Viz/Chyron/HTML5) with bound fields → operator “Take” → switcher keys the **fill + key** over program. citeturn0search1turn0search4turn3search13

If you tell me your target scale (solo stream vs. school vs. RSN/truck), I’ll lay out a concrete, buyable stack.
