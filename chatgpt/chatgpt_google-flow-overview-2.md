---
title: "Google Flow Overview"
type: note
created: 2026-05-30
updated: 2026-05-30
source: chatgpt-export
conversation_id: 6a1b2852-75a0-83e8-9b21-1e17a4cc2bb7
message_count: 4
tags: [chatgpt, import, long-form]
---
# Google Flow Overview

> Conversation ID: 6a1b2852-75a0-83e8-9b21-1e17a4cc2bb7
> Created: 2026-05-30T18:11:31Z
> Updated: 2026-05-30T18:34:20Z
> Messages: 4

---

## User

google flow

---

## Assistant

urlGoogle Flowhttps://labs.google/fx/tools/flow is Google's AI filmmaking environment built on three core models:

- entity["software","Veo","Google DeepMind video generation model"] for video generation
- entity["software","Imagen","Google image generation model"] for images/assets
- entity["software","Gemini","Google multimodal AI model"] for prompting, planning, and orchestration citeturn0search0turn0search1

## What makes it different

Most AI video tools generate isolated clips.

Flow is structured more like an AI-native editing and production environment:

- Character consistency across scenes
- Object consistency
- Scene Builder for stitching clips together
- Asset management
- Camera direction prompts
- Multi-shot storytelling
- Native audio generation through newer Veo versions citeturn0search0turn0search3turn0search8

For Jovie, this matters because you're trying to create repeatable artist content pipelines, not just single TikTok clips.

## Relevant features for Jovie

### 1. Consistent AI artists

You can generate a fictional artist persona and keep them relatively consistent across shots.

Examples:

- MUFFINTOP
- Fictional DJ brands
- Virtual hosts
- AI music video characters

Flow is substantially better suited for this than throwing prompts directly into a raw video model. citeturn0search3turn0search6

### 2. Music video generation

You can build:

- Lyric videos
- Visualizers
- Performance videos
- Short-form promo clips
- Alternate versions for A/B testing

This aligns directly with your "generate 30 TikToks per song" concept.

### 3. Scene Builder

Scene Builder is probably the most important feature.

Instead of:

> generate clip → export → generate another clip

You can build sequences and maintain continuity across shots. citeturn0search5turn0search9

### 4. Agentic workflow direction

Google has been pushing Flow toward an agent model where you describe creative intent conversationally.

Recent updates introduced:

- Flow Agent
- Flow Tools
- Gemini Omni integration
- Natural-language editing workflows citeturn0search13turn0search17turn0search1

That direction is very compatible with what you're building in Jovie.

## What I would do

For Jovie:

1. Store artist knowledge graph.
2. Generate creative briefs automatically.
3. Generate shot lists automatically.
4. Send those briefs into Flow.
5. Produce:
   - TikToks
   - Shorts
   - Reels
   - Lyric videos
   - Visualizers
6. Route outputs into posting workflows.

The AI should decide:

- which song
- which audience
- which visual concept
- which platform
- which CTA

Flow becomes the rendering engine.

## Current limitation

The biggest limitation is still generation length.

Flow is strongest at:

- 5–15 second clips
- social content
- music video segments
- concept trailers

Not full narrative filmmaking yet. Most serious users are still building longer pieces from many generated shots. citeturn0search20turn0search8

## Strategic takeaway

For Jovie specifically, I would treat Flow the same way you treat ElevenLabs.

- ElevenLabs = voice rendering layer
- Flow = video rendering layer
- Jovie = orchestration layer

You do not want to compete with Flow.

You want Jovie generating the creative strategy, prompts, assets, personas, schedules, variants, and distribution workflows that sit on top of Flow. That gives you leverage every time Google improves Veo or Flow. citeturn0search0turn0search1turn0search13

---

## User

{'asset_pointer': 'sediment://file_00000000f18471f8ab1dd882c0c736d5', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1024, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1907270, 'width': 1536}
for build the bubble gum factory. this spec is perfect. Should we build it? Should we plug an agent into ICP Blender and have it build this whole room in Blender for us? If we do that, is there a free model that is capable enough to actually do that well, or should we just create it in Google Flow with Google Omni or whatever? Is this a Higgs field thing or something, trying to figure out how I lock this as a set? You know what I mean? 

---

## Assistant

Mr. White, this is exactly the kind of set I would build for Bubblegum Factory.

The bigger question is **what you're trying to lock**:

### Option A — Lock the set visually
Generate videos in Flow/Higgsfield/Omni.

Pros:
- Fast
- Cheap
- No Blender
- No render farm

Cons:
- Every shot is slightly different
- Hard to maintain exact camera positions
- Hard to build a recognizable studio brand

This is where AI video is today.

---

### Option B — Lock the set as a 3D asset
Build this room once in Blender.

Pros:
- Infinite consistency
- Infinite camera angles
- Easy to create new shots
- Can render stills, videos, diagrams, investor decks
- Can eventually become a virtual production stage

Cons:
- Initial setup effort

For Bubblegum Factory, I strongly prefer this approach.

---

## What I would do

Build:

- Bubblegum Factory Studio A
- Bubblegum Factory Studio B
- Bubblegum Factory Hallway
- Bubblegum Factory Lobby
- Bubblegum Factory Vault

as Blender assets.

Then:

- Export to Unreal
- Export to Gaussian splats
- Export to NeRF
- Export to Flow reference images
- Export to Higgsfield reference images

Now every AI system references the same world.

---

## Can AI build this in Blender?

Today?

Yes.

Perfectly?

No.

---

### Free models

The open-source models are not there yet.

Examples:

- Qwen3-Coder
- DeepSeek
- Kimi
- Owl

can generate Python scripts for Blender.

They can:

- create walls
- create tables
- place lights
- place cameras

They struggle with:

- beautiful proportions
- production design
- material work
- artistic judgment

You'll spend more time fixing than creating.

---

### Best current workflow

Use Claude Code or Gemini.

Give it:

- this image
- Blender MCP
- Blender running locally

Then say:

> Recreate this room as accurately as possible.

It will generate Python.

Blender executes it.

Agent iterates.

That workflow actually works surprisingly well right now.

---

## Flow vs Blender

These are different layers.

### Blender

Creates:

- canonical set
- geometry
- measurements
- camera positions

### Flow

Creates:

- actors
- movement
- cinematography
- final shots

Flow should consume Blender renders.

Not replace Blender.

---

## What I'd build first

Phase 1:

- Circular room
- Blast door
- Acoustic panels
- Table
- Camera windows

No materials.

No details.

Just geometry.

2-4 hours.

---

Phase 2:

- White materials
- Lighting
- Jovie branding
- Camera placement system

1 day.

---

Phase 3:

- Export 50 reference images

Then use those images inside:

- Flow
- Veo
- Higgsfield
- Runway
- Kling

to maintain consistency.

---

The asset that has long-term value is not the Flow prompt.

The asset is the Blender scene.

Once you own the Blender scene, every future video model becomes immediately useful because they all have a consistent world to reference. That world becomes the visual identity of Bubblegum Factory.


## See Also
- [[chatgpt/chatgpt_google-flow-overview]]
- [[chatgpt/chatgpt_google-admin-overview]]
- [[chatgpt/chatgpt_google-auth-console-overview]]
- [[chatgpt/chatgpt_google-cse-overview-2]]
- [[chatgpt/chatgpt_google-cse-overview]]
