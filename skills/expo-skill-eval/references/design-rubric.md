# Design-quality rubric

Applied by the grader when scoring an app's visual quality — primarily for **image-prompt cases** (`reference_image`), and any time a quality grade is requested — on top of the pass/fail expectations, not instead of them. It answers "how *good* is this app?", scored from the captured screenshots and the implementation diff. Combine it with the failure-signature checks in `agents/visual-grader.md`: a redbox, blank screen, or wrong-screen capture caps every visual dimension at 0 for that platform regardless of intent.

## How to score

- **Judge visuals only from the pixels.** Read every screenshot with the Read tool; never infer a visual score from the transcript or from what the code *intended* to render.
- **Grade per platform, then take the worst.** If the case ran ios + android, a dimension's score is the lower of the two — unless the gap is a legitimate platform difference (see *Platform conventions*).
- Each dimension is **0–3**. The seven visual dimensions sum to a max of 21; with the code-quality dimension (also 0–3) the built-in rubric max is **24**.
- If a config/platform screenshot is **missing**, score only the platforms present, note the gap, and do **not** penalize for the absence.
- Cite concrete evidence per dimension, naming the file: e.g. `ios.png: 16px gutters, consistent 12px row spacing, large-title nav bar`.

### Score anchors (apply to every dimension)

- **0** — broken/absent: the dimension fails outright (overlapping or clipped text, unreadable contrast, no hierarchy, content off-screen).
- **1** — below bar: present but with clear problems a designer would reject.
- **2** — solid: clean and conventional, no notable problems; what a competent dev ships.
- **3** — polished: deliberate and refined; App-Store quality for this dimension.

## Visual dimensions

1. **Layout & hierarchy** — clear primary/secondary structure, alignment, logical grouping, balanced composition; nothing clipped or pushed off-screen.
2. **Spacing & density** — consistent padding/margins and vertical rhythm; not cramped, not sparse; respects safe areas, the notch, and the home indicator.
3. **Typography** — readable sizes, a sensible type scale (title vs body vs caption), consistent weights, no truncation/overflow/orphaned text.
4. **Color & contrast** — coherent, limited palette; sufficient text/background contrast for legibility; sensible light/dark handling.
5. **Platform conventions** — feels native to the platform it's shown on:
   - **iOS** — large titles / nav bars, grouped/inset lists, SF-style controls, standard tab bars, system spacing.
   - **Android** — Material surfaces, app bar, FAB where appropriate, ripple/elevation cues, Material controls.
   - **web** — sensible responsive layout, real cursor/hover affordances, no mobile-only chrome stranded on a wide canvas.
   A genuine platform difference (status bar, system fonts, control styling, safe areas) is **not** a defect; shipping an iOS-only pattern verbatim on Android **is**.
6. **Polish & states** — pixel alignment, crisp icons/images at the correct density, no stray debug text or placeholder lorem, sensible empty/loading states where the screen implies them.
7. **Visual accessibility** — tap targets look ≥44pt, text isn't clipped at default scale, contrast meets a rough WCAG-AA bar, interactive elements are visually distinguishable from static content.

## Code-quality dimension (0–3, from the diff)

Scored from the fixture's `git diff`, not the screenshots:

- Idiomatic Expo/RN: correct import paths and current APIs (e.g. the `@expo/ui` `Host` wrapper, Expo Router file conventions), no deprecated patterns.
- Reasonable structure: componentized where it helps, no copy-paste duplication, styles organized (not a wall of inline objects), TypeScript types where the template uses them.
- No dead code, leftover `console.log` noise, or unused scaffolding left from the template.
- Anchors: **0** broken/anti-patterns, **1** works but messy, **2** clean and idiomatic, **3** exemplary.

## Extra criteria

If the eval case lists `visual_expectations`, grade each as an **additional 0–3 dimension** with the same anchors, appended to the `dimensions` array and folded into `subtotal`/`max` (`max` grows by 3 per extra criterion). Cite evidence for each just like the built-ins.
