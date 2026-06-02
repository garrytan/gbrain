---
title: "Viral detection and app development"
type: essay
created: 2026-05-16
updated: 2026-05-16
source: chatgpt-export
topic: coding-general
message_count: 14
tags: [chatgpt, knowledge, coding-general]
---
# Viral detection and app development

> **Source:** ChatGPT conversation
> **Date:** 2026-05-16T14:56:45Z
> **Messages:** 14
> **Topic:** coding-general

## Question

higgsfield dropped a viral detector that supposedly uses brain function from fmri studies to see what will go viral.

this to me sounds like they used tribe v2 from Meta. meta is not comercially licensing this so im thinking they might have just done it anyway.

1) any thoughts if higgsfield, a startup actually did fmri studies or got real data vs just illegally using the tribe stuff? or used tribe to train their own stuff?
2) can i build an app that uses this to generate viral tiktoks with artists music, measure the results, and then improve, and loop. and try to make music go viral as a service?

## Answer

Mr. White, I’ll verify the public Higgsfield and Meta/TRIBE claims, then separate evidence from inference across technical plausibility, IP/licensing risk, and a compliant viral-music product loop.

## Answer

Higgsfield’s public materials mention modeled audiences and brain-response scoring, but I’m not seeing disclosed fMRI studies, dataset provenance, or a TRIBE license. TRIBE v2 is CC BY-NC, so commercial reuse would be a central risk.

## Answer

Mr. White, my read:

## 1) Higgsfield vs. Meta TRIBE v2

**Public facts:** Higgsfield’s Virality Predictor says you upload a clip up to 15 seconds, a “modeled audience” watches it, and it maps “brain response across vision, sound, memory, attention, language,” returning virality score, peak hook timestamp, hold rate, and a brain heatmap. Its CLI calls the job type `brain_activity` and says it analyzes hook strength, attention, retention, and viral potential. citeturn794598view0turn253883view0

**Meta’s TRIBE v2 is a very close conceptual match.** Meta describes TRIBE v2 as a tri-modal model for predicting human brain activity from video, audio, and language, trained on more than 1,000 hours of fMRI across 720 subjects. Meta’s public release includes model weights and code under **CC BY-NC**, and the Hugging Face page says the model predicts fMRI responses to naturalistic video, audio, and text. citeturn794598view2turn794598view1turn481498view0

**License issue:** CC BY-NC permits sharing/adaptation only for noncommercial purposes; Creative Commons defines commercial purposes as uses primarily intended for commercial advantage or monetary compensation. A paid virality product using TRIBE weights/code without separate permission would be a major license problem. citeturn456744view0turn456744view1

**My inference:**  
Higgsfield directly using TRIBE v2 or a TRIBE-derived layer is plausible. The product language, modalities, “brain heatmap” output, and `brain_activity` naming all point that way. I found no public Higgsfield paper, data card, validation study, IRB/fMRI study, or model card proving they ran their own fMRI program. A startup can buy data, partner with a lab, or train on public datasets, but a Meta-scale fMRI effort would usually leave some public trace.

The legally safer explanations are: they licensed something privately, trained a separate model on commercially usable data, or built a marketing/attention model that visualizes outputs as brain regions. The riskier explanation is: they used TRIBE directly or distilled TRIBE outputs into a commercial scorer. There is no public proof of illegal use from what I found.

If you diligence them, ask four questions: “Do you use Meta TRIBE v2 weights, code, architecture, outputs, or generated labels?” “What commercial license covers that use?” “What dataset validates virality/hold-rate predictions against real TikTok metrics?” “Are uploaded unreleased music/videos used for training?” Higgsfield’s own terms say inputs and outputs may be used to train/improve models and for marketing, which matters for unreleased artist assets. citeturn588610view0

## 2) Can you build the music-go-viral loop?

**Yes, the business is buildable.** The clean version is a rights-managed creative testing engine, using actual TikTok performance as ground truth. The dangerous version is a TRIBE/Higgsfield wrapper that auto-spams TikTok with unlicensed music.

A safer architecture:

1. Generate 20–100 sho

*(Answer truncated — 6834 chars total)*

## Question

spec out how this intergrates into jovie. how we build it and ship it fast. how we keep it flexibly.
we ideally would use the song from tiktok library so its trackable.
and a bullet proof version ships short form video to reels tiktok and youtube shorts everyday on behalf of artists. 



## Answer

I’ll turn this into a Jovie-specific product and engineering spec, splitting the fast MVP from the durable daily publishing system while accounting for platform APIs, tracking, and music rights.

## Answer

The key constraint is TikTok audio association: uploading finished videos can be automated, while attaching the native library sound for trackable sound-page usage likely needs a separate adapter, manual/draft flow, or special access.

## Answer

Mr. White, I’d make this a **Jovie “Launch Loops” module**: an always-on short-form campaign engine attached to every release in the Jovie catalog.

Jovie already positions itself around “connect your catalog” and turning releases into fan paths, presaves, and playlist pitches, so this fits as the next layer: **connect catalog → generate daily short-form → publish/route → measure → improve**. citeturn528165view0

## Core product opinion

Build the first version around **real platform performance**, not fMRI-style “brain score” claims.

The defensible loop is:

**artist catalog → creative variants → daily short-form posts → platform metrics → optimizer → better variants**

The “viral detector” can be an optional pre-score. The actual moat is Jovie’s dataset across artists, songs, hooks, visual formats, captions, posting times, and conversion outcomes.

## Important platform constraint

For TikTok, I would treat **trackable TikTok-library sound usage** and **fully automated direct posting** as two different product paths.

TikTok’s Direct Post API lets an app upload video to a creator account, requires app approval and `video.publish`, and unaudited clients are restricted to private posts. The documented video post body includes caption, privacy, duet/stitch/comment settings, disclosure fields, AI label, and source info, but I do not see a documented video field for selecting a TikTok library `music_id`/official sound. citeturn787059view0 citeturn346543view4

So the clean structure is:

**Automated TikTok posting:** render the music into the video and track the post’s performance.

**Trackable TikTok official sound:** send the video to TikTok as a draft/in-app flow and have the artist select the official TikTok sound before posting, or get a deeper TikTok partner integration if they expose sound attachment commercially.

That distinction matters because the user goal is “make the song go viral,” which means the video should ideally attach to the official sound page, not create random original sounds.

---

# Jovie Launch Loops spec

## 1. Where it lives in Jovie

Add this to each release page:

**Release → Growth → Short-Form Loop**

Each release gets:

| Module | Purpose |
|---|---|
| **Song profile** | ISRC, DSP links, TikTok sound URL, Instagram audio ID, YouTube asset/video IDs, release date, rights status |
| **Hook library** | Chorus, drop, lyric moment, intro, beat switch, quote line, transition point |
| **Creative plan** | Daily short-form concepts generated from the song, artist profile, references, and campaign goals |
| **Variant queue** | 10–100 generated videos/captions ready for review |
| **Approval workflow** | Artist/team approves or rejects posts |
| **Publisher** | Sends approved videos to TikTok/Reels/Shorts |
| **Performance dashboard** | Views, shares, saves, comments, watch metrics, conversions, sound/video IDs |
| **Optimizer** | Learns which hooks, visuals, captions, and formats are working |

This turns Jovie fro

*(Answer truncated — 18950 chars total)*

## Question

ok but mvp should really just be a skill or tool call from the jovie chat that generates the thing. then i can post it myself. and you can just open up a link in the chat that's like posting on TikTok, and you can get that with a pre-built thing. That's easy to build. 

## Answer

Mr. White, yes — the MVP becomes a Jovie Chat skill that generates a ready-to-post short, caption, and handoff link while avoiding OAuth, audits, and auto-posting.

## Answer

Mr. White, correct. The MVP should be **a Jovie Chat skill**, not a publishing platform.

The first product should generate a finished short-form posting package and let the artist post it manually from TikTok/Reels/Shorts. That ships faster, avoids TikTok API approval friction, and lets the artist select the official TikTok library sound so usage accrues to the track.

## Revised MVP: Jovie Chat → “Generate Viral Post”

User prompt inside Jovie:

> “Make me a TikTok for this song using the chorus. Make it emotional and hooky.”

Jovie returns a **post card**:

1. **Rendered 9:16 MP4**
2. **Caption**
3. **Hashtags**
4. **TikTok official sound link / instruction**
5. **Posting buttons**
6. **Generate more variants**
7. **Save as campaign idea**

The card should look like:

```txt
Short-form post generated

[Video preview]

Caption:
“you ever hear a song and immediately know who it’s about?”

Hashtags:
#newmusic #sadpop #fyp #artistname

Sound:
Use official TikTok sound: “Track Name - Artist”
Instruction: Add Sound → search Track Name → select official artist sound → mute original audio if needed.

Buttons:
[Download MP4]
[Copy Caption]
[Share to TikTok]
[Share to Instagram Reels]
[Share to YouTube Shorts]
[Make 5 More Like This]
```

## The easiest posting flow

### 1. Web-first version

Use the browser’s native share sheet.

Jovie generates the MP4, stores it, then the button calls:

```ts
await navigator.share({
  title: "Post this short",
  text: caption,
  files: [videoFile]
});
```

The Web Share API can share text, URLs, and files through the device’s native share targets, though support varies by browser/device, so keep a download fallback. citeturn845488search0turn845488search2

Fallback:

```txt
[Download MP4]
[Copy Caption]
[Open TikTok]
```

This is enough for MVP.

### 2. Mobile-app version

Use **TikTok Share Kit** if Jovie has or adds a mobile wrapper. TikTok says Share Kit lets users share videos from a mobile app to TikTok, then edit/add effects/hashtags in TikTok. citeturn217030view0turn217030view1

For Android, TikTok also documents simple share intents for video files, including `Intent.ACTION_SEND`, `video/mp4`, and `EXTRA_STREAM`. citeturn217030view2

This gives you a real “Post to TikTok” style button without building full auto-posting.

### 3. Optional web/TikTok draft version

If you want a better web-native TikTok flow later, use TikTok’s **Content Posting API Upload** mode. It uploads the video to TikTok as a draft/inbox item, then the user finishes editing and posts inside TikTok. TikTok’s docs describe this as uploading content for the user to review and post through TikTok’s creation flow. citeturn608164view0

That requires TikTok app registration, `video.upload` scope approval, OAuth, and user authorization. citeturn608164view0

I would make this **V1.5**, not MVP.

## Key product decision: TikTok sound tracking

For trackable TikTok usage, do this:

```txt
Render video WITHOUT final embedded music
or 

*(Answer truncated — 8958 chars total)*

## Question

It should, on the share, have an interstitial that says something like "Important" and explains how to attach the sound and all that, so you walk the user through it. You should also display an inline QR code, if possible, to have them scan it. I don't know if this is possible. Is there an inline QR code we can have them scan that would attach the file and open the TikTok app on their mobile phone? It's like a QR handoff, which is a component we should generally have in our chat when we want to share things and be open on mobile. 

## Answer

I’ll separate immediate web-chat behavior from native/TikTok-dependent handoff limits, then spec the safest QR flow and the upgrade paths for mobile sharing.

## Answer

Mr. White, yes — the **interstitial + QR handoff** is exactly the right MVP pattern.

The realistic version:

**Jovie Chat generates the video → user clicks Share/Post → Jovie shows an “Important” interstitial → user scans a QR code → mobile handoff page opens → user downloads/shares the MP4 → user attaches the official TikTok sound manually.**

A QR code cannot practically contain the MP4 itself, and there is no public, reliable TikTok deep link that both opens TikTok with a generated file and pre-attaches a specific official sound. The QR should contain a short signed Jovie URL that loads the generated asset and instructions on mobile.

## What is possible

### 1. Inline QR code in Jovie Chat

Yes. Add a reusable `MobileHandoffCard` component.

It renders:

```txt
Post this on TikTok

[QR CODE]

Scan this on your phone to open the video, caption, and official sound instructions.
```

QR payload:

```txt
https://jov.ie/handoff/postpkg_abc123?token=signed_token
```

The handoff page contains:

- MP4 preview
- Download button
- Native share button
- Copy caption button
- Official TikTok sound link
- Exact step-by-step instructions
- “I posted it” button
- Optional field to paste TikTok URL after posting

### 2. Native web share from mobile

On the mobile handoff page, use `navigator.share()` with the MP4 file where supported. MDN says the Web Share API can share text, URLs, and files through the device’s native sharing mechanism, but target availability depends on device/browser support. citeturn277205view3

So the mobile button flow is:

```txt
[Share video]
→ native share sheet opens
→ user chooses TikTok / Instagram / YouTube / Save Video
```

Fallback:

```txt
[Download MP4]
[Copy Caption]
[Open TikTok]
```

### 3. Native mobile app share

If Jovie eventually has a mobile app/wrapper, TikTok Share Kit is cleaner. TikTok says Share Kit enables users to share short-form videos to TikTok without repeated logins, and the iOS docs show a `TikTokShareRequest` with media identifiers and a `.video` media type. citeturn277205view2 citeturn940960view0

For Android, TikTok documents sharing video through Android intents using `ACTION_SEND`, `video/mp4`, and `EXTRA_STREAM`. citeturn277205view4

That still does not solve automatic official-sound attachment.

### 4. TikTok draft upload via API

Later, Jovie can use TikTok’s Content Posting API **Upload** mode to send the video to TikTok as a draft/inbox item. TikTok says this flow uploads content for the user to review and post, and users must continue the editing flow from a TikTok inbox notification. It requires a registered TikTok app, `video.upload` approval, and user authorization. citeturn277205view0

This is good for V1.5. It is too heavy for the first Jovie Chat MVP.

## What is probably impossible publicly

This exact one-step QR flow:

```txt
Scan QR
→ TikTok opens
→ generated MP4 is already loaded
→ official artist sound is already attached
→ caption is prefilled
→ user taps Post
`

*(Answer truncated — 10833 chars total)*
