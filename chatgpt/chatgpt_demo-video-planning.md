---
title: "Demo Video Planning"
type: note
created: 2026-05-25
updated: 2026-05-26
source: chatgpt-export
conversation_id: 6a14b6dd-b53c-83e8-9860-3fe96d666ef6
message_count: 4
tags: [chatgpt, import, long-form]
---
# Demo Video Planning

> Conversation ID: 6a14b6dd-b53c-83e8-9860-3fe96d666ef6
> Created: 2026-05-25T20:53:51Z
> Updated: 2026-05-26T05:57:20Z
> Messages: 4

---

## User

So I just used Google Flow with Google Omni. I gave it a spec for a character named Summer, and then I gave it a spec for a location: a recording studio in a bougie mansion in Malibu overlooking the ocean. I asked it to make a David Fincher-style cinematic tracking shot where the person is perfectly framed and the camera jibs in the opposite direction of their walk as they walk across the room holding a clock in their hand. It delivered results that are absolutely incredible, but there were a lot of issues with it. It didn't quite match the tracking, and I also wanted the camera trucking to the side and jibbing down. It didn't quite get the camera motion I wanted, but that was probably due to bad prompting. Her voice is a little whack, but it's just using whatever pre-made voice there is. I could redo that later in Eleven Labs and stuff, but the point is that the results were fucking amazing.
What I'm thinking right now is, can we make a sick demo video? I want to use this to start making a sick demo video. I'm trying to think about the best way to do this iteratively and systematically. The first thing is basically this: I can do a killer voiceover and sound design and stuff like that pretty easily. I'm just wondering if I want to make a killer demo video that'll be a 30-second demo video or a minute-long demo video. If I took screenshots of what we have for Jovie and put that all together on our website, it then might be beneficial to see.
My grand thinking is basically this: let me talk to the camera and be like, "Hey, I'm Tim White. I'm an artist from Los Angeles, and I'm the founder of Jovie. Jovie is [explain what Jovie is], and then give an example, and then logo sting and you're out." The next iterative step would be two examples:
1. Focusing on the fact that we want to keep artists in the studio. You're in the studio. You take a bathroom break. "Hey, I just came up with a new song." It would be even better if it was me talking from real advice, real stuff, so like, "Check out what Jovie can do for me." I have a song called "Never Say a Word," and I'd love to make some merch for it, so I'll just ask Jovie, "Let's make some merch for 'Never Say a Word.'" Jovie's like, "Jovie will show me three designs," and I'll pick this t-shirt. It's got one of the lyrics, and the lyric will be "You're kind of hot like me." I think people like that. I think people want to wear that. It's got a lot of emotional weight to it, or something like that, and then we design it. I really like this. It's a t-shirt, but I think it'd be even funnier if it was a phone case so that you see it when you're taking selfies, so I'll just ask for that. "Hey Jovie, can you make this new phone case?" Jovie's on it. She generates the phone case. I say, "Ship it," and she puts it live on my artist profile and schedules Friday texts to all of my fans. I just confirmed with Simple. Looks good, and it's done this Friday. All my fans will get a text message with a limited-time drop of the new branded phone case, and that's the example.
The next example could be Jovie also explaining more of the power of Jovie, because Jovie knows my whole catalog, right? She can do really cool things, and all the content we want to show off that Jovie's able to do that, because maybe even Jovie suggests, because she knows my song, she knows the lyrics, she has memory, right? Then we can say, "Oh, you're an artist, and Jovie has memory," so the next thing could be, "Oh, because Jovie knows, she knows things about you, for example. Jovie knows that it's Randy Jackson's birthday this week, right? She suggests that I share a photo on Instagram, and boom, there it is." Then show Jovie having a photo of me and Randy Jackson, and it's like "Happy birthday, dawg!" with an exclamation mark. You know what I mean? That's a post.
I think those two things would be enough that people would be like, "Holy shit, all right, this is great." You know what I mean? I think those are two really good examples, and then we can add more later. All I'm just trying to think about now is what's the best way to do this, because it's Google Flow and Omni stuff is amazing. I'm wondering if we should have our agents generate videos and then throw them into Google Flow, or if I should do the voiceover first and then throw down to Google Flow, because Google has a timeline and stuff. Or do we do this all and then just use the Google Omni API to generate the actual assets and have our deterministic playwright, kind of builder demo builder, do this and stuff? You know what I mean? I'm like, let me start thinking through how to execute on this.

---

## Assistant

Mr. White, I’ll frame this as an execution plan: lock the demo story, prototype timing cheaply, then use Flow/Omni for cinematic moments while keeping UI capture deterministic.

---

## User

Just for context, I have photos with Armin Van Buren, Randy Jackson, and Steve Aoki ready to go. I think Armin Van Buren or Randy Jackson probably would be the best because I've written a song with Randy Jackson and Armin Van Buren. I was signed to his record label, so I think those are a little bit stronger. Steve Aoki I only just know from bumping into him at events and stuff. 

---

## Assistant

Mr. White, the best path is **voiceover-first, Flow/Omni for cinematic hero shots, deterministic UI capture for product proof, and API automation only after the first cut works**.

## Core recommendation

Make a **30-second hero demo first**, then expand to a **60-second version** after the story lands.

The 30-second version should sell one idea:

> **Jovie keeps artists in the studio by turning catalog context into shipped fan campaigns.**

That aligns with Jovie’s current public positioning as an AI artist manager that watches an artist’s catalog, surfaces what to do next, and helps ship fan paths, presaves, or playlist pitches. citeturn614191view0

## Use the tools this way

### 1. Voiceover is the spine

Do the VO/script first. Then generate visuals against locked timestamps.

AI video is still unreliable for precise editorial timing. A VO track gives you a rigid structure, lets you cut with placeholders, and keeps Flow/Omni outputs from dictating the story.

Use Flow/Omni for:

- cinematic Malibu studio shots
- “Summer” character shots
- mood, world, tone, camera movement
- surreal/aspirational product moments

Use deterministic capture for:

- Jovie UI
- artist profile
- merch design selection
- phone case preview
- SMS campaign scheduling
- confirmation screens

Google describes Flow as an AI filmmaking tool built around Veo, Imagen, and Gemini, with support for creating cinematic clips/scenes and reusing characters, objects, and scenes consistently. The current Flow page also says Flow can blend text, image, and video inputs with Gemini Omni. citeturn742639view0 citeturn742639view1

### 2. Don’t make the entire demo AI video

The product demo has to feel real. The cinematic stuff should create emotion. The UI should create belief.

The structure should be:

> **Cinematic human world → Jovie action → UI proof → shipped result → emotional payoff.**

If everything is generated cinematic footage, viewers may think it is vapor. If everything is screen recording, it feels like SaaS. The combo is the win.

### 3. Use Flow manually before API automation

For v0, do **manual Flow iteration**. Get the hero look right. Save the prompts, reference assets, winning outputs, and failure cases.

Then move the repeatable pieces into a builder:

- Playwright captures product UI states.
- Remotion / After Effects / Premiere assembles the edit.
- Veo 3.1 API generates repeatable video modules.
- ElevenLabs or your own cleaned VO replaces any generated voice.

The public Gemini API docs currently point to **Veo 3.1** for video generation, including reference images, first/last frames, portrait/landscape, and video extension. Google’s docs show Veo 3.1 can use reference images, generate between first and last frames, and extend prior Veo videos. citeturn742639view3 citeturn128608view0

I would treat **Gemini Omni inside Flow** as the creative sandbox and **Veo 3.1 API** as the automation path until Google exposes clearer Omni-specific developer controls.

---

# The 30-second version

## Beat sheet

| Time | Visual | VO / Message |
|---:|---|---|
| 0–3s | Cinematic Malibu studio. You or “Summer” crosses frame holding the clock. | “I’m Tim White. I’m an artist from Los Angeles and the founder of Jovie.” |
| 3–7s | Jovie UI appears over studio world. | “Jovie is an AI artist manager that knows your catalog and helps you ship while you stay in the studio.” |
| 7–15s | “Never Say a Word” song page. Jovie suggests merch ideas. | “I’ve got a song called ‘Never Say a Word,’ so I ask Jovie to make a drop.” |
| 15–22s | Three designs. Pick lyric design. Turn shirt into phone case. | “She pulls a lyric, shows three designs, and I turn the winner into a phone case.” |
| 22–27s | Product live, fan text scheduled, Simple confirmation. | “I say ship it. It goes live on my artist profile, and Friday texts are scheduled to my fans.” |
| 27–30s | Logo sting. Jovie mark. Maybe clock click sound. | “That’s Jovie. Your AI artist manager.” |

## 30-second VO draft

> “I’m Tim White. I’m an artist from Los Angeles and the founder of Jovie.  
> Jovie is your AI artist manager. It knows your catalog and helps you ship while you stay in the studio.  
> I’ve got a song called ‘Never Say a Word,’ so I ask Jovie to make a drop.  
> She pulls a lyric, shows three designs, and I turn the winner into a phone case.  
> I say ship it. It goes live on my artist profile, and Friday texts are scheduled to my fans.  
> That’s Jovie. Your AI artist manager.”

This is clean enough for a first cut. It explains the company, shows a product action, and ends with a concrete shipped outcome.

---

# The 60-second version

The 60-second version should add the **memory example**.

Structure:

1. **Intro / positioning**
2. **Merch drop example**
3. **Memory example**
4. **Logo sting**

The second example should show that Jovie is context-aware:

> “Because Jovie knows my catalog, collaborators, photos, lyrics, and fan history, she can suggest the next move before I ask.”

For the Randy Jackson example: use it carefully. If you mean Randy Jackson from *American Idol*, his birthday is June 23, so the demo should avoid saying “this week” unless the fictional demo date is near June 23. citeturn361064view0

Better phrasing:

> “Jovie notices Randy Jackson’s birthday is coming up and suggests a post from a photo we already have.”

Then the visual can show:

- Jovie memory card: “Randy Jackson — birthday coming up”
- Archived photo: Tim + Randy
- Suggested caption: “Happy birthday, dawg.”
- Instagram preview
- “Approve post” button

That sells memory, relationship context, and agentic output.

---

# How to produce it systematically

## Phase 1: Lock the story

Create a single edit script with:

- VO line
- timestamp
- required visual
- source type: Flow, UI capture, generated asset, stock, motion graphics
- acceptance criteria

Example:

| Shot | Source | Acceptance criteria |
|---|---|---|
| Malibu studio tracking shot | Flow / Omni | Summer consistent, ocean visible, smooth lateral truck, crane down, no warping |
| Jovie chat prompt | Playwright capture | Readable text, fast interaction, believable UI |
| Merch designs | Product mockups | Three distinct designs, one obvious winner |
| Phone case generation | UI + mockup | Feels shippable, high-contrast lyric |
| SMS scheduled | UI capture | Shows Friday send, fan segment, confirmation |

## Phase 2: Build a rough edit with placeholders

Before generating expensive cinematic shots, make a dirty timeline:

- black cards
- screenshots
- rough UI captures
- temp VO
- temp music
- temp sound design

This answers the real question first: **does the demo work emotionally and logically?**

## Phase 3: Generate hero shots

Keep Flow clips short. Veo 3.1 guidance currently supports 4, 6, or 8 second clips, and the docs emphasize reference images, first/last frames, and ingredients for consistency. citeturn742639view4

Use AI video for 4–6 second modules:

- opening tracking shot
- clock close-up
- Summer crossing studio
- ocean-window parallax
- product “coming alive” moment
- logo sting background

Avoid asking one generation to do too much.

## Phase 4: Capture the product deterministically

Use Playwright to create the product demo shots from fixed states. That lets you control:

- cursor movement
- typing speed
- scroll position
- animations
- timestamps
- exact copy
- fake data
- screenshots
- export dimensions

This is the part that should become your internal **demo builder**.

The builder should generate:

- 16:9 website demo
- 9:16 social cut
- product screenshots
- launch GIFs
- variant scripts for different artist use cases

Veo 3.1 supports landscape and portrait output, so you can plan both formats early. citeturn742639view3

---

# Fixing the camera prompt

Your instinct is right: the issue is probably prompt precision.

The phrase “jib in the opposite direction of her walk” is ambiguous because **jib/crane movement is vertical** and walking/trucking is horizontal. Prompt the motion as physical camera mechanics.

Use language like this:

> “Single continuous cinematic tracking shot. Subject walks from screen left to screen right across a luxury Malibu recording studio. Camera trucks laterally from screen right to screen left on a dolly track while a stabilized crane arm slowly descends from eye level to chest level. A subtle compensating pan keeps the subject perfectly centered with consistent headroom. No zoom. No handheld shake. No cuts. No sudden reframing. Smooth mechanical movement, controlled low-key lighting, cool shadows, precise symmetrical composition, 40mm lens, shallow depth of field, ocean visible through tall windows.”

For stronger control, use **first and last frames**:

- First frame: Summer at left side of room, camera higher.
- Last frame: Summer at right side, camera lower.
- Prompt: “Generate the continuous move between these frames.”

Google’s Veo 3.1 docs explicitly support first-and-last-frame generation and reference images, which is the right mechanism for this kind of constrained move. citeturn742639view3

## Camera prompt components to always include

| Component | Example |
|---|---|
| Subject path | “walks screen left to screen right” |
| Camera path | “camera trucks screen right to screen left” |
| Vertical move | “crane descends 18 inches over the shot” |
| Framing rule | “subject remains centered, consistent headroom” |
| Lens | “40mm lens” |
| Stabilization | “smooth dolly, no handheld shake” |
| Prohibitions | “no zoom, no cuts, no sudden pan” |
| End state | “ends in medium close-up with clock foregrounded” |

---

# The strongest demo concept

The killer framing is:

> **“Jovie turns artist context into finished fan actions.”**

That is stronger than “AI dashboard,” “AI assistant,” or “music marketing tool.”

The merch example works because it has a full loop:

1. Artist has an idea.
2. Jovie knows the song.
3. Jovie extracts the lyric.
4. Jovie generates merch.
5. Artist tweaks format.
6. Jovie ships.
7. Fans receive the campaign.

That is a complete product story.

The memory example works because it shows:

1. Jovie remembers relationships.
2. Jovie watches the calendar.
3. Jovie finds the asset.
4. Jovie writes the post.
5. Artist approves.

That turns Jovie from “chatbot” into “manager.”

---

# Recommended first build

## Make this first

**A 30-second landing-page hero video:**

- 16:9 master
- no generated dialogue
- your VO
- cinematic studio open
- real Jovie UI inserts
- one complete merch workflow
- logo sting

## Then make this

**A 60-second founder/product demo:**

- same opening
- merch workflow
- Jovie memory / birthday post workflow
- stronger explanation of catalog memory
- CTA: “Request access”

## Save for later

- multi-character scenes
- full Summer dialogue
- long single-take camera choreography
- API automation across all video assets
- elaborate influencer/social variants

The first target should be a **credible 30-second proof that looks like a film and behaves like real software**.
