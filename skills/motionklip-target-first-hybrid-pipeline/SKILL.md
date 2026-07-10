---
name: motionklip-target-first-hybrid-pipeline
description: Default MotionKlip short-form pipeline — score≥98 + 3× verify BEFORE render; 720p download if 1080p≥1.5GB; user approval then upload. Use for YouTube/TikTok clip jobs targeting 5k/24h.
---

# MotionKlip Target-First Hybrid Pipeline (DEFAULT)

## When to use
Any request to make clips from a long YouTube/live source for MotionKlip YouTube or TikTok, aiming at reach targets (e.g. 5k views/24h, 3k@6h / 5k@20h).

This **replaces** the old “energy → render → fix later” default.

## Hard rules (fail-closed)
1. **Do not full-render** until: `final_score >= 98` AND **3× verify PASS**.
2. **Do not public upload** until user explicitly approves the render package.
3. **Never** re-burn subtitles from a burned output — rebuild from clean segment + SRT.
4. **Download:** prefer **720p**. If 1080p (or higher) selected size is **≥ 1.5 GB**, cancel that format and download **720p only** (no dual large downloads).
5. Manual TikTok post only (no auto-login retry after max attempts).
6. On mid-pipeline failure: **resume from checkpoint** only (skill `resume-media-pipeline-from-checkpoint`).

## Pipeline stages (order is mandatory)

```
download_720 → candidates → pre_score → full_score → verify_3x → render → approval → upload → track
```

### Stage 0 — Job scaffold
Create:
```
reports/<job_id>/
  raw/ segments/ srt/ outputs/ proofs/
  checkpoint.json
```
`checkpoint.json` fields: `stage`, `source_url`, `campaign_id`, `clips[]`, `scores{}`, `verify3x{}`, `approved`, `uploads{}`.

### Stage 1 — Download
```bash
# Try 720p first (default)
yt-dlp -f "bv*[height<=720]+ba/b[height<=720]" --merge-output-format mp4 \
  -o "downloads/<channel>/%(id)s_720.%(ext)s" "<URL>"
```
If user forces 1080p: probe expected size; if **≥ 1.5GB** → switch to 720p and log reason in checkpoint.

### Stage 2 — Candidate mine (no full vertical render)
- Energy / RMS peaks **and** chapters / hook windows (combined shortlist).
- Keep top **5–8** windows of **18–28s** (TikTok/Shorts sweet spot).
- Extract **clean segments only** (ffmpeg cut), not branded shorts yet.
- Save `raw/energy_candidates.json` with per-window RMS + rank.

### Stage 3 — Cheap pre-score (drop trash fast)
Reject without LLM if any true:
- duration outside 18–28s (unless campaign says otherwise)
- first 1s silence / black / no speech when speech expected
- pure music loop / ASR total hallucination risk high
Write `raw/pre_score.json`.

### Stage 4 — Combined rank: Energy RMS + Scorer ≥98 (MANDATORY BOTH)
**Never pick by energy alone. Never claim pass by score alone without energy context.**

1. **Energy layer:** normalize RMS across candidates → `energy_norm` in 0–100  
   `energy_norm = 100 * (rms - rms_min) / max(rms_max - rms_min, 1e-9)`
2. **Scorer layer:** campaign / default weights:

| Signal | Weight | Floor |
|---|---:|---:|
| first_second_hook | 35% | 65 |
| completion_potential | 25% | 55 |
| replay_loop_potential | 20% | 50 |
| comment_share_trigger | 10% | — |
| visual_motion_energy | 5% | — |
| campaign_compliance | 3% | — |
| caption_hashtag_fit | 2% | — |

- Duration bonus (short-form): 18–28s **+3**; >35s **−8**; <18s **−3**.
- Inject energy into scorer: set / blend `visual_motion_energy` from `energy_norm` (cap 100). Optional:  
  `combined = 0.70 * final_score + 0.30 * energy_norm` for **ranking only**.
3. **Hard gates (fail-closed):**
   - any scorer floor miss → reject  
   - `final_score < 98` → reject (no render)  
   - energy must be in **top half** of mined candidates **or** `energy_norm >= 50` (dead-quiet rejects even if LLM hypes it)
4. **Pick primary:** among gate-passers, highest `combined` (or highest `final_score` if ties).
5. Save `raw/scores.json` with `rms`, `energy_norm`, `final_score`, `combined`, `decision`.  
   **Do not invent scores** — if LLM scorer unavailable, mark `score_status=heuristic_only` and **do not claim 98**.

### Stage 5 — Verify 3× (on scoring + readiness, NOT 3× re-render)
All three must PASS:

| Pass | What |
|---|---|
| **A** | Recompute formula + floors from stored subscores; checksum duration |
| **B** | Independent adversarial check (second model/MoA or human checklist): “would you scroll past in 0.5s?” |
| **C** | Compliance: source approved for campaign, spoken-sync feasible, watermark asset exists, hashtag plan listed |

If any fail → back to Stage 2/4. **No render.**

### Stage 6 — Render (only PASS clips)
- `ark_editor.py` with **LiberationSans-Bold** font (never missing DejaVu).
- Watermark: campaign asset (MotionKlip normalized or Windah normalized per campaign).
- SRT: spoken-sync, max 2 lines, ≤22 chars/line, mid-lower above watermark safe zone.
- Output 720×1280; watermark width ≥18%, bottom margin ≥120px; write `WATERMARK_DEBUG_JSON`.
- Proof frames t≈1s, t≈mid, t≈end.
- Max package to user: **1 primary + 1 alt**.

### Stage 7 — Approval package (user)
Send Telegram review with:
- MP4 + 2–3 proof frames
- score + 3× verify summary
- title/caption draft
- gates: `subtitle_text_approved`, `ready_for_tiktok_upload`, `ready_for_public_upload` = false until explicit user OK

### Stage 8 — Upload (only after explicit approval)
- **YouTube:** `approve_and_upload_youtube.py` or `youtube_uploader.upload_video` with campaign hashtags in **mandatory order**.
- **TikTok:** manual post only; caption = hook first line + CTA + hashtags in **campaign order**.
- Record `video_id` / URL / privacy in `uploads_record.json`.

### Stage 9 — Track (target feedback)
Track views at ~6h / 20h / 24h when possible.
- Hit 5k/24h (or campaign gates) → log winning traits into learning notes.
- Miss → **do not inflate scores**; adjust candidate selection next run.

## Campaign hashtags (examples — always read live campaign JSON)
- Windah YT: `#windahbasudara #windahmk #motionklip #ezklip` (order fixed)
- GTID TikTok: `#gtid #gtidmkrep #motionklip #ezklip` + `@GTIDTECH` per campaign

## What “campaign + caption order” means (plain language)
Not a ban on TikTok. It means:
1. **Campaign** = which account rules apply (allowed sources, watermark, payout tags).
2. **Caption order** = hashtags must appear in the **exact sequence** the campaign file lists (payout/compliance).  
   Wrong order can still “post”, but may **fail MotionKlip claim/payout**.

If only a YouTube campaign exists for a source (e.g. Windah), TikTok is still allowed **after user approval**, but reuse the **same required hashtag order** from the closest campaign or ask user for the TikTok tag line.

## Checkpoint stages
`download` → `candidates` → `pre_score` → `full_score` → `verify_3x` → `render` → `approval` → `upload` → `track`

## Anti-patterns
- Energy-only pick then render 3 versions “to see”
- Score 98 from RMS alone
- Triple-render as fake “3× verify”
- Public upload without explicit user approve
- 1080p multi‑GB download when 720p enough
- Re-encoding burned subtitles to “fix_subs”

## Implementation checklist (agent)
- [ ] Job dir + checkpoint
- [ ] 720p download rule enforced
- [ ] ≥5 candidates, ≤8
- [ ] pre_score drop
- [ ] full_score with floors; no fake 98
- [ ] verify_3x A/B/C all PASS
- [ ] render only passers
- [ ] Telegram approval package
- [ ] upload only after explicit OK
- [ ] vault log + push if skill policy requires


## Contract
- Inputs: source URL, campaign id, optional MoA for scoring
- Outputs: checkpointed job with scores_combined + verify_3x; renders only after pass
- Fail closed: no fake score 98; energy AND score both required

## Output Format
- scores_combined.json, verify_3x.json, allowed_to_render[], approval package

## Anti-Patterns
- Energy-only pick
- Score-only pick ignoring dead energy
- Render before verify 3×
