---
title: "Viral detection and app development"
type: essay
created: 2026-05-16
updated: 2026-05-16
source: chatgpt-export
conversation_id: 6a0885ad-1774-83e8-bd69-5932603b6329
message_count: 14
tags: [chatgpt, import, code, long-form]
---
# Viral detection and app development

> Conversation ID: 6a0885ad-1774-83e8-bd69-5932603b6329
> Created: 2026-05-16T14:56:45Z
> Updated: 2026-05-16T15:51:22Z
> Messages: 14

---

## User

higgsfield dropped a viral detector that supposedly uses brain function from fmri studies to see what will go viral.

this to me sounds like they used tribe v2 from Meta. meta is not comercially licensing this so im thinking they might have just done it anyway.

1) any thoughts if higgsfield, a startup actually did fmri studies or got real data vs just illegally using the tribe stuff? or used tribe to train their own stuff?
2) can i build an app that uses this to generate viral tiktoks with artists music, measure the results, and then improve, and loop. and try to make music go viral as a service?

---

## Assistant

Mr. White, I’ll verify the public Higgsfield and Meta/TRIBE claims, then separate evidence from inference across technical plausibility, IP/licensing risk, and a compliant viral-music product loop.

---

## Assistant

Higgsfield’s public materials mention modeled audiences and brain-response scoring, but I’m not seeing disclosed fMRI studies, dataset provenance, or a TRIBE license. TRIBE v2 is CC BY-NC, so commercial reuse would be a central risk.

---

## Assistant

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

1. Generate 20–100 short-form creative variants for a track: hook formats, visual styles, captions, creator prompts, lyric moments, transitions, memes, UGC prompts.
2. Pre-score variants with your own model or a properly licensed scoring provider.
3. Route everything through human/client approval.
4. Publish through authorized artist/creator accounts using TikTok’s official posting flow/API.
5. Measure 1-second/2-second hold, completion rate, rewatch rate, share rate, saves, comments, sound page visits, follower conversion, and new videos created using the sound.
6. Feed results into a bandit/Bayesian optimizer and keep generating variants around what works.

### Key constraints

**Music rights:** For commercial/promo content on TikTok, TikTok says music outside the Commercial Music Library requires confirmation that all necessary licenses have been obtained and paid for, including composition and master rights. TikTok’s CML is pre-cleared for commercial TikTok use, but CML rights are limited to TikTok and do not automatically cover Reels, Shorts, ads elsewhere, or TV. citeturn780092view1turn432122view0turn432122view2

For artist clients, get written authority for: master recording, composition/publishing, sync into audiovisual posts, lyric use, stems/remixes/speed-ups, creator/influencer use, paid ads, whitelisting, Spark Ads, and cross-platform reposting. An artist often lacks unilateral control if a label, distributor, publisher, or co-writer owns part of the rights.

**TikTok automation:** TikTok’s Content Posting API requires audit for public direct posting. Unaudited clients are capped to five users in a 24-hour window and posts are private-only. TikTok also imposes creator/posting caps, says API clients should support authentic creators posting original content, and rejects internal utility tools for accounts you manage. Users must retain awareness/control and expressly consent before upload. citeturn780092view0

That means the product should be “AI prepares + recommends + queues + asks for approval,” rather than silent autonomous posting.

**Disclosures:** Paid artist promotion through creators/influencers generally triggers TikTok branded content rules and FTC endorsement disclosure rules. TikTok requires the commercial content disclosure toggle for branded content, and the FTC says social endorsements require disclosure when a material connection exists. citeturn432122view1turn646860view0

**AI labels:** TikTok requires labels for realistic AI-generated or significantly AI-edited images, audio, and video, and it prohibits certain AI impersonation/false endorsement cases. citeturn577545view0

**Using Higgsfield specifically:** Higgsfield’s terms say outputs can be used commercially, but the API license is for personal/internal business purposes, and the terms restrict using the service or outputs to develop/fine-tune/improve competing AI/ML products. So: using Higgsfield as an occasional preflight tool for client creative may be viable under the right plan; using its scores/outputs to train your own virality model or white-labeling its predictor as your own service needs written permission. citeturn588610view0

## Bottom line

I would build this, but with a clean stack:

**Do not use Meta TRIBE v2 commercially unless you get a commercial license.**  
**Do not train your own commercial model from Higgsfield/TRIBE outputs without permission.**  
**Do build a closed-loop TikTok creative testing platform using licensed music, authorized creator accounts, official posting/analytics flows, AI disclosure, and real performance data.**

Position it as “we improve probability of breakout through rapid creative experimentation,” rather than “we can predict virality from brains.” The actual defensible asset is the performance dataset and optimizer, not the brain heatmap.

---

## User

spec out how this intergrates into jovie. how we build it and ship it fast. how we keep it flexibly.
we ideally would use the song from tiktok library so its trackable.
and a bullet proof version ships short form video to reels tiktok and youtube shorts everyday on behalf of artists. 



---

## Assistant

I’ll turn this into a Jovie-specific product and engineering spec, splitting the fast MVP from the durable daily publishing system while accounting for platform APIs, tracking, and music rights.

---

## Assistant

The key constraint is TikTok audio association: uploading finished videos can be automated, while attaching the native library sound for trackable sound-page usage likely needs a separate adapter, manual/draft flow, or special access.

---

## Assistant

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

This turns Jovie from “release assistant” into an **AI growth operator for music catalogs**.

---

# 2. MVP: ship fast

The fast version should avoid the hard TikTok sound-selection problem.

## MVP goal

**Generate and schedule one short-form video per day per artist, with manual approval and analytics capture.**

## MVP scope

### Inputs

From the Jovie release object:

- Artist name
- Track title
- Release date
- Audio file or stem
- Cover art
- Canvas/visualizer clips
- Press photos
- Lyrics
- Existing TikTok/Reels/Shorts links
- Presave/fan path URL
- Artist tone/persona
- Creative references

### Output

For each song:

- 20 short-form concepts
- 10 rendered videos
- 10 captions
- Platform-specific variants
- Approval queue
- Published post IDs
- Basic performance dashboard

### Fastest publish stack

Start with:

1. **YouTube Shorts direct upload** via YouTube Data API.
2. **Instagram Reels direct publish** via Instagram Content Publishing API.
3. **TikTok draft/direct path**, depending on approval status.

YouTube supports uploading videos through `videos.insert`, including title, description, tags, category, privacy, synthetic media disclosure, and publish status fields. Unverified projects created after July 28, 2020 are restricted to private uploads until audit, so you should expect a compliance/audit step for production. citeturn112020view2turn112020view3

Instagram’s official content publishing docs now state Instagram accounts are limited to 100 API-published posts in a 24-hour moving period, and Meta has an official Instagram Audio API for searching audio and attaching tracks/sound effects/music to Reels at creation time. citeturn781049search0turn781049search1

TikTok Direct Post requires app approval, creator OAuth, creator info lookup, explicit user choices/consent, and public posting requires audit. TikTok also says API clients are subject to creator and posting caps, with creator posting caps typically around 15 posts per day per creator account. citeturn346543view5

## MVP UX

On the release page:

**“Generate Short-Form Loop”**

Jovie asks:

- Goal: streams, presaves, follows, UGC, playlisting, awareness
- Daily cadence: 1/day, 2/day, custom
- Platforms: TikTok, Reels, Shorts
- Audio strategy:
  - Embedded song clip
  - Use official TikTok sound manually
  - Use Instagram audio library
  - YouTube embedded audio
- Tone: funny, cinematic, emotional, creator bait, lyric-first, meme-first
- Approval: auto-generate only, approve before posting, or approved campaign schedule

Then Jovie creates a 7-day campaign.

Example:

**Day 1:** lyric hook  
**Day 2:** behind-the-song clip  
**Day 3:** fan POV meme  
**Day 4:** visualizer cutdown  
**Day 5:** “use this sound if…” prompt  
**Day 6:** transition/challenge format  
**Day 7:** best-performing variant remix

---

# 3. Bulletproof version

The bulletproof version is not “fully autonomous spam.” It is **pre-approved daily posting with rights, disclosures, platform-safe publishing, and automatic optimization**.

## Bulletproof flow

1. Artist connects accounts with OAuth.
2. Artist connects catalog/release.
3. Jovie verifies rights and platform music strategy.
4. Jovie generates a 30-day creative calendar.
5. Artist approves campaign rules and individual posts or batches.
6. Jovie posts daily to each platform.
7. Jovie pulls metrics at 1h, 3h, 6h, 24h, 72h, 7d.
8. Jovie creates new variants from winners.
9. Jovie suppresses weak formats.
10. Jovie reports “what to do next” every morning.

## Bulletproof daily output

Per artist, per day:

- 1 TikTok
- 1 Instagram Reel
- 1 YouTube Short
- Optional second TikTok if current performance justifies it
- Optional creator brief for UGC/influencer amplification

## Bulletproof approval model

Use three modes:

| Mode | Description | Best for |
|---|---|---|
| **Draft mode** | Jovie generates videos and sends to draft/review | Early artists, legal-sensitive teams |
| **Approval mode** | Artist approves each post inside Jovie | Most clients |
| **Campaign autopilot** | Artist pre-approves a calendar/rule set | Higher trust clients |

For TikTok, keep an explicit approval/consent step because TikTok’s developer guidelines require user metadata selection, privacy choices, disclosure handling, and consent before publishing. citeturn346543view5

---

# 4. Sound strategy

## TikTok

### Best trackable version

Use the **official TikTok sound**.

Flow:

1. Jovie stores the artist’s official TikTok sound URL/music ID manually or via permitted lookup.
2. Jovie generates the video without burned-in competing audio, or with low/reference audio.
3. Jovie sends the post to TikTok draft/in-app flow.
4. Artist selects the official TikTok sound.
5. Jovie stores the published URL/video ID.
6. Jovie tracks post metrics and sound-page growth where available.

This gives the best chance that usage counts toward the official TikTok sound.

### Automated version

Jovie renders the song clip directly into the MP4 and posts via Direct Post.

This is easier, but less clean for TikTok sound-page attribution. It may show as original audio or be matched inconsistently.

### Commercial/rights guardrail

TikTok says businesses should use the Commercial Music Library for commercial TikTok activity, and music outside the CML requires Music Usage Confirmation that the necessary rights have been obtained. citeturn787059view4turn787059view5

For artist-owned campaigns, Jovie should require:

- Master rights confirmation
- Publishing/composition rights confirmation
- Sync use permission for short-form video
- Permission for paid/organic promo
- Permission for edits, remixes, speed-ups, and cutdowns
- Label/distributor/publisher clearance where applicable

## Instagram Reels

Instagram is better for automated library audio now because Meta has an official Audio API that lets apps search audio and attach audio tracks to Reels at creation time. citeturn781049search1

Flow:

1. Store Instagram audio track ID for the song.
2. Render video.
3. Create Reel media container.
4. Attach selected audio.
5. Publish.
6. Pull insights.

## YouTube Shorts

YouTube Data API uploads the video file and metadata. I would embed the owned/cleared song audio into the video and upload it. The Data API docs expose upload/metadata fields; I do not see a public “attach Shorts music library sound ID” field. citeturn112020view2turn112020view3

YouTube’s separate Audio Library is in YouTube Studio, and YouTube describes it as royalty-free production music/sound effects, not a mechanism for attaching an artist’s official catalog song to a Short through the upload API. citeturn112020view5

---

# 5. Architecture

Build it as a flexible workflow engine, not a hardcoded TikTok bot.

## Core services

### 1. Catalog service

Existing Jovie release/artist data.

Add:

```ts
Artist
Release
Track
Asset
RightsProfile
PlatformIdentity
PlatformSound
Campaign
```

### 2. Creative generation service

Generates:

```ts
CreativeBrief
HookCandidate
CaptionCandidate
Storyboard
VideoVariant
```

Inputs:

- Lyrics
- Song segments
- Waveform/tempo/key/energy
- Artist profile
- Release context
- Prior post performance
- Reference formats

### 3. Render service

Use FFmpeg/remotion-style rendering.

Outputs:

```ts
RenderedAsset {
  id
  campaign_id
  platform
  aspect_ratio: "9:16"
  duration_ms
  audio_strategy
  video_url
  thumbnail_url
  waveform_hash
}
```

Keep render templates modular:

- Lyric kinetic type
- Cover-art motion
- Meme text overlay
- Artist quote
- POV format
- Reaction format
- Behind-the-song
- Visualizer
- Performance clip
- UGC prompt

### 4. Platform adapter service

Define a strict interface:

```ts
interface PlatformAdapter {
  connectAccount()
  validatePost(post)
  publishPost(post)
  uploadDraft(post)
  fetchPostStatus(platformPostId)
  fetchMetrics(platformPostId)
  refreshToken()
}
```

Implement:

```ts
TikTokAdapter
InstagramAdapter
YouTubeAdapter
```

Later:

```ts
SnapAdapter
FacebookReelsAdapter
ThreadsAdapter
XAdapter
TrillerAdapter
```

### 5. Sound adapter service

Keep this separate from publishing.

```ts
interface SoundAdapter {
  findTrack(release)
  bindSoundToPost(post, sound)
  validateRights(sound, campaign)
}
```

Implement:

```ts
EmbeddedAudioStrategy
TikTokOfficialSoundManualStrategy
TikTokDirectPostEmbeddedStrategy
InstagramAudioApiStrategy
YouTubeEmbeddedAudioStrategy
```

This keeps the product flexible when TikTok eventually exposes official sound binding, or when you get partner access.

### 6. Metrics service

Normalize all metrics into one table.

```ts
PostMetricSnapshot {
  post_id
  platform
  captured_at
  views
  likes
  comments
  shares
  saves
  watch_time
  avg_view_duration
  completion_rate
  retention_curve
  followers_gained
  link_clicks
  sound_uses
}
```

TikTok’s Display API can query authorized users’ videos and return fields including ID, create time, share URL, description, like count, comment count, share count, and view count. citeturn112020view0turn112020view1

YouTube Analytics API supports metrics such as views, likes, comments, shares, subscribers gained, average view duration, average view percentage, estimated minutes watched, and audience retention. citeturn484102view0

### 7. Optimizer service

Use a simple bandit first.

Inputs:

- Platform
- Song
- Hook timestamp
- Visual template
- Caption style
- Hashtags
- Posting time
- Sound strategy
- Duration
- Opening frame
- CTA
- Metrics

Outputs:

- Next best creative format
- Hook segment recommendation
- Posting schedule adjustment
- Caption mutation
- Kill/continue decision

Start simple:

```ts
score =
  0.30 * normalized_share_rate +
  0.25 * normalized_completion_rate +
  0.20 * normalized_save_rate +
  0.15 * normalized_comment_rate +
  0.10 * normalized_follow_or_click_rate
```

For TikTok MVP, where retention may be unavailable through official API, score on views, shares, comments, likes, and growth velocity.

---

# 6. Data model

Minimum tables:

```ts
artists
releases
tracks
track_segments
assets
platform_accounts
platform_sounds
rights_profiles
campaigns
campaign_rules
creative_briefs
creative_variants
rendered_assets
scheduled_posts
published_posts
post_metric_snapshots
experiment_results
optimization_recommendations
audit_logs
```

Key object:

```ts
platform_sounds {
  id
  track_id
  platform: "tiktok" | "instagram" | "youtube"
  sound_url
  platform_sound_id
  is_official
  is_commercially_usable
  attachment_method: "api" | "manual" | "embedded" | "unknown"
  last_verified_at
}
```

Key post object:

```ts
scheduled_posts {
  id
  campaign_id
  platform
  rendered_asset_id
  sound_strategy
  caption
  scheduled_at
  status: "draft" | "needs_approval" | "approved" | "publishing" | "published" | "failed"
  approval_user_id
  approval_timestamp
  platform_post_id
  platform_post_url
}
```

---

# 7. Fast build plan

## Phase 1: 7-day prototype

Build only inside Jovie admin.

Features:

- Select release
- Upload/choose song segment
- Generate 10 ideas
- Render 3 video templates
- Manual caption generation
- Manual post links
- Pull metrics manually or via YouTube/TikTok/IG APIs where available
- Dashboard showing creative variants vs performance

Goal: prove Jovie can generate useful daily creative.

## Phase 2: 14-day MVP

Add:

- Campaign object
- Approval queue
- Render queue
- YouTube Shorts upload
- Instagram Reels publish
- TikTok draft/direct API test
- Metrics snapshots
- Basic optimizer

Goal: one artist can run a 7-day loop.

## Phase 3: 30-day private beta

Add:

- Artist OAuth
- Rights checklist
- Sound binding model
- TikTok official sound manual flow
- Instagram Audio API sound binding
- YouTube Analytics ingestion
- Post status monitoring
- Retry/failure handling
- Daily recommendation email/report
- “Generate next 7 days from winners”

Goal: 10 artists, daily posting, measurable improvement.

## Phase 4: Bulletproof production

Add:

- Platform app reviews/audits
- Scaled token management
- Platform-specific post validators
- Per-account rate limits
- Rights/legal audit logs
- Team approval roles
- Calendar batching
- AI disclosure fields
- Branded content toggles
- Error recovery
- Creative template marketplace
- Creator/UGC assignment workflow

Goal: Jovie can operate daily growth for many artists without brittle manual ops.

---

# 8. Product screens

## Release Growth tab

Sections:

1. **Campaign status**
   - Active / paused
   - Days remaining
   - Posts scheduled
   - Best-performing creative

2. **Sound setup**
   - TikTok official sound URL
   - Instagram audio ID
   - YouTube embedded audio
   - Rights status

3. **Creative queue**
   - Video preview
   - Caption
   - Platform
   - Scheduled time
   - Approval status

4. **Performance**
   - Views
   - Shares
   - Saves
   - Comments
   - Engagement velocity
   - Best hook timestamp
   - Best template
   - Best caption style

5. **Next actions**
   - “Make 5 variants of this winner”
   - “Shift tomorrow’s post to this hook”
   - “Turn this into a creator brief”
   - “Create UGC challenge prompt”

## Artist settings

- Connected TikTok
- Connected Instagram
- Connected YouTube
- Posting permissions
- Default approval mode
- Brand/commercial disclosure defaults
- AI content disclosure defaults
- Rights profile

---

# 9. Legal/compliance guardrails

Hardcode these into the product.

## No Jovie watermark on TikTok exports

TikTok says apps should avoid adding brand names, logos, watermarks, promotional branding, links, or promo text on content shared to TikTok. citeturn346543view5

## Build for broad artist use, not internal account management

TikTok says Direct Post API clients should facilitate authentic creators posting original content and should be intended for a wide audience; it gives “utility tool to help upload contents to the account(s) you or your team manages” as unacceptable. citeturn346543view5

So Jovie should be positioned as **artist growth software**, not an internal bot farm.

## Require rights confirmation

Every campaign should have a rights gate:

```ts
rights_status:
  master_confirmed
  publishing_confirmed
  sync_confirmed
  promo_use_confirmed
  remix_edit_confirmed
  paid_ads_confirmed
  platform_music_confirmed
```

## Require disclosure controls

For each post:

- AI-generated content flag
- Promotional content flag
- Branded content flag
- Paid partnership flag
- Artist-owned promo flag

TikTok’s Direct Post schema includes branded content toggles, organic brand toggles, and an AI-generated content field. citeturn346543view4

---

# 10. What I would build first

## Build this first

**Jovie Short-Form Loop MVP**

- One release
- One artist
- 7-day calendar
- 3 render templates
- Manual TikTok official sound flow
- Instagram direct publish with audio support
- YouTube direct upload
- Daily metrics pull
- Simple optimizer

## Avoid this initially

- fMRI model
- claims of predicting virality
- scraping TikTok sound pages at scale
- browser automation to attach sounds
- unapproved TikTok direct public posting
- training on Higgsfield/TRIBE outputs
- fully autonomous posting without approval logs

## The sellable promise

“Jovie turns every release into a daily short-form growth loop. It generates, posts, measures, and improves short-form content across TikTok, Reels, and Shorts.”

## The technical moat

- Normalized cross-platform music marketing dataset
- Song-segment performance data
- Hook/template/caption effectiveness by genre
- Artist-specific optimization memory
- Rights-safe, platform-safe publishing infrastructure

## The flexible architecture decision

Separate these five things:

1. **Creative generation**
2. **Rendering**
3. **Sound binding**
4. **Platform publishing**
5. **Metrics/optimization**

That lets Jovie swap TikTok posting modes, add new platforms, use/skip viral scoring models, and keep the core product intact as APIs change.

---

## User

ok but mvp should really just be a skill or tool call from the jovie chat that generates the thing. then i can post it myself. and you can just open up a link in the chat that's like posting on TikTok, and you can get that with a pre-built thing. That's easy to build. 

---

## Assistant

Mr. White, yes — the MVP becomes a Jovie Chat skill that generates a ready-to-post short, caption, and handoff link while avoiding OAuth, audits, and auto-posting.

---

## Assistant

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
or render with quiet scratch audio.

Then instruct user:
1. Open TikTok from Jovie.
2. Upload the generated video.
3. Add official TikTok sound.
4. Set original audio volume to 0.
5. Paste caption.
6. Post.
```

This keeps the post attached to the **official TikTok library sound** instead of creating a random “original sound.”

Jovie should store this on the release:

```ts
platform_sounds {
  platform: "tiktok",
  track_id,
  sound_url,
  display_name,
  is_official,
  search_query,
  instructions
}
```

In chat, Jovie can say:

```txt
Use this sound:
Track Name - Artist

Tap Add Sound in TikTok and search:
"Track Name Artist"
```

For MVP, manual sound selection is a feature, not a bug. It preserves trackability.

## Jovie skill spec

Tool name:

```ts
generate_short_form_post
```

Input:

```ts
type GenerateShortFormPostInput = {
  artist_id: string;
  release_id: string;
  track_id: string;

  platform?: "tiktok" | "reels" | "shorts" | "all";
  goal?: "views" | "shares" | "saves" | "ugc" | "streams" | "presaves";
  vibe?: string;
  hook_type?: "lyric" | "pov" | "meme" | "visualizer" | "story" | "challenge";
  duration_seconds?: 7 | 10 | 15 | 20 | 30;

  use_official_platform_sound?: boolean;
  sound_strategy?: "manual_official_sound" | "embedded_audio" | "silent_for_platform_sound";

  asset_ids?: string[];
  reference_urls?: string[];
  count?: number;
};
```

Output:

```ts
type ShortFormPostPackage = {
  id: string;
  video_url: string;
  thumbnail_url: string;

  caption: string;
  hashtags: string[];
  hook_rationale: string;

  platform_instructions: {
    tiktok?: {
      sound_name?: string;
      sound_url?: string;
      steps: string[];
    };
    instagram?: {
      steps: string[];
    };
    youtube?: {
      steps: string[];
    };
  };

  actions: {
    download_video_url: string;
    copy_caption_text: string;
    native_share_payload_url: string;
    open_tiktok_url?: string;
    open_instagram_url?: string;
    open_youtube_url?: string;
  };
};
```

## Backend flow

### Step 1: Resolve song context

Pull from Jovie:

```ts
artist
release
track
lyrics
cover_art
artist_images
existing canvases
release date
presave/fan path URL
TikTok sound URL if available
```

### Step 2: Pick the hook

Analyze:

- chorus start
- highest-energy 8–15 seconds
- strongest lyric line
- most memeable phrase
- most emotionally obvious moment

Store:

```ts
track_segments {
  track_id
  start_ms
  end_ms
  label: "chorus" | "drop" | "lyric_hook" | "intro"
  reason
}
```

### Step 3: Generate creative concept

Example concepts:

```txt
POV: you finally stopped pretending you don’t miss them
Text-first lyric video
Fake iMessage breakup setup
Artist quote over moving cover art
“Use this sound if…” prompt
Before/after emotional cut
```

### Step 4: Render video

Use a small fixed template set first:

1. **Kinetic lyric video**
2. **Cover-art motion video**
3. **POV text over visual loop**
4. **Artist image + quote**
5. **Meme prompt / UGC prompt**

Render with FFmpeg or Remotion.

MVP output spec:

```txt
1080x1920
MP4
H.264
AAC only if embedded audio is used
7–15 seconds
safe margins for TikTok/Reels UI
no Jovie watermark
```

### Step 5: Return chat card

The Jovie assistant posts the result directly in chat.

Buttons:

```ts
[
  "Download MP4",
  "Copy Caption",
  "Share",
  "Open TikTok",
  "Make 5 More",
  "Save to Campaign"
]
```

## MVP UI inside Jovie Chat

Example response:

```txt
I made 3 TikTok-ready variants for “Track Name.”

Variant 1: emotional lyric hook
Best for: saves/comments
[Preview]
[Download] [Copy Caption] [Share to TikTok] [Make More Like This]

Variant 2: creator-bait sound prompt
Best for: UGC
[Preview]
[Download] [Copy Caption] [Share to TikTok] [Make More Like This]

Variant 3: meme/POV version
Best for: shares
[Preview]
[Download] [Copy Caption] [Share to TikTok] [Make More Like This]
```

## Flexible architecture

Keep it as a **tool registry** behind chat.

```ts
/tools/generate-short-form-post
/tools/render-short-form-video
/tools/generate-caption
/tools/find-platform-sound
/tools/create-post-package
/tools/create-variants
```

The chat agent orchestrates them.

Do not hardcode “TikTok viral video generator.” Make it:

```ts
CreativePackageGenerator
PlatformPostingHelper
SoundSelectionHelper
```

That keeps it flexible for:

- TikTok
- Reels
- Shorts
- future auto-posting
- future paid ads
- future creator briefs
- future optimizer loop

## What to build first

Build this exact slice:

1. Jovie Chat command: **“make a TikTok for this song”**
2. Song selector from Jovie catalog
3. 3 video templates
4. Caption/hashtag generation
5. Official TikTok sound field
6. MP4 render
7. Chat result card
8. Download button
9. Copy caption button
10. Native share button
11. “Make 5 more” button

That is the fastest usable product.

## What to skip for MVP

Skip:

- OAuth
- auto-posting
- TikTok Direct Post
- Instagram Graph publish
- YouTube upload API
- analytics ingestion
- fMRI/virality predictor
- automated daily calendar
- account linking
- platform review/audit

Those can come after artists actually use the generator.

## Best MVP positioning

Call it:

**Jovie Short-Form Generator**

In chat:

```txt
Generate a short-form post for this song.
```

Product copy:

```txt
Turn any release into TikTok/Reels/Shorts-ready posts in seconds.
Generate the video, caption, hashtags, and posting instructions. You stay in control and post from your own account using the official sound.
```

## Next version after MVP

Once users generate and manually post, add:

1. “Paste your TikTok/Reel/Short URL here”
2. Jovie stores the post URL
3. Jovie fetches or lets the user enter metrics
4. Jovie recommends the next variant

That creates the loop without full platform automation:

```txt
Generate → user posts → paste URL → measure → generate better version
```

That is the right wedge. Fast, simple, platform-safe, and directly aligned with Jovie Chat.

---

## User

It should, on the share, have an interstitial that says something like "Important" and explains how to attach the sound and all that, so you walk the user through it. You should also display an inline QR code, if possible, to have them scan it. I don't know if this is possible. Is there an inline QR code we can have them scan that would attach the file and open the TikTok app on their mobile phone? It's like a QR handoff, which is a component we should generally have in our chat when we want to share things and be open on mobile. 

---

## Assistant

I’ll separate immediate web-chat behavior from native/TikTok-dependent handoff limits, then spec the safest QR flow and the upgrade paths for mobile sharing.

---

## Assistant

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
```

Public docs support sharing/uploading a video, and direct posting supports caption/privacy/disclosure fields, but I do not see a public TikTok field for selecting an official library sound by ID during upload/post. TikTok’s Direct Post API covers video upload/export, caption, privacy, duet/stitch/comment settings, brand toggles, and source info; it requires audit for public posting beyond private-mode restrictions. citeturn277205view5

So the MVP should **guide the user**, not pretend to automate official sound attachment.

---

# MVP component: `ShareInterstitial`

Trigger: user clicks **Post to TikTok** from a generated Jovie Chat post card.

## Interstitial copy

Use direct, practical copy:

```txt
Important: attach the official TikTok sound

To make this count toward the song’s TikTok sound page, post using the official TikTok sound.

1. Scan the QR code and open this video on your phone.
2. Download or share the video to TikTok.
3. In TikTok, tap Add Sound.
4. Search: “{Track Name} {Artist Name}”
5. Select the official artist sound.
6. Set original audio volume to 0 if this video has scratch audio.
7. Paste the caption below.
8. Post.

Do not post with only the video’s original audio unless you do not care about sound-page tracking.
```

Buttons:

```txt
[Copy sound search]
[Copy caption]
[Open official sound]
[Download MP4]
[Share from phone]
```

QR label:

```txt
Scan to open this video on your phone
```

## Desktop modal layout

```txt
┌─────────────────────────────────────────────┐
│ Important                                   │
│ Attach the official TikTok sound before     │
│ posting so usage counts toward the track.   │
│                                             │
│ [Video thumbnail]       [QR code]           │
│                         Scan on phone       │
│                                             │
│ Sound: Track Name - Artist                  │
│ Search TikTok: "Track Name Artist"          │
│                                             │
│ Caption:                                    │
│ "..."                                       │
│                                             │
│ [Copy Caption] [Copy Sound Search]          │
│ [Download MP4] [Open Mobile Handoff]        │
└─────────────────────────────────────────────┘
```

## Mobile handoff page layout

```txt
Post this TikTok

[Video preview]

Step 1
Save or share the video.

[Share Video]
[Download MP4]

Step 2
Attach the official sound.

Sound:
Track Name - Artist

Search:
"Track Name Artist"

[Copy Sound Search]
[Open Official Sound]

Step 3
Paste caption.

[Copy Caption]

Step 4
Post, then paste the TikTok URL here.

[Paste posted URL]
[Save Result]
```

---

# Best trackable TikTok flow

For the TikTok library sound goal, the best flow is:

1. Jovie renders a video with **no final music** or quiet scratch audio.
2. User opens mobile handoff.
3. User saves/shares video.
4. User opens TikTok.
5. User selects official TikTok sound.
6. User uploads the generated video.
7. User mutes original/scratch audio.
8. User posts.

This preserves attribution to the official sound better than burning the song into the MP4.

## Alternative flow: official sound first

If you have the official TikTok sound URL:

```txt
1. Scan QR.
2. Download the video.
3. Tap Open Official Sound.
4. In TikTok, tap Use this sound.
5. Upload the generated video.
6. Paste caption.
7. Post.
```

This may be more intuitive because the user starts from the sound page. I would include both, but make **“Use official sound first”** the recommended flow when the sound URL exists.

---

# Jovie implementation spec

## Chat tool output

When the Jovie chat skill generates a post, return:

```ts
type GeneratedShortFormPost = {
  id: string;
  artistId: string;
  releaseId: string;
  trackId: string;

  videoUrl: string;
  thumbnailUrl: string;
  caption: string;
  hashtags: string[];

  platform: "tiktok" | "reels" | "shorts";
  soundStrategy: "manual_official_sound" | "embedded_audio" | "silent_for_platform_sound";

  officialSound?: {
    platform: "tiktok";
    soundName: string;
    soundUrl?: string;
    searchQuery: string;
  };

  handoffUrl: string;
  expiresAt: string;
};
```

## Handoff URL

Use a short, signed URL:

```txt
https://jov.ie/h/{handoffId}
```

Backed by:

```ts
handoffs {
  id
  post_package_id
  user_id
  artist_id
  video_asset_id
  signed_token_hash
  expires_at
  created_at
  opened_at
  last_mobile_open_at
}
```

The QR code encodes only the handoff URL.

## Security

Use:

- Signed token
- Expiration window, like 7–30 days
- No private unreleased asset exposed without token
- Optional “regenerate link”
- Watermark-free video
- Rate limit downloads
- Log opens/downloads/shares

## QR generation

Client-side option:

```tsx
<QRCodeCanvas value={handoffUrl} size={180} />
```

Server-side option:

```ts
GET /api/qr?url=https%3A%2F%2Fjov.ie%2Fh%2Fabc123
```

The component should be reusable across Jovie Chat for any mobile handoff:

```ts
<MobileHandoffCard
  title="Post this on TikTok"
  description="Scan to open the video, caption, and sound instructions on your phone."
  url={handoffUrl}
/>
```

Use it later for:

- TikTok posting
- Reels posting
- Shorts posting
- Spotify canvas preview
- fan link preview
- mobile checkout
- creator brief handoff
- text-to-phone workflows

---

# Share action logic

On mobile:

```ts
async function shareVideo(videoUrl: string, caption: string) {
  const res = await fetch(videoUrl);
  const blob = await res.blob();

  const file = new File([blob], "jovie-short.mp4", {
    type: "video/mp4",
  });

  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      title: "Post this short",
      text: caption,
      files: [file],
    });
  } else {
    window.location.href = videoUrl;
  }
}
```

Use fallback copy:

```txt
Your browser cannot share this file directly. Download the MP4, open TikTok, upload the video, and attach the official sound.
```

---

# Product states

## Case A: official TikTok sound URL exists

Show:

```txt
Recommended: open the official sound first.
```

Buttons:

```txt
[Download Video]
[Open Official Sound]
[Copy Caption]
```

Instructions:

```txt
Tap “Use this sound,” upload the downloaded video, mute original audio, paste caption, post.
```

## Case B: only sound search query exists

Show:

```txt
Search TikTok for:
"{Track Name} {Artist Name}"
```

Buttons:

```txt
[Copy Search]
[Download Video]
[Open TikTok]
```

## Case C: no official sound exists yet

Show:

```txt
This track does not have an official TikTok sound saved in Jovie.
```

Options:

```txt
[Post with embedded audio]
[Add TikTok sound URL]
[Copy instructions for manual setup]
```

For artist releases, also include:

```txt
Ask your distributor/label to confirm the track is delivered to TikTok’s music library.
```

---

# How this fits the Jovie Chat MVP

User says:

```txt
Make a TikTok for this song.
```

Jovie returns:

```txt
I made a TikTok-ready video for “Track Name.”

[Video preview]

Caption:
...

Sound:
Use the official TikTok sound:
Track Name - Artist

[Post to TikTok]
[Download MP4]
[Copy Caption]
[Make 5 More]
```

When user clicks **Post to TikTok**, open the interstitial.

That keeps the core MVP simple:

- no TikTok OAuth
- no platform audit
- no auto-posting
- no sound API dependency
- no brittle deep-link hack
- still gets the artist to the correct posting behavior

## Build priority

Build in this order:

1. `GeneratedPostCard`
2. `ShareInterstitial`
3. `MobileHandoffCard` with QR
4. `/h/[handoffId]` mobile page
5. Native share/download fallback
6. Official sound instructions
7. “Paste posted URL” tracking
8. Later: TikTok Upload API / Share Kit

The QR handoff becomes a general Jovie primitive. The TikTok-specific piece is just one template inside it.
