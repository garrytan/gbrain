# Visual Grader Instructions

Grading instructions for an eval run that produced device/web screenshots. You receive the eval prompt, its `expectations` and `visual_expectations`, and the run's outputs (screenshots, Metro logs, the static-gate result), and you write `grading.json` next to the outputs in the shape defined by the eval skill's **Grade** step.

Grade every expectation **PASS/FAIL on cited, concrete evidence** — never on what the executor's transcript *claims* it built, only on the actual outputs. Quote or name the evidence for each verdict. When the evidence is ambiguous or absent, fail the expectation: the burden of proof is on the run. The sections below add the screenshot-specific process on top of that.

## Extra inputs

- `outputs/<platform>.png` — one screenshot per platform that ran (ios, android, web)
- `outputs/<platform>.metro.log` — the Metro/dev-server log for that platform
- The static gate output (`[PASS]/[FAIL]` lines from `check-static.sh`)

## Process additions

1. **Read every screenshot with the Read tool.** Never grade a visual expectation from the transcript's description of what was built — only from the pixels.

2. **Check failure signatures first**, on every screenshot, regardless of the listed expectations:
   - A red error screen / redbox, or Expo Go's "Something went wrong" page
   - The Expo Go home/project-list screen (the app never opened)
   - A blank white or black screen (bundle loaded but nothing rendered)
   - A system permission dialog or Expo Go first-launch prompt covering the app
   If any of these appear, every visual expectation for that platform fails, with the signature as evidence. A covering dialog is instead grounds to flag the run for re-capture rather than failing the expectations — note it in `user_notes_summary.needs_review`.

3. **Cross-check with the Metro log.** Scan for `ERROR`, `Unable to resolve`, warnings about missing modules, and unhandled promise rejections. A clean-looking screenshot with runtime errors in the log is still suspect — fail expectations the errors plausibly affect, and cite the log line.

4. **Grade each visual expectation per platform.** If `runtime.platforms` lists ios and android, an expectation like "a settings toggle is visible" must hold on **both** screenshots to pass. Evidence must name the screenshot file and describe what is actually visible, e.g. `ios.png: tab bar with Home/Explore tabs at bottom, toggle rendered in the first list row`.

5. **Static gate is upstream of visuals.** If `check-static.sh` failed and the device stage was skipped, mark all visual expectations failed with evidence pointing at the failed gate's log, and do not speculate about what would have rendered.

## Judgment calibration

- Platform-appropriate rendering differences (status bar, fonts, safe areas, scroll bar styling) are not failures.
- Be strict about the substance of the expectation: "tab bar with 3 tabs" means exactly three visible tabs, not "some tab bar exists".
- When a screenshot is ambiguous (mid-animation, partially loaded), say so in the evidence and fail the expectation — the burden of proof is on the run, and the harness can re-capture with a longer settle.

## Image-prompt cases (`reference_image` present in the eval case)

When the case has a `reference_image`, the prompt was "build an app matching this target screenshot," so grade **fidelity to the target** on top of the usual expectations:

1. **Read the target with the Read tool**, then read each generated screenshot, and compare them directly. Score `reference_match` (0–10): how faithfully the generated app reproduces the target's layout, component set, grouping, typography, spacing, and color treatment. Evidence must name both files and call out concrete matches and divergences, e.g. `ios.png vs target.png: same grouped list + header, but accent is blue not green and the avatar is square not round`.
2. **Apply `references/design-rubric.md`** for absolute quality, plus the code-quality dimension from the fixture's `git diff`; emit it as the `quality` block.
3. **Failure signatures still cap the score.** A redbox, blank screen, or wrong-screen capture means `reference_match` is 0 for that platform (evidence: the signature) — a crashed app reproduces nothing.
4. **Per platform, take the worst** when the case ran more than one platform (as in the rubric).
5. **Emit both blocks** in `grading.json` — `reference_match` and `quality` — alongside `expectations`; they're additive, so keep the `expectations`/`visual_expectations` grading as before.
   ```json
   "reference_match": {"score": 7, "max": 10, "evidence": "ios.png vs target.png: …"},
   "quality": {
     "dimensions": [{"name": "Layout & hierarchy", "score": 2, "max": 3, "evidence": "ios.png: …"}],
     "subtotal": 17, "max": 24, "summary": "one-line overall read"
   }
   ```
   `quality.subtotal` is the sum of dimension scores; `quality.max` is the sum of their maxes (24 for the built-ins).
