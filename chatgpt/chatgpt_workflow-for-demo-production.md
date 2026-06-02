---
title: "Workflow for Demo Production"
type: essay
created: 2026-05-30
updated: 2026-05-30
source: chatgpt-export
conversation_id: 6a1a6f51-bd4c-83e8-bf16-5caf2509dcea
message_count: 14
tags: [chatgpt, import, code, long-form]
---
# Workflow for Demo Production

> Conversation ID: 6a1a6f51-bd4c-83e8-bf16-5caf2509dcea
> Created: 2026-05-30T05:02:11Z
> Updated: 2026-05-30T20:03:31Z
> Messages: 14

---

## User

is there a decent workflow for "drop a poor quality demo get out a produced version with the same voice on it but tunes and procsed. same production melodies just produced."

---

## Assistant

Mr. White, I’ll map a practical demo-to-polished-production workflow that preserves the voice and melodic ideas while covering cleanup, tuning, arrangement rebuilding, and mixing.

---

## User

like suno but not 
1) cant expose the song publicly or give up any writes.
its a humab made and recorded song i just want to drop it into an suno type model and get out a polished demo i can use to pitch it to DJs. the goal is nto to release it as is.

---

## Assistant

I’m also separating reliable current tools from AI-heavy “one-click” options, since exact structure is safer via vocal extraction, DAW rebuild, tuning, and possible voice conversion.

---

## User

rights

---

## Assistant

I’m narrowing the rights issue to upload/license exposure: keep the unpublished song, vocal likeness, composition, and master inside a private pipeline, using cloud AI only for low-risk references.

---

## Assistant

Mr. White, yes. The rights-safe workflow is a **private demo-to-pitch-production pipeline** using a producer plus local/standard audio tools.

I would avoid uploading the unreleased song to a Suno-style consumer generator. Suno’s current terms grant a broad license to uploaded content, including for “improvement” of products and AI/ML models, which conflicts with your requirement to keep the song private and avoid giving up rights. citeturn109770view0

## Best workflow

### 1. Keep the original human vocal

Use the actual singer’s vocal, cleaned and tuned. Avoid voice cloning unless there is a written, private, no-training enterprise agreement.

Tools/workflow:

| Task | Typical tool class |
|---|---|
| Noise, room, clicks, hum, clipping cleanup | iZotope RX |
| Pitch correction | Melodyne, Revoice Pro, Auto-Tune |
| Timing / phrasing tightening | Revoice Pro, Melodyne, DAW editing |
| Vocal polish | EQ, compression, de-essing, saturation, delay/reverb |

Melodyne is designed for natural vocal pitch correction while preserving performance feel, and Revoice Pro covers pitch, timing, alignment, and vocal doubling. citeturn109770view2turn792952view2 RX is the standard type of tool for repairing noise, hum, clicks, clipping, reverb, and other recording flaws. citeturn109770view3

### 2. Use the rough demo as the blueprint

The producer imports the demo into Ableton, Logic, Pro Tools, or FL and maps:

| Element | Preserve |
|---|---|
| Topline melody | Same notes and phrasing |
| Lyrics | Same |
| Chords | Same progression unless you approve changes |
| Song structure | Same verse / pre / hook / drop sections |
| Production melodies | Replayed, upgraded, or re-sounded |
| Vocal identity | Same human vocal, tuned and processed |

If the demo is only a stereo bounce, tools like RipX can separate audio into vocal/instrument/percussion parts and allow pitch/key/tempo editing at a note level, but I would treat that as a **guide extraction step**, not the final production source. citeturn792952view1

### 3. Rebuild the production

The producer recreates the track around the existing song:

- New drums, bass, synths, FX, risers, fills.
- Same hooks and melodic ideas.
- Cleaner sound design.
- DJ-friendly structure: intro, build, drop, breakdown, second drop, outro.
- Proper kick/sub relationship and sidechain.
- Club-ready rough master.

For pitching DJs, I’d ask for:

| Deliverable | Purpose |
|---|---|
| Full extended mix | DJ playable |
| 2–3 minute pitch edit | Quick review |
| Acapella | Remix / DJ interest |
| Instrumental | Pitch flexibility |
| Stems | Future mix/remix control |
| WAV + 320 MP3 | Pro delivery |
| BPM/key notes | DJ usability |

## Rights setup

Use a **producer agreement before sending files**. The contract should include:

- NDA / confidentiality.
- No public posting.
- No portfolio use without written approval.
- No upload to AI training systems or public generative services.
- Work-made-for-hire language.
- Assignment fallback: “to the extent any contribution is not work made for hire, producer assigns all rights to you.”
- No publishing split unless explicitly agreed.
- No master royalty unless explicitly agreed.
- Producer fee is a buyout unless you approve otherwise.
- All samples, loops, presets, and vocals must be royalty-cleared.
- You own the final master, stems, session files, and derivative versions.

This matters because sound recordings can have authorship contributions from performers and producers, according to the U.S. Copyright Office. citeturn122997search4 U.S. copyright law treats a valid work made for hire as owned by the hiring party unless a signed writing says otherwise, so the written agreement is central. citeturn122997search9

## What to avoid

Avoid these for this specific song:

- Uploading the full unreleased track to Suno/Udio-style public generative platforms.
- Remix contests.
- “AI mastering” or “AI remix” services without reading upload/training/privacy terms.
- Any tool that says it can use uploads to improve models.
- Any platform that makes generations public by default.
- Any producer who wants a default publishing split for merely polishing the demo.

## Practical recommendation

The cleanest path:

1. Get the best possible dry vocal, even a quick re-record if the current vocal is noisy or distorted.
2. Hire one producer/mix engineer under NDA + buyout agreement.
3. Provide: rough demo, dry vocal, lyrics, BPM/key if known, 2–3 reference tracks, and notes saying “preserve topline, chords, production melodies, and vocal identity.”
4. Have them rebuild the instrumental, tune/process the vocal, and deliver a DJ pitch pack.

There is no consumer “drop in rough demo, get private polished hit demo, retain all rights” tool I’d trust with an unreleased human song today. The reliable version is a controlled production workflow with assistive tools and written rights protection.

---

## User

what i want is a workflow we can automate. I have a ton of demos that are pretty crude but the core melody is there and then lyrics are there. we should be able to voice clone agianst the studio version of my voice since i have tons of studio quality acapaellas and then just drop in demos, stem seperate them, turn the vocal into a produced vocal, and remux. thats mvp. later we can put each instrumetnal stem through a suno or soemthin and then remux/remix them together and master them quick and get a produced demo thats good enough to pitch. this would save writers like me days of work to get to a demo and get cuts much faster. so thats real revenue in my pocket.

i want to explore how to do that. we can host our models if needed to avoid watermarker or rights conflicts

---

## Assistant

Mr. White, the automatable MVP is plausible: demo in, stem separation, vocal conversion/tuning/processing, remux, quick master, then later generated instrumental rebuilds. I’ll frame it as a rights-clean product architecture with local/hosted model choices and licensing constraints.

---

## Assistant

The key technical choice is singing voice conversion: the crude vocal supplies timing, melody, phrasing, lyrics, and emotion while your studio acapella model supplies polished timbre.

---

## Assistant

Mr. White, yes. This is buildable. The right approach is a **private demo-production engine**, starting with vocal reconstruction + automated mix polish, then moving into controlled instrumental regeneration.

The MVP should avoid “full Suno replacement” scope. The first useful product is:

> **Upload crude demo → preserve lyrics/topline/structure → replace rough vocal with your cloned polished vocal → clean/remix stems → quick master → export DJ-pitchable demo.**

That alone would save meaningful writer-demo time.

---

## 1. Core product concept

### Input

- Crude demo: phone memo, rough Logic bounce, piano/vocal, Ableton rough, etc.
- Optional lyric sheet.
- Optional notes: genre, target DJ lane, BPM/key, references.
- Your pre-trained studio-quality voice model from clean acapellas.

### Output

- Polished pitch demo.
- Full mix WAV.
- Short pitch edit.
- Acapella.
- Instrumental.
- Stems.
- Metadata: BPM, key, lyric timestamps, model versions.

---

## 2. MVP pipeline

```text
demo.wav
  → ingest / normalize
  → detect BPM, key, structure
  → stem separation
  → isolate rough vocal
  → transcribe lyrics + align timing
  → extract vocal melody / F0
  → pitch-correct melody
  → convert/synthesize into your studio voice
  → vocal processing chain
  → clean/remix instrumental stems
  → quick mix/master
  → quality checks
  → export pitch pack
```

This should be self-hosted. Suno’s current terms grant Suno a broad license over uploaded submissions/content and voice-model-related rights, including use for service and AI/ML model improvement, which conflicts with your “private unreleased songs, no rights leakage” requirement. citeturn908487view0

---

## 3. Voice model strategy

There are two different tasks here:

| Task | What it does | MVP role |
|---|---:|---:|
| **Voice conversion / SVC** | Converts a sung guide vocal into your voice timbre while keeping pitch/timing | Best MVP path |
| **Singing voice synthesis** | Generates a new vocal from lyrics + notes/MIDI + your voice model | Better long-term path |

### MVP: singing voice conversion

Use the rough demo vocal as the performance guide:

1. Separate vocal from the demo.
2. Clean it.
3. Extract F0/melody.
4. Correct pitch/timing.
5. Convert timbre to your trained studio voice.
6. Process like a produced vocal.

RVC is a practical prototype candidate because it is MIT-licensed and designed for voice conversion; its WebUI repo says it can train usable voice models from relatively small clean datasets, with a recommendation of at least about 10 minutes of low-noise voice data. citeturn800412view0 Seed-VC is also relevant because it supports zero-shot singing voice conversion and custom fine-tuning, though its repo is GPL-3.0, so it needs license review before embedding in a commercial product. citeturn373528view4

### Better version: lyric + melody → new vocal

For higher quality, the system should eventually stop relying on the bad demo vocal’s audio quality. It should use the demo vocal only to extract:

- Lyrics.
- Timing.
- Melody/F0.
- Vibrato/slides.
- Phrasing.

Then it should synthesize a clean vocal in your voice from those controls.

That is the version that starts to feel like: “I dropped in a rough idea and got back a real demo.”

---

## 4. Reference voice dataset

Use your studio acapellas to train the private voice model.

### Dataset requirements

| Item | Target |
|---|---:|
| Clean dry acapella | Yes |
| Reverb/delay printed | Avoid where possible |
| Sample rate | 44.1k or 48k WAV |
| Total useful voice | 30–120 minutes ideal |
| Segments | 5–20 second phrases |
| Metadata | song, BPM, key, emotion, range |
| Exclusions | doubles, harmonies, stacks, heavy FX unless tagged |

### Build two models

| Model | Purpose |
|---|---|
| **Lead vocal model** | Main topline reconstruction |
| **Harmony/adlib model** | Later automatic doubles, octaves, stacks, BGs |

Do not train on released third-party vocals, reference songs, DJ cuts, or co-writer vocals without explicit rights.

---

## 5. Stem separation

For MVP, use Demucs or UVR-style separation.

Demucs is a strong baseline: the repo describes it as a music source separation model that separates drums, bass, vocals, and other stems, with Hybrid Transformer Demucs v4 reaching strong MUSDB-HQ separation metrics; the repo is MIT-licensed. citeturn373528view0turn530617view0

### MVP stem split

```text
demo.wav
  → vocals.wav
  → drums.wav
  → bass.wav
  → other.wav
```

Then:

- Replace `vocals.wav` with your reconstructed vocal.
- Keep/rebalance the instrumental stems.
- Apply EQ, compression, stereo widening, saturation, and limiting.
- Optionally replace drums/bass with cleaner synthesized versions.

This creates a fast “pitchable” output without needing full instrumental generation.

---

## 6. Melody, lyrics, and timing extraction

Use multiple extractors and cross-check them.

| Need | Candidate |
|---|---|
| Lyrics transcription | Whisper |
| Melody/F0 | RMVPE, CREPE, Basic Pitch |
| Audio-to-MIDI | Basic Pitch |
| BPM/key/beat grid | librosa / Essentia |
| Structure | novelty curves + heuristics + optional LLM labels |

Whisper’s code and model weights are MIT-licensed, making it suitable for local transcription workflows. citeturn324055search4 Basic Pitch is Apache-2.0 licensed and converts compatible audio into MIDI with pitch bends; Spotify notes it works best on one instrument at a time, so it should be used on isolated vocal/lead stems rather than a full mix. citeturn373528view1

### Key technical rule

The system should preserve the topline by converting the rough vocal into a control track:

```text
vocal audio → notes + pitch bends + lyric timings + expressive curves
```

Then pitch correction becomes controlled:

- Snap sustained notes toward scale tones.
- Preserve slides, scoops, and vibrato.
- Avoid flattening expressive pitch movement.
- Keep formants stable.
- Flag low-confidence lines for rerender.

---

## 7. Vocal production chain

After voice conversion/synthesis, process the vocal with a fixed style preset per genre.

### Default vocal chain

```text
de-noise / de-click
  → pitch correction
  → timing correction
  → de-esser
  → EQ
  → compression
  → saturation
  → parallel compression
  → doubler / widener
  → delay
  → reverb
  → bus compression
```

Spotify’s Pedalboard is useful here because it is a Python audio library that can read/write audio, apply effects, and load VST3/AU plugins programmatically. citeturn823578search0turn823578search16 That lets you automate “producer vocal chains” using local licensed plugins.

Recommended implementation:

```text
vocal_clean.wav
  → pedalboard chain
  → lead_wet.wav
  → lead_dry_tuned.wav
  → doubles.wav
  → adlibs.wav
```

For the first version, use deterministic vocal chains rather than generative audio for vocal FX. It will sound more reliable and creates fewer rights questions.

---

## 8. Instrumental MVP

Your proposed “remux” MVP is valid, with one caveat: if the original instrumental is very crude, stem separation plus processing will still sound like enhanced rough stems. The MVP should improve the instrumental in three controlled ways:

### A. Clean/rebalance stems

- EQ mud out of the `other` stem.
- Compress drums.
- Add sub reinforcement to bass.
- Add stereo width to pads/leads.
- Add tasteful bus glue.
- Sidechain vocal and bass/kick.

### B. Replace drums deterministically

This is one of the highest-leverage upgrades.

```text
drums.wav → onset detection → kick/snare/hat pattern → modern sample kit
```

You get cleaner impact without changing the song.

### C. Re-sound obvious MIDI parts

Use Basic Pitch on isolated lead/piano/synth stems, then assign better sounds.

```text
lead_stem.wav → MIDI → serum/pigments/piano/pad preset → rendered stem
```

This preserves “same production melodies” while making the track sound produced.

---

## 9. Instrumental V2: generative stem upgrade

Later, add generative models for arrangement polish.

### Recommended path

Do this:

```text
stem → symbolic controls → generated/replayed stem → align to original
```

Rather than this:

```text
stem → black-box full regeneration → hope it preserves the song
```

### Candidate models

| Model/tool | Use case | Rights posture |
|---|---|---|
| **ACE-Step 1.5** | Local music generation, repainting, cover generation, vocal-to-BGM, metadata control | Repo lists MIT license; verify specific checkpoint terms |
| **ACE-Step v1** | Text/music generation and downstream voice/music tools | Hugging Face card lists Apache-2.0 |
| **Stable Audio 3.0** | Open-weight audio generation, editing, enterprise-safe route | Stability says it is trained on fully licensed data; open weights available for some models |
| **YuE** | Long-form lyrics-to-song generation | Good research/experimentation candidate |

ACE-Step 1.5 is especially relevant because its repo claims local generation, reference audio input, cover generation, repaint/editing, track separation, vocal-to-BGM, BPM/key control, and a REST API mode; the repo lists an MIT license. citeturn910353view0 ACE-Step v1’s Hugging Face model card lists Apache-2.0 and describes use cases including original music generation, remixing, style transfer, and downstream voice cloning/music production tools. citeturn910353view2 Stability says Stable Audio 3.0 is trained on fully licensed data and offers open weights for some models, with enterprise licensing/indemnification available. citeturn263157view0 YuE is relevant for longer-form song generation and lyrics-to-song workflows; its repo says it can generate full songs with vocals and accompaniment and was updated to Apache 2.0. citeturn263157view2

### V2 instrument workflow

```text
drums.wav
  → extract groove
  → generate/rebuild modern drum stem
  → align transients to original

bass.wav
  → extract pitch/rhythm
  → synthesize clean bass stem
  → sidechain to kick

other.wav
  → detect chords/leads/hooks
  → generate pads/leads/FX layers
  → keep only parts that match original structure

full demo
  → optional generative “ear candy” pass
  → fills, risers, transitions, impacts
```

---

## 10. Product architecture

### Services

| Service | Responsibility |
|---|---|
| **Ingest service** | Upload, file validation, waveform preview |
| **Analysis worker** | BPM/key/structure/lyrics/melody |
| **Separation worker** | Demucs/UVR stem split |
| **Voice worker** | SVC / singing synthesis |
| **Vocal FX worker** | Tuning, EQ, compression, ambience |
| **Instrument worker** | Stem cleanup, drum replacement, MIDI resound |
| **Mix worker** | Gain staging, bus processing, master |
| **QC worker** | Similarity, lyric accuracy, clipping, loudness |
| **Review UI** | A/B versions, approve/rerun sections |
| **Provenance ledger** | Inputs, model versions, prompts, licenses |

### Stack

```text
Frontend: Next.js
Backend: FastAPI
Queue/orchestration: Temporal, Celery, or Modal-style job workers
Storage: encrypted S3/R2/local NAS
DB: Postgres
Audio: ffmpeg, librosa, pedalboard
ML: PyTorch workers on GPU boxes
Model registry: local Hugging Face cache / MLflow
```

### GPU setup

For a serious local prototype:

| Use | Hardware |
|---|---|
| MVP voice/stems | RTX 4090-class machine |
| Batch demo processing | 1–4 GPU worker box |
| ACE-Step / generative V2 | 4090/A6000/A100 depending model size |
| Long-term SaaS | autoscaled GPU workers + strict data isolation |

ACE-Step 1.5 claims local operation with under 4GB VRAM for some paths, while XL variants require more VRAM; use this as a candidate for early local testing, then benchmark on your actual song material. citeturn910353view0

---

## 11. Quality gates

Automated generation needs scoring, otherwise you get random artifacts.

| Gate | Metric |
|---|---|
| Lyric accuracy | ASR word error rate against provided lyrics |
| Melody preservation | note/F0 distance from original topline |
| Timing preservation | phrase onset drift |
| Voice similarity | speaker embedding similarity to your reference model |
| Vocal quality | sibilance, clipping, noise, harshness |
| Instrumental preservation | chord/melody similarity |
| Mix quality | LUFS, true peak, crest factor, spectral balance |
| Rights/provenance | model license + input ownership logged |

For pitch demos, I would optimize for:

1. Hook intelligibility.
2. Vocal identity.
3. Melody preservation.
4. Modern low end/drums.
5. Fast render time.

---

## 12. Rights and privacy rules

### Internal platform rules

- No uploads to public AI music platforms.
- No model training on customer/writer uploads unless separately opted in.
- No cross-user voice models.
- Encrypt all files at rest.
- Delete raw uploads by default after a configurable period.
- Keep a provenance log for each output.
- Store every model license and version used.
- Add “AI-assisted demo, not final master” metadata internally.

### Copyright posture

Your human-written lyrics, melody, and composition remain the valuable copyrightable core. U.S. Copyright Office guidance says generative AI outputs can be protected where a human author determines sufficient expressive elements, including when a human-authored work remains perceptible or when the human makes creative arrangements/modifications; mere prompting alone is insufficient. citeturn634340search0

That means your product should frame itself as:

> **AI-assisted demo production from human-authored songs.**

That is stronger than claiming the system “writes” the song.

### Voice rights

For your own voice, the risk is mainly platform/tool terms and data security. For anyone else’s voice, you need written consent. California Civil Code § 3344 covers unauthorized commercial use of another person’s name, voice, signature, photograph, or likeness, and California has expanded digital-replica protections in the entertainment context. citeturn926807search12turn926807search6

For a product serving other writers, require:

```text
I own or control the uploaded song, recording, lyrics, and voice data.
I authorize creation of a private voice model for my own use.
I do not authorize training global/shared models unless I separately opt in.
```

---

## 13. Build order

### Phase 1 — Vocal polish MVP

Goal: make crude demos pitchable while preserving the song.

- Upload demo.
- Stem split.
- Extract vocal melody/lyrics.
- Convert vocal to your studio voice.
- Apply vocal chain.
- Remux with cleaned stems.
- Quick master.
- Export pitch pack.

This is the first revenue-relevant version.

### Phase 2 — Drum/bass replacement

Goal: make rough demos feel produced without changing writing.

- Extract drum groove.
- Replace kick/snare/hat.
- Extract bass rhythm/pitch.
- Re-synthesize bass.
- Improve sidechain and low end.

### Phase 3 — MIDI resound

Goal: preserve production melodies while upgrading sounds.

- Extract lead/chord MIDI.
- Assign genre presets.
- Render cleaner synths/keys/pads.
- Add fills, risers, and FX.

### Phase 4 — Generative stem regeneration

Goal: “Suno-like polish” under your control.

- Use ACE-Step/Stable Audio/YuE-style local generation.
- Condition on BPM/key/chords/melody/reference.
- Generate alternate stems.
- Rank outputs by similarity and quality.
- Human approve/rerun sections.

---

## 14. MVP spec in one sentence

Build a self-hosted system that treats the crude demo as the **source of truth for song, lyric, melody, timing, and structure**, uses your private studio acapellas to create a **controlled singing voice model**, then reconstructs the vocal and upgrades the backing with deterministic production tools before adding generative stem replacement later.

The first technical artifact should be a build spec with model choices, job graph, API endpoints, storage rules, and a benchmark plan using 10 of your real demos.

---

## Assistant

Mr. White, I’ll frame this as an automated AI demo-producer workflow: preserve the human topline and arrangement intent, then replace rough or rights-unsafe audio with pitchable, controlled production.

---

## Assistant

The core abstraction is a control sketch: extract lyrics, timing, chords, groove, and performance intent, then re-render vocals and instruments as owned studio-quality parts.

---

## Assistant

Mr. White, I understand the use case now.

You are describing **an AI demo producer**, with two primary jobs:

1. **Recover value from hundreds of crude self-produced demos** where the song, topline, lyric, groove, and production idea already exist.
2. **Re-bed toplines safely** when the original writing bed is a third-party or unreleased DJ instrumental, so you can pitch the topline without leaking or relying on that master. fileciteturn0file0

The key product idea is:

> **Convert a crude demo into an “intent map,” then re-render that intent as a studio-quality pitch demo.**

That means the system should preserve *what you played and wrote*, while replacing the bad recording, bad tones, bad vocal capture, weak mix, and rough sound design.

---

# The right architecture

## 1. Input types

The product should support three modes.

| Mode | Input | Output |
|---|---|---|
| **Self-demo upgrade** | Your crude MP3 demo | Same song, better vocal, better drums, better guitars, better bass, better mix |
| **Topline re-bed** | Vocal/topline over another producer’s instrumental | Your vocal/topline over a new original instrumental |
| **Loop/beat decontamination** | Demo built from loops, sample packs, or borrowed rough beds | Similar vibe, newly rendered original bed |

This distinction matters. The self-demo mode can preserve more of the instrumental. The topline re-bed mode should aggressively discard the third-party master and rebuild around the topline.

---

# MVP workflow

## The MVP should do this

```text
crude_demo.mp3
  → stem separation
  → vocal/topline extraction
  → lyric + melody + timing extraction
  → private voice-model vocal reconstruction
  → drum groove extraction and replacement
  → bass extraction and replacement
  → chord/rhythm extraction for guitar/keys
  → guitar/keys re-rendering
  → automated mix + master
  → export pitch pack
```

The important shift is that the system should avoid treating the separated stems as final audio. It should treat them as **guide performances**.

---

# The “intent layer”

The core intermediate artifact should be a structured representation of the song.

Example:

```json
{
  "bpm": 126,
  "key": "F minor",
  "sections": [
    {"name": "intro", "start": 0.0, "end": 16.0},
    {"name": "verse", "start": 16.0, "end": 48.0},
    {"name": "pre", "start": 48.0, "end": 64.0},
    {"name": "hook", "start": 64.0, "end": 96.0}
  ],
  "vocal": {
    "lyrics": "...",
    "melody_notes": "...",
    "phrase_timing": "...",
    "vibrato": "...",
    "dynamics": "..."
  },
  "drums": {
    "kick_pattern": "...",
    "snare_pattern": "...",
    "hat_pattern": "...",
    "claps": "...",
    "velocity_groove": "..."
  },
  "bass": {
    "notes": "...",
    "slides": "...",
    "rhythm": "...",
    "layering": ["sub", "synth_bass", "bass_guitar"]
  },
  "guitars": {
    "chords": "...",
    "rhythm": "...",
    "voicings": "...",
    "lead_riffs": "..."
  },
  "keys_synths": {
    "chords": "...",
    "lead_melodies": "...",
    "automation_shape": "..."
  }
}
```

Once you have that, the crude MP3 becomes a guide. The output gets rendered from cleaner sources.

---

# Stem separation layer

Use stem separation as the first extraction step.

Demucs is the obvious open baseline. It separates vocals, drums, bass, and other accompaniment, and the current v4 Hybrid Transformer Demucs is specifically described as separating drums, bass, vocals, and other stems from songs. citeturn602262view0

Initial split:

```text
demo.mp3
  → vocal.wav
  → drums.wav
  → bass.wav
  → other.wav
```

For your use case, I would also test the experimental 6-source models that split guitar and piano, because the product value rises sharply when guitar/keys are isolated more cleanly. Demucs’ repo notes an experimental 6-source model adding guitar and piano. citeturn602262view0

---

# Vocal reconstruction

This is the most important MVP component.

## Vocal pipeline

```text
rough_vocal.wav
  → denoise / dereverb
  → transcribe lyrics
  → align lyrics to syllables
  → extract melody / F0
  → correct pitch and timing
  → render/convert into your studio voice model
  → apply your vocal chain
  → create lead, doubles, harmonies, adlibs if detected
```

For the first version, use **singing voice conversion** rather than full lyrics-to-singing synthesis. The rough vocal already contains the performance: phrasing, melody, emphasis, vowel shapes, rhythm, emotional intention.

RVC is a practical prototype candidate because it is a voice-conversion framework and its repo says it can train a usable model with ten minutes or less of voice data; it also lists an MIT license. citeturn602262view1 Seed-VC is also worth testing because it supports zero-shot singing voice conversion, but its GPL-3.0 licensing needs commercial review before embedding it in a product. citeturn876890search2turn876890search16

## Your studio acapellas become the voice asset

Train a private “Tim studio lead vocal” model from:

- Dry studio acapellas.
- Clean comped lead vocals.
- Separate harmony/adlib takes.
- Range-tagged phrases.
- Aggressive vocal takes, soft takes, falsetto, belt, spoken phrases.

Build at least three voice profiles:

| Model | Purpose |
|---|---|
| **Lead vocal** | Main topline |
| **Harmony/double** | Backgrounds, stacks, octave doubles |
| **Adlib/texture** | Riffs, shouts, emotional phrases |

The goal is that a hungover apartment vocal becomes a clean studio-style lead that still sounds like you.

---

# Lyric and melody extraction

Use multiple tools and confidence scoring.

| Task | Tool type |
|---|---|
| Lyrics | Whisper or equivalent ASR |
| Vocal melody / F0 | RMVPE, CREPE, pYIN |
| Note/MIDI extraction | Basic Pitch |
| Timing alignment | forced alignment + syllable timing |
| Section detection | beat grid + novelty curves + heuristics |

Whisper is an MIT-licensed speech recognition model from OpenAI. citeturn157298search3 Basic Pitch can convert compatible audio into MIDI with pitch bends and works best on one instrument at a time, making it useful after stem separation. citeturn602262view2

For pitch demos, the vocal quality gate should be:

```text
Does the hook melody survive?
Are the lyrics intelligible?
Does the voice sound like you?
Is the timing good enough that a DJ hears the cut?
```

That is the target, rather than final-release vocal perfection.

---

# Drum replacement

This should be deterministic in the MVP.

Your crude drum beat already says:

- Kick locations.
- Snare/clap locations.
- Hat rhythm.
- Groove/swing.
- Drop energy.
- Fill locations.

Pipeline:

```text
drums.wav
  → onset detection
  → classify kick/snare/clap/hat/tom
  → create MIDI drum map
  → quantize lightly
  → preserve swing/velocity
  → trigger modern drum samples
  → add room/parallel comp/saturation
```

This is a high-leverage win. A crude beat can become a professional-sounding drum stem without generative music. You already know the pattern. The machine only needs to replace the sonic execution.

---

# Bass replacement

Your bass example is exactly how the product should think.

```text
bass.wav
  → monophonic pitch/rhythm extraction
  → clean MIDI
  → render three layers:
       1. sub bass down center
       2. bass guitar down center
       3. Juno/Juno-style wide synth bass
  → sidechain all layers to kick
  → bus compress/saturate
```

The system can have genre presets:

| Preset | Bass render |
|---|---|
| Dance pop | Sub + wide synth + light bass guitar |
| Progressive house | Sub + pluck bass + sidechain pump |
| Pop rock demo | Bass guitar + subtle sub |
| Indie electronic | Juno-style layer + live bass transient |

This is much easier than full generative audio because bass is often monophonic and structurally clear.

---

# Guitar replacement

This is the hardest stem.

A crude strummed guitar inside a mixed MP3 is difficult because the guitar often sits inside the “other” stem with keys, pads, reverbs, and vocal bleed. The MVP should handle guitar through **chord/rhythm extraction and re-rendering**, rather than direct audio enhancement.

Pipeline:

```text
other.wav or guitar.wav
  → detect chord progression
  → detect strumming rhythm
  → detect lead riffs if isolated
  → render with guitar engine / sample library / modeled guitar
  → apply amp, cab, pedals, stereo doubles
```

For your own library, the product can get much better if you create a proprietary guitar dataset:

```text
clean studio guitar takes
  → artificially degrade them into apartment-demo / MP3 / phone-mic versions
  → train model: bad guide guitar → clean studio guitar
```

That gives you paired training data without rights problems. It also becomes a moat because generic music models will struggle to preserve exact strum feel and voicing.

---

# Keys, synths, hooks, and riffs

For keys and synth melodies:

```text
stem
  → MIDI extraction
  → clean notes
  → choose sound preset
  → render through VST/synth engine
  → apply automation, filters, delays, width
```

Basic Pitch is relevant here because it outputs MIDI and pitch bends from audio, especially on isolated instruments. citeturn602262view2

For MVP, keep this deterministic:

- If it sounds like piano, render piano.
- If it sounds like pad, render pad.
- If it sounds like synth lead, render lead synth.
- If confidence is low, preserve the original stem quietly under the recreated part.

---

# Automated vocal and mix processing

Use a programmable audio chain.

Spotify’s Pedalboard is useful because it can read/write audio, apply effects, and load VST3 and Audio Unit plugins programmatically. citeturn602262view3

Example render chain:

```text
lead_vocal_dry.wav
  → pitch/timing correction
  → de-esser
  → EQ
  → compression
  → saturation
  → parallel compression
  → slap delay
  → tempo delay
  → plate/room reverb
  → vocal bus limiting
```

Master chain:

```text
mix.wav
  → corrective EQ
  → bus compression
  → saturation
  → stereo control
  → limiter
  → LUFS target for pitch demo
```

The MVP should generate:

- Full mix WAV.
- Full mix MP3.
- Acapella.
- Instrumental.
- Stems.
- 60–90 second pitch edit.
- BPM/key metadata.

---

# The rights-safe “topline re-bed” mode

This mode matters for the DJ-instrumental scenario.

If you write a topline over someone else’s unreleased instrumental, the system should:

```text
bounce_with_third_party_track.mp3
  → isolate your vocal
  → extract your lyric/melody/timing
  → discard the third-party instrumental
  → create a new original bed from your topline + neutral style controls
```

Use only:

- Your vocal.
- Your melody.
- Your lyrics.
- BPM/key if needed.
- Broad genre direction.
- Optional original chords you provide.

Avoid using the third-party instrumental’s riffs, drops, hooks, sound design, or arrangement details as conditioning material. Under U.S. law, a derivative work includes a work based on a preexisting work, including a musical arrangement or another recasting/adaptation. citeturn851659search1

The product should include a “contaminated reference” flag:

```text
Was the input bed owned/cleared by user?
  yes → preserve instrumental intent
  no  → extract vocal only, discard instrumental, rebuild original bed
```

That is how you solve the “I wrote a great topline to an unreleased DJ master, now I need a clean pitch demo” problem.

---

# Where generative models fit

Use generative audio later, after the deterministic pipeline works.

## MVP

Use generative tools lightly:

- Ear candy.
- Risers.
- Impacts.
- Fills.
- Ambience.
- Optional alternate intro/outro textures.

## V2

Use generative models for controlled stem recreation:

```text
guitar intent + audio guide → clean guitar stem
bass intent + genre → clean bass stem
drum groove + genre → better drum stem
topline + style → original instrumental bed
```

ACE-Step 1.5 is worth testing for local music generation; its repo currently lists MIT license, though checkpoint/data terms still need review. citeturn602262view4 Stable Audio 3.0 is also relevant because Stability says the models are trained on fully licensed data, include open-weight models, and offer enterprise licensing/indemnification for larger organizations. citeturn602262view5

For your rights posture, I would prioritize:

1. Self-hosted models.
2. Models with clear commercial terms.
3. Models trained on licensed/owned/CC material.
4. No third-party upload by default.
5. No watermark circumvention; choose tools that license clean, private outputs from the start.

Suno is a poor fit for this specific workflow because its current terms grant broad rights to uploaded submissions/content and voice-model-related rights for service improvement, AI/ML model improvement, sublicensing, marketing, and related uses. citeturn630113view0

---

# Product design

## User flow

```text
1. Upload crude MP3
2. Choose mode:
   - Upgrade my own demo
   - Re-bed my topline
   - Replace loop/sample bed
3. Optional:
   - provide lyrics
   - provide BPM/key
   - provide genre/reference words
   - mark third-party material
4. System creates 3 renders:
   - clean conservative
   - more produced
   - DJ-pitch version
5. User A/B reviews
6. Export pitch pack
```

## Review controls

The UI should expose a few producer-level controls:

| Control | What it changes |
|---|---|
| Vocal polish | pitch/timing intensity, dryness, brightness |
| Production fidelity | how aggressively stems get replaced |
| Preserve demo | how much original audio remains under recreated parts |
| Dance sidechain | sidechain depth |
| Guitar realism | sample/model choice |
| Bass stack | sub/synth/live-bass balance |
| Master loudness | pitch-demo loudness |

This avoids making the user become a mix engineer for every demo.

---

# What the first prototype should automate

Build a prototype around 10–20 of your demos.

## v0.1: Vocal + drums + mix

This is the fastest useful version.

```text
MP3
  → split stems
  → reconstruct vocal in your voice
  → replace drums
  → rebalance bass/other
  → quick master
```

This will already make many demos pitchable.

## v0.2: Bass replacement

Add:

```text
bass stem → MIDI/pitch extraction → sub + bass guitar + Juno-style render
```

This makes the output feel much more produced.

## v0.3: Guitar/keys recreation

Add:

```text
other stem → chord/rhythm/riff extraction → guitar/keys render
```

This is the point where the product starts feeling like a real AI demo producer.

## v0.4: Topline re-bed mode

Add:

```text
third-party instrumental input
  → vocal extraction only
  → new original instrumental bed
  → pitch demo export
```

That unlocks the DJ-pitch workflow directly.

---

# The technical build stack

| Layer | Candidate tools |
|---|---|
| Stem separation | Demucs / MDX / UVR-style models |
| Lyrics | Whisper |
| Vocal F0 | RMVPE / CREPE / pYIN |
| Audio-to-MIDI | Basic Pitch |
| Voice conversion | RVC prototype, licensed/private SVC model for production |
| Effects | Pedalboard + licensed VST3/AU chains |
| Instrument rendering | Kontakt, Pianoteq, modeled guitars, bass synths, drum samplers |
| Generative audio | Stable Audio 3.0, ACE-Step, custom fine-tunes |
| Orchestration | Python + FastAPI + queue workers |
| Storage | encrypted object storage |
| Review UI | waveform/stem player + render variants |

---

# Commercial/legal guardrails

For your own internal use:

- Store all source files privately.
- Self-host wherever possible.
- Keep model/version logs.
- Keep proof that the underlying song was human-written by you.
- Delete third-party reference beds after extracting your own vocal/topline.
- Never train global models on songwriter/customer uploads by default.

For a product used by other writers:

- Require voice consent.
- Require upload ownership/authorization.
- Separate each user’s voice model.
- No cross-user training without explicit opt-in.
- No public gallery.
- No default “community remix” feature.
- No training on DJ masters or label instrumentals.
- Keep a provenance report per render.

California has specific entertainment-focused digital replica protections requiring contracts to specify AI-generated uses of a performer’s voice or likeness, so any third-party voice cloning feature needs explicit permission and clear contracting. citeturn938982view2

---

# The actual MVP thesis

Build the first version as:

> **A batch AI demo restorer that turns crude songwriter MP3s into DJ-pitchable productions by extracting the song’s intent, reconstructing the vocal with a private studio voice model, replacing drums/bass/guitar/keys with clean rendered parts, and exporting a clean pitch pack.**

That is a real product. The key moat is the **intent extraction and re-rendering layer**, not generic music generation. Generic models make new music. Your product needs to preserve the song that already exists and make it sound like a competent demo producer spent a day on it.
