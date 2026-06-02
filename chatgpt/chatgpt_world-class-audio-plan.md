---
conversation_id: 69e9975b-bad4-83e8-8f45-640461ff5962
created: 2026-04-23
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 5
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: World Class Audio Plan
type: essay
updated: 2026-04-23
---

# World Class Audio Plan

> Conversation ID: 69e9975b-bad4-83e8-8f45-640461ff5962
> Created: 2026-04-23T03:51:57Z
> Updated: 2026-04-23T05:43:40Z
> Messages: 5

---

## User

**Design doc:** `~/.gstack/projects/JovieInc-Jovie/timwhite-itstimwhite-audio-asset-system-design-20260422-000000.md`
**P1 implementation plan:** `~/.claude/plans/system-instruction-you-are-working-dynamic-church.md`

**Recommendation locked: Approach B — asset-centric, phased.** The asset is its own entity (kind enum covers master / stem / voice memo / extended mix / Atmos / digital master / AI output / etc.), recordings attach assets via a `role` join, releases get a `releaseDerivations` table for child-release lineage (acoustic / remix / Atmos / AI-mastered). Source audio lives in R2 with multipart uploads; derived waveform JSON + previews stay on Vercel Blob. Player is one portable React component (no Next-specific imports) so the future desktop shell wraps it without a rewrite.

**Two gates before P1 code starts:**
1. Job runner — confirm what's already in the repo (Inngest / Trigger.dev / BullMQ / nothing). If nothing, decide before writing P1.
2. FFmpeg execution model for LUFS — Vercel function with FFmpeg layer vs. small Fly.io worker. Lean Fly.io.

**The assignment** (from the design doc): drop 5 of your own tracks — a master, an extended mix, a stem pack, a voice memo, an Atmos file — into a folder and write down by hand what you'd want to do with each one inside Jovie in the next 30 days. If any of the 5 doesn't fit the `kind` / `role` enums in this design, the model is wrong and you'll find out before any code exists. Cheap insurance against schema regret.

**Next skills:** `/plan-eng-review` to pressure-test the P1 architecture (R2 multipart correctness, signed-URL ACL surface, async pipeline semantics) before any code lands. `/plan-ceo-review` if you want to challenge whether P3's child-releases or P4's AI mastering should jump ahead of P2 — there's a real argument that AI-master-from-voice-memo is the more shareable demo than DJ tables.

STATUS: **DONE** — design approved, plan written, two pre-implementation gates flagged.


help me make the above a world class plan to add world class suport to jovie for audio files. Investiate disco, session studio, audiio, music bed, spotify, apple music, splice, serato, rekordbox, eleven labs, mixed in key, pro tools, ableton, and logic, apple tv, netflix, and any other worldclass apps built around audio. extract the best of the best and make this a powerful plan for features that matter, perfect schema, and gorgeous UX.

the goal is to support audio from idea in a voice memo, to 30 ideas in a voice memo, to 50 aideas in voice memos from multiple parties to 150 bounces of demo verison to 200 nounces of production then mix drafter then mix then stems then mastered mix then masted stems, tv track, cutdowns for sync, acapella versions alt versions (heres a cut wiht no vocal except the oohs in the chorus for the BMW 30s spot during the superbowl) and then

consider futerproof for video and photos as we support genration of album art, and music videos and lyric videos and video ads, etc. and we become a world class digital asset manager.

dig into frame.io and pix and davinci resolve and see what useful things we cna extract there as well.

then give me world class infrastructure taht makes sense for jovie and a plan to build this rock solid and clean and simple ux.

---

## User

i just gave you jovie access.

were moving towards agents and have trigger in the works for long running agent workflows. and wed love to add skills like auto create 30s cutdown for tv etc, so cue points and looping are great. and being able to set cue points in the app and have them land in serto or rekorbox will be huge for djs. we should look at lexicon dj  as well as its the best app for library managment djs pay for on top of rekordbox. 

---

## Assistant

Mr. White, I’ll make Trigger-style long-running workflows a core constraint, elevate DJ cue/loop portability and Lexicon-grade library management into first-class pillars, and validate the architecture against the repo access you enabled.

---

## Assistant

I found the missing primitives: a timeline/marker model, delivery specs, and human review/approval, alongside review-grade creative asset management and DJ-library interoperability. Benchmarks point to first-class cue objects plus strong catalog/search/share/security, credits and splits at creation, versioned review, and Trigger-backed agent recipes.

---

## Assistant

Mr. White, I don’t currently see the two local markdown files or repo contents in this chat’s searchable context, so I’m working from your pasted plan plus fresh product research. The current Approach B is still right, but it needs one upgrade: **Jovie should become an asset graph + creative workflow system**, not a file uploader with audio playback.

## The upgraded thesis

**Jovie should support the full life of a song and every asset around it:**

voice memo → extracted ideas → collaborator ideas → demos → production bounces → mix drafts → mix revisions → stems → mastered mix → mastered stems → Atmos → TV track → clean / explicit / instrumental / acapella → 15s / 30s / 60s cutdowns → sync alternates → DJ edits → release assets → artwork → lyric video → music video → ads.

That means the product model should be:

**Work → Recording → Asset graph → Versions → Markers / cues / segments → Deliverables → Shares / approvals → Agent-generated derivatives.**

Trigger.dev should become the P1 job runner unless the repo already has a stronger committed runner. Trigger is aligned with where Jovie is going: long-running tasks, queues, retries, observability, realtime frontend updates, FFmpeg support, Python support, and human-in-the-loop workflows via waitpoints. citeturn682728search2turn682728search5turn682728search0turn682728search3

---

## What to extract from world-class products

**DISCO teaches the music-library layer.** A “track” should connect original high-quality files, streamable previews, metadata, and alternate formats without creating duplicate chaos. DISCO also shows the value of recipient-specific sharing, watermarked playlists, alias metadata, and controlled download formats. Jovie should copy the principle: one asset, many files, many share contexts, each with different metadata and permissions. citeturn229516search9turn229516search11turn229516search7turn229516search8

**Session Studio teaches the creation-rights layer.** Credits, splits, creator identifiers, voice memos, lyrics, notes, DAW-connected uploads, release metadata, and label copy belong near the beginning of the song lifecycle, not after the master exists. Jovie should let people capture ownership, credit, and participation while the idea is still messy. citeturn229516search0turn229516search1turn229516search2turn229516search5

**Lexicon DJ / Rekordbox / Serato / OneLibrary teach the DJ-performance layer.** Cue points, loops, beatgrids, playlists, key, BPM, and energy are not cosmetic metadata. They are performance data. Lexicon’s core value is cross-DJ-library management across Rekordbox, Serato, Traktor, VirtualDJ, and Engine DJ; OneLibrary is moving the industry toward standardized playlists, cue points, beatgrids, waveforms, and USB/device interoperability. citeturn247625search3turn247625search1turn774170search0turn774170search6

**Serato and Mixed In Key make the cue-point requirement concrete.** Serato supports up to 8 cue points and saves cue data to the file when writable; Mixed In Key exports key, energy, ID3 tags, and up to 8 automatic cue points into Rekordbox, Serato, and Traktor workflows. Jovie should treat cue sets as portable objects that can be exported to different targets. citeturn247625search0turn247625search2turn174587search6turn174587search2

**Splice / Ableton / Logic / Pro Tools teach the idea-to-arrangement layer.** Splice Bridge previews samples in the tempo and key of the DAW session, Ableton uses locators and loopable arrangement sections, Logic has track alternatives, stem splitting, mastering assistance, Atmos preview exports, and AI session players, and Pro Tools Sketch uses nonlinear clips/scenes before promotion into a linear session. Jovie should support both messy nonlinear idea capture and linear timeline review. citeturn108480search6turn108480search7turn824510search0turn873402search3turn396783search3

**Frame.io / PIX / DaVinci Resolve teach the review-and-approval layer.** Frame.io V4’s strongest ideas are custom metadata fields, real-time collections, high-precision review, anchored comments, and upload workflows. PIX adds secure dailies-style review with frame/page-specific markup, one-touch approvals, offline DRM, visual/forensic watermarking, encryption, 2FA, and activity logging. DaVinci Resolve adds shared markers, timeline comparison, cloud collaboration, and bidirectional review comments. citeturn119813search2turn119813search0turn488780search0turn488780search3turn119813search4

**Spotify / Apple Music / Netflix teach the delivery-QC layer.** Spotify normalizes playback around -14 LUFS and gives true-peak mastering guidance; Apple Digital Masters, Apple Music Spatial Audio / Dolby Atmos, and Netflix’s audio specifications show that serious audio platforms need explicit deliverable profiles, loudness reports, channel layouts, sample-rate / bit-depth validation, and pass/fail QC. citeturn675919search0turn675919search9turn675919search5turn942628search2

---

# The schema upgrade

The current asset-centric design is right. The risky part is using a single `kind` enum to carry too much meaning. Use a **hybrid taxonomy**:

1. Hard enum for broad, stable classes.
2. Seeded database rows for extensible kinds, roles, delivery profiles, and agent skills.
3. Freeform tags only for user-specific vocabulary.

This avoids schema regret when tomorrow’s category is “BMW 30s no lead vocal except chorus oohs” or “TikTok hook loop with dry vocal stem.”

## Core entities

### `works`

Represents the composition / song idea.

Fields:

```ts
work.id
work.orgId
work.title
work.status // idea | writing | production | mix | mastering | released | archived
work.primaryArtistId
work.bpm
work.key
work.timeSignature
work.createdFromAssetId // optional voice memo / idea source
```

A work can exist before a recording, release, or master exists.

### `recordings`

Represents a specific recorded embodiment of a work.

```ts
recording.id
recording.workId
recording.title
recording.recordingType // demo | production | live | remix | acoustic | alt | ai_generated
recording.status
recording.isrc
recording.durationMs
```

A work can have many recordings: original, acoustic, remix, live, Atmos, AI-mastered, etc.

### `assets`

Represents a logical asset, not merely a file.

```ts
asset.id
asset.orgId
asset.mediaType // audio | video | image | document | project | package
asset.kindCategory // capture | session | bounce | mix | master | stem | cutdown | artwork | video | deliverable | generated | reference
asset.title
asset.description
asset.lifecycleStage // idea | demo | production | mix | master | release | sync | promo | archive
asset.sourceType // upload | generated | imported | external_link | recorded_in_app
asset.createdByUserId
asset.currentVersionId
asset.contentFingerprint
asset.deletedAt
```

### `assetFiles`

Represents physical files and generated renditions.

```ts
assetFile.id
assetFile.assetId
assetFile.versionId
assetFile.storageProvider // r2 | vercel_blob | external
assetFile.storageKey
assetFile.fileRole // original | preview | waveform | thumbnail | sidecar | qc_report | export
assetFile.mimeType
assetFile.codec
assetFile.container
assetFile.sizeBytes
assetFile.sha256
assetFile.durationMs
assetFile.sampleRate
assetFile.bitDepth
assetFile.channels
assetFile.channelLayout
assetFile.width
assetFile.height
assetFile.frameRate
```

This future-proofs video, photos, album art, music videos, lyric videos, ads, and documents.

### `assetVersions`

Use for the 150 demo bounces and 200 production bounces.

```ts
assetVersion.id
assetVersion.assetId
assetVersion.versionNumber
assetVersion.label // "Mix Draft 14", "Master v3", "BMW 30 no lead vox"
assetVersion.parentVersionId
assetVersion.createdFromAssetId
assetVersion.createdByUserId
assetVersion.changeNote
assetVersion.status // draft | review | approved | rejected | superseded | final
assetVersion.createdAt
```

### `assetEdges`

The most important table. This makes Jovie an asset graph.

```ts
assetEdge.id
assetEdge.fromAssetId
assetEdge.toAssetId
assetEdge.relationship
```

Relationships:

```ts
derived_from
rendered_from
split_from
stem_of
mastered_from
cutdown_of
version_of
contains
references
replaces
approved_from
generated_from
synced_to_picture
```

Examples:

- “Master v4” `mastered_from` “Final Mix v9”
- “30s BMW cutdown” `cutdown_of` “Master v4”
- “No lead vocal except chorus oohs” `derived_from` “Stem pack v2”
- “Lyric video” `synced_to_picture` “Master v4”
- “Album art square” `derived_from` “AI artwork generation run”

### `assetRecordingRoles`

This keeps `kind` clean. The same asset can play different roles in different contexts.

```ts
assetRecordingRole.id
assetId
recordingId
role
isPrimary
sortOrder
```

Roles should be seeded rows, not a brittle Postgres enum:

```ts
voice_memo
idea_fragment
demo_bounce
production_bounce
mix_draft
mix_revision
final_mix
master
digital_master
apple_digital_master
spotify_master
atmos_master
stem_pack
stem
mastered_stem
instrumental
acapella
clean
explicit
tv_track
m_and_e
underscore
no_lead_vocal
background_vocals_only
chorus_oohs_only
sync_cutdown
fifteen_second
thirty_second
sixty_second
trailer_cut
social_cut
dj_edit
extended_mix
radio_edit
remix
reference
ai_output
```

### `markers`

First-class. Do not bury this in JSON.

```ts
marker.id
assetId
assetVersionId
markerSetId
type // cue | loop | section | lyric | comment_anchor | edit_point | sync_point | locator | beatgrid_marker
name
description
startMs
endMs
bar
beat
frameTimecode
color
slot // 1-8 for Serato/Mixed In Key style hot cues
loopLengthBeats
isActiveLoop
isQuantized
confidence
source // user | ai | imported | mixed_in_key | rekordbox | serato | ableton | logic | pro_tools
```

This one table supports:

- Serato/Rekordbox hot cues
- Lexicon-style cue names/colors/loops
- Ableton locators
- Pro Tools memory-location-like markers
- Frame.io-style comment anchors
- lyric timestamps
- sync edit points
- “start chorus oohs here”
- “cut to logo here”
- “make 30s from this range”

### `markerSets`

A single song can have many cue sets.

```ts
markerSet.id
assetId
name // "DJ set", "Sync edit", "Writer notes", "BMW spot"
target // internal | serato | rekordbox | onelibrary | traktor | ableton | logic | pro_tools | resolve
createdByUserId
isDefault
```

### `segments`

Use for voice memos with 30 ideas.

```ts
segment.id
assetId
assetVersionId
type // idea | hook | verse | chorus | bridge | drop | note | lyric | melody | beat | reference | issue
title
summary
startMs
endMs
transcriptText
speakerId
confidence
promotedWorkId
```

A 45-minute voice memo can become 30 structured ideas. Each idea can later become its own work, recording, or task.

### `analysisReports`

```ts
analysisReport.id
assetFileId
analyzer // ffprobe | ffmpeg_ebur128 | essentia | ai_transcription | stem_separator | image_analyzer
status
bpm
musicalKey
camelotKey
energy
integratedLufs
truePeakDbtp
loudnessRange
dynamicRange
silenceRanges
explicitContent
language
transcriptJson
waveformBlobKey
spectrogramBlobKey
rawJson
```

### `deliverableProfiles`

This makes “make this Netflix-ready / Spotify-ready / sync-ready” possible.

```ts
deliverableProfile.id
name
mediaType
target // spotify | apple_music | netflix | sync | radio | dj | instagram | tiktok | youtube | internal_review
requirementsJson
```

Examples:

- Spotify stereo master QC
- Apple Digital Master
- Apple Music Dolby Atmos
- Netflix 5.1 / Atmos nearfield
- 30s broadcast ad
- 15s vertical social ad
- Rekordbox USB export package
- DISCO-style sync pitch package

### `comments` / `approvals`

```ts
comment.id
assetId
assetVersionId
markerId
body
visibility // internal | client | public_share
createdByUserId
resolvedAt
```

```ts
approval.id
assetId
assetVersionId
scope // creative | legal | mix | master | sync | release | client
status // requested | approved | changes_requested | rejected
approvedByUserId
approvedAt
```

### `shares`

```ts
share.id
orgId
assetId
collectionId
recipientId
permission // stream | download_preview | download_original | comment | approve
expiresAt
watermarkMode // none | visual | audio | forensic | recipient_text
aliasMetadataJson
downloadFormatsJson
```

This is the DISCO + PIX layer for secure pitching, client review, sync approvals, and leak tracing.

### `agentRuns`

```ts
agentRun.id
orgId
skillId
inputAssetId
outputAssetId
status
triggerRunId
prompt
parametersJson
humanApprovalRequired
approvedByUserId
logsUrl
createdAt
completedAt
```

Skills:

```ts
extract_ideas_from_voice_memo
split_voice_memo_by_idea
transcribe_and_diarize
generate_cue_points
generate_dj_loops
create_30s_cutdown
create_15s_social_cut
create_tv_track
create_no_lead_vocal_alt
create_acapella
create_instrumental
create_stem_pack
master_for_streaming
qc_for_spotify
qc_for_apple_music
qc_for_netflix
generate_album_art
generate_lyric_video
generate_music_video_treatment
package_sync_delivery
export_rekordbox
export_serato
```

---

# UX: the product should feel simple

## 1. Work page: “everything for this song”

Top nav:

```txt
Overview | Ideas | Versions | Assets | Review | Deliverables | Credits | Activity
```

The user should never wonder “where is Mix 87?” or “which master did we send to the client?” Every asset appears in one lineage graph and one chronological timeline.

## 2. Player: one beautiful portable component

The player needs:

- waveform
- spectrogram optional later
- A/B compare
- version switcher
- comments pinned to time
- markers/cues/loops visible as lanes
- sections: intro, verse, chorus, bridge, drop, outro
- transcript lane for voice memos
- lyrics lane for songs
- loudness / BPM / key badges
- “create from selection” action

The killer interaction:

```txt
Select time range → “Make 30s cutdown” / “Create cue” / “Promote idea” / “Comment” / “Export loop”
```

## 3. Idea inbox for voice memos

For a voice memo with 30 ideas:

```txt
Voice Memo: April 22 Writing Session
[Idea 01] 00:12–01:04 “minor chorus melody”
[Idea 02] 01:05–02:18 “BMW no-vocal sync thought”
[Idea 03] 02:19–04:01 “hook lyric option”
...
```

Each idea has:

```txt
Play | Rename | Assign | Promote to Work | Attach to Existing Song | Generate Demo | Archive
```

For multi-party voice memos, show speakers and credits early.

## 4. Version river for 200 bounces

Make versioning visual:

```txt
Voice memo
  → Demo bounce 001–150
    → Production bounce 001–200
      → Mix draft 01–25
        → Final mix
          → Master v1–v5
            → Mastered stems
            → TV track
            → 30s cutdown
            → BMW alt: no lead vocal except chorus oohs
```

This should feel like Figma version history + Frame.io review + Git lineage, without looking technical.

## 5. Deliverable Builder

A user selects:

```txt
Create deliverables
Target: Sync / TV Ad
Length: 30s
Vocal rule: no lead vocal except chorus oohs
Required files: WAV, MP3 preview, stems, instrumental, lyric sheet
Reviewers: manager, client, mixer
```

Jovie creates a job plan, runs the agent/FFmpeg pipeline, produces files, QC reports, and a share page.

## 6. DJ Prep room

For DJs:

```txt
Cues | Loops | Beatgrid | Key | Energy | Export
```

Actions:

```txt
Generate cue points
Quantize cues to beatgrid
Create intro/outro loops
Export Rekordbox XML
Export Serato-compatible cue metadata
Export OneLibrary package when practical
```

This is where Lexicon is the benchmark. Jovie should not try to replace Rekordbox or Serato; Jovie should become the upstream prep and collaboration layer.

## 7. Review room

For managers, mixers, labels, sync clients:

- stream-only links
- expiring links
- recipient-specific watermarking
- timestamp comments
- approvals
- download format controls
- internal vs external metadata
- audit log

This is the “DISCO + Frame.io for music assets” surface.

---

# Infrastructure plan

## Storage

Keep the current split:

```txt
R2: immutable source files, masters, stems, large video, original artwork
Vercel Blob: previews, waveform JSON, thumbnails, lightweight review proxies
Postgres: metadata, graph, permissions, jobs, comments, markers, lineage
```

R2 should use direct multipart uploads with short-lived presigned URLs. Cloudflare documents presigned URLs as temporary bearer-token-style access for specific operations, resources, and expirations, and recommends content-type restrictions and CORS controls. citeturn425939search0turn425939search3

Vercel Blob is still good for preview/proxy files and supports multipart uploads, progress tracking, and client uploads. Vercel recommends multipart uploads for large files above 100 MB, but R2 should remain the canonical home for source audio/video. citeturn425939search5turn425939search4

## Job runner

Lock **Trigger.dev** as the orchestrator for P1.

Use Trigger for:

- upload finalization
- ffprobe analysis
- preview transcodes
- waveform generation
- LUFS / true peak analysis
- transcription
- idea extraction
- stem separation jobs
- cutdown generation
- cue generation
- approval-gated agent workflows
- DJ export jobs
- video proxy jobs later

Use Fly.io only if a workload outgrows Trigger’s machines or needs special native dependencies, persistent disk, or GPU isolation. For now, Trigger reduces architectural surface area.

## Pipeline

```txt
1. Client requests upload session
2. Server creates Asset + AssetVersion + pending AssetFile
3. Client uploads directly to R2
4. Client commits upload with checksum, size, MIME
5. Trigger job validates object exists
6. ffprobe extracts technical metadata
7. Generate preview MP3/AAC
8. Generate waveform JSON
9. Run loudness / true peak analysis
10. Run optional transcription / AI segmentation
11. Update asset status to ready
12. Notify UI through realtime run updates
```

Every processing job should be idempotent:

```txt
idempotencyKey = assetFileId + processor + processorVersion + profileHash
```

## Access control

Use app-level authorization as source of truth. R2 object paths should never imply access.

Rules:

- originals are private
- previews are private unless intentionally public
- every signed URL is short-lived
- share links resolve through Jovie permissions
- downloads are logged
- external recipients get scoped access
- watermarking is generated per share recipient where needed

DISCO and PIX both prove that sharing, watermarking, recipient-level tracking, and review controls are core features for professional creative assets. citeturn229516search7turn229516search8turn488780search0

---

# Revised build plan

## P0 — before code

Replace the “5 tracks” assignment with a **dirty dozen corpus**:

1. raw voice memo with 30 ideas  
2. multi-party voice memo with 50 ideas  
3. messy demo folder with many bounces  
4. production folder with 200 bounces  
5. mix draft sequence  
6. final mix  
7. mastered mix  
8. mastered stems  
9. stem pack  
10. Atmos / immersive file  
11. TV track / instrumental / acapella / clean / explicit variants  
12. BMW 30s cut: no lead vocal except chorus oohs  

Add three non-audio assets:

13. album art  
14. lyric video  
15. music video / ad creative  

If any cannot be represented cleanly by `asset`, `assetFile`, `assetVersion`, `assetEdge`, `marker`, `segment`, and `role`, the schema is wrong.

## P1 — asset graph + audio core

Build:

- R2 direct upload
- asset / assetFile / assetVersion / assetEdge schema
- recording-role join
- portable player
- waveform generation
- preview generation
- ffprobe metadata
- LUFS / true peak report
- status lifecycle
- Trigger pipeline
- basic comments
- basic version history
- first-class markers/cues

Success criteria:

```txt
A user can upload a voice memo, master, stem pack, extended mix, and Atmos file.
Each gets analyzed, previewed, versioned, and attached to the right work/recording.
A user can add cue points and comments on the waveform.
```

## P2 — review rooms + deliverables

Build:

- external share pages
- stream/download permissions
- timestamp comments
- approvals
- alias metadata
- expiring links
- audit log
- deliverable builder
- profile-based exports: MP3 preview, WAV, AIFF, ZIP package
- QC report attached to deliverable

This gives Jovie a DISCO/Frame.io-grade professional workflow.

## P3 — agent skills that matter

Ship the most magical workflows:

```txt
Voice memo → 30 ideas
Voice memo idea → rough demo
Master → 30s / 15s / 60s cutdowns
Master + stems → TV track
Master + stems → no lead vocal except chorus oohs
Mix → streaming QC report
Mix → suggested cue points
Song → sync pitch package
```

Use Trigger waitpoints for human approval before destructive or client-facing outputs.

## P4 — DJ interoperability

Build:

- cue sets
- loop sets
- beatgrid storage
- key / energy / BPM analysis
- Rekordbox XML export
- Serato cue metadata research/export path
- OneLibrary watch
- Lexicon import/export compatibility research
- DJ package export: audio + cues + playlist + notes

The first target should be **Rekordbox XML export**, because it is the clearest practical export path and widely used by the ecosystem. Then add Serato-compatible metadata where feasible.

## P5 — video, photos, and full DAM

Add:

- image assets
- generated album art
- art versions
- video assets
- proxy video generation
- frame-accurate comments
- thumbnails
- shot/scene markers
- lyric video generation
- music video treatments
- ad creative cutdowns
- color/version metadata later

This is where the Frame.io/Pix/DaVinci model fully matters.

---

# Key product decisions

## 1. Make `marker` P1, not later

Cues, loops, locators, comment anchors, lyric timestamps, and sync edit points are all the same primitive: a named point or range in media time.

That primitive unlocks:

- DJ cues
- loop export
- voice memo idea extraction
- lyric timing
- sync cutdowns
- review comments
- video frame notes later

## 2. Make `assetEdge` P1, not later

Without graph lineage, 200 bounces become a folder. With graph lineage, they become a creative history.

## 3. Use Trigger for agents and media processing orchestration

The old gate was “Vercel function with FFmpeg vs Fly.io worker.” The better answer now is:

```txt
Trigger orchestrates.
Trigger runs FFmpeg jobs where practical.
Fly.io remains the escape hatch for heavier or specialized media workers.
```

## 4. Do not let database enums become the product ceiling

Use stable enums for broad classes only. Use seeded taxonomy tables for roles, deliverable profiles, marker types, and agent skills.

## 5. Build the UX around actions, not files

The core UI should answer:

```txt
What is this?
Where did it come from?
What version is it?
What can I do with it next?
Who approved it?
Where was it sent?
What was generated from it?
```

---

# The upgraded one-line plan

**Build Jovie’s audio system as an asset graph with first-class versions, roles, cues, markers, comments, approvals, deliverables, and Trigger-powered agent workflows, starting with audio but using media-agnostic primitives so album art, music videos, lyric videos, ad creative, and full DAM workflows fit without a rewrite.**


**Topic:** [[chatgpt-clusters/coding_ai]]
