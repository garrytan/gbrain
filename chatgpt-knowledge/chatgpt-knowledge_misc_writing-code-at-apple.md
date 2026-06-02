---
title: "Writing code at Apple"
type: essay
created: 2025-08-10
updated: 2025-08-10
source: chatgpt-export
topic: misc
message_count: 12
tags: [chatgpt, knowledge, misc]
---
**Topic:** [[chatgpt-knowledge/_topics/misc]]

# Writing code at Apple

> **Source:** ChatGPT conversation
> **Date:** 2025-08-10T00:50:06Z
> **Messages:** 12
> **Topic:** misc

## Question

Tell me briefly about how writing code works at apple. 

## Answer

Mr. White — super short:

- **Clear ownership.** Every project/task has a “DRI” (Directly Responsible Individual) on the hook for decisions and results. citeturn2search1turn2search16  
- **Prototype → demo culture.** Teams build quick prototypes and iterate through frequent demos/design reviews (“creative selection”). Specs are light; working software drives decisions. citeturn1search16turn1search2  
- **Radar for tracking.** Bugs, features, and tasks live in Apple’s internal tracker (“Radar”); external devs file via Feedback Assistant, which feeds the same system. “File a radar” is standard. citeturn0search10turn0search0  
- **Secrecy & compartmentalization.** Work is siloed; information is shared on a need-to-know basis, which shapes how code and features are developed and reviewed. citeturn2news30

Details vary by org, but those four pillars are consistent across Apple engineering.

## Question

If I were asked to build a prototype or mvp at apple, what would be stack look like? What ci would i use? What workflow on git and repo would i use? How would i go about pushing changes and fixes and features? At what point would I include other engineers? designers? Do I need approval on code review?  Basically fast can i move to get an mvp up? And are there repo templates? Ci templates? i must use, or do i just go?

## Answer

Mr. White — high-signal version:

**Stack (for an Apple-platform MVP)**
- **App:** Swift + SwiftUI (UIKit where needed), Combine; Xcode previews / Playgrounds for ultra-fast iteration. “Prototype → demo” is the norm. citeturn0search11turn0search6  
- **ML/graphics (if relevant):** Core ML / Create ML, Metal. (Public Apple stacks, commonly used in protos.)  
- **Server (if needed):** Team-dependent; many protos dodge a server entirely or use a thin mock. (Not publicly standardized.)

**Issue tracking & ownership**
- Open a **Radar** for the effort (feature + known risks). Make yourself the **DRI** (Directly Responsible Individual). citeturn0search7turn0search2turn0search0

**CI/CD**
- Default to **Xcode Cloud** for builds, tests, and TestFlight distribution; it’s Apple’s first-party CI/CD and quick to stand up on an Xcode project. If the org already has Jenkins/Bazel/etc., use their lane. citeturn0search13turn0search3turn0search18

**Git & repo workflow**
- Create a minimal Xcode project, push to the team’s hosted Git (branch-per-feature).  
- Keep **main** releasable; open PRs for review, squash-merge after CI green. (Standard large-company practice; specifics vary by org.)

**How you push changes**
- Small PRs, each linked to a Radar. CI runs → code review → merge → TestFlight to dogfood users (or internal installs). citeturn0search7

**When to pull others in**
- **Design:** as soon as the first clickable flow exists (Apple culture emphasizes demo-driven reviews—show, don’t tell). citeturn0search11turn0search16  
- **Engineers:** once the core spike proves feasibility and perf; split by components (UI, data, system APIs).  
- **PM/leadership:** at each demo milestone (weekly is common for protos).

**Approvals / code review**
- Yes—expect at least one LGTM before merging to main; some orgs require specific approvers. Tie PRs to Radars. (Process varies; review culture is universal.) citeturn0search7

**How fast can you move?**
- Very fast for a prototype: 1–3 days to interactive demo is typical when you control the scope. The gates are **Radar**, **CI green**, and **one review**—not heavy docs. “Creative selection” favors rapid demo cycles. citeturn0search11

**Templates**
- **Repo/CI templates:** some orgs have them; if none, Xcode project templates + Xcode Cloud default workflow are acceptable starting points. citeturn0search13

If you want, I’ll sketch a 7-day “Apple-style MVP” checklist for you to run.

## Question

How can i stop copilot from asking me to manually review every pr before taking it out of draft state

## Answer

Mr. White — short answer: you can’t “turn off” Copilot’s habit of opening **draft** PRs. That’s by design: Copilot opens a draft PR and tags you; draft PRs can’t merge or trigger some automations until they’re marked **Ready for review**. citeturn1search6turn2search12

Here’s the clean workaround to go fully hands-off:

1) **Allow auto-merge** in the repo. citeturn0search0turn0search1  
2) **Loosen branch protection** so reviews aren’t required (only status checks). Otherwise a human approval will still block. citeturn0search5  
3) **Add a tiny workflow**: when CI passes on a Copilot PR → mark it ready → enable auto-merge.

```yaml
name: Ready + Automerge Copilot PRs
on:
  workflow_run:
    workflows: ["CI"]     # <-- your CI workflow name
    types: [completed]

permissions:
  contents: write
  pull-requests: write

jobs:
  go:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - name: Find PR for the head branch
        uses: actions/github-script@v7
        id: pr
        with:
          script: |
            const head = context.payload.workflow_run.head_branch
            const [pr] = await github.paginate(
              github.rest.pulls.list,
              {owner: context.repo.owner, repo: context.repo.repo, state: 'open', head: `${context.repo.owner}:${head}`}
            )
            core.setOutput('num', pr?.number ?? '')
      - name: Mark ready
        if: steps.pr.outputs.num != ''
        env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
        run: gh pr ready ${{ steps.pr.outputs.num }}
      - name: Enable auto-merge (squash)
        if: steps.pr.outputs.num != ''
        env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
        run: gh pr merge --auto --squash ${{ steps.pr.outputs.num }}
```

Why this works / knobs you can tweak
- **Draft → Ready** is automated via `gh pr ready`. (Supported officially.) citeturn2search2turn2search1  
- **Auto-merge** engages once required checks pass. (Repo must have auto-merge enabled.) citeturn0search1  
- If you prefer an off-the-shelf action, you can swap the last step for **peter-evans/enable-pull-request-automerge**. citeturn3search0turn3search1  
- Optional: if you want to gate this, only run when the PR has label `automerge` or was opened by Copilot; add a label filter or author check.

Heads-up on tools you mentioned
- **Windsurf** (and Copilot code review) won’t review **draft** PRs — another reason to auto-flip to Ready. citeturn1search2turn1search12

If you want, I’ll tailor that YAML to your repo’s workflow names and branch rules so your Copilot/Windsurf PRs go from “draft” → “merged” with zero clicks.

## Question

So for the tip feature, it's working on local it looks like, but for the design what I want for the buttons is I want three squares horizontally filling the width, or not filling the whole width, but you know what I'm saying, laid out side by side horizontally. And they'll be square buttons with rounded corners. I'm thinking like they're just black borders maybe with like a white button maybe. And then the center one is highlighted by default so it'll be a purple border. And you basically get to their selectors so you can toggle so when you click on $3 then $5 is no longer highlighted and $3 is highlighted or you can click on $7 and click on one at a time. And then there's a call to action button underneath it that fills the full width of those of that whole section. And that button would be like the continue button and when you click that it would then open up Venmo pre-selected to the amount you selected and then pre-selected to the artist whose page it was. And I want that to be a v

## Answer

Got it, Mr. White. Here’s a clean, Apple-ish tip picker with square buttons + a full-width CTA that deep-links to Venmo with the selected amount and artist.

```tsx
// app/components/TipSelector.tsx
"use client";

import { useState, useMemo } from "react";
import { RadioGroup } from "@headlessui/react";

type Props = {
  venmoUsername: string;            // e.g. "artistname" (no @)
  amounts?: number[];               // default [3,5,7]
  defaultAmount?: number;           // default center option
  note?: string;                    // e.g. "Tip via Jovie"
};

export default function TipSelector({
  venmoUsername,
  amounts = [3, 5, 7],
  defaultAmount,
  note = "Tip via Jovie",
}: Props) {
  const center = useMemo(() => amounts[Math.floor(amounts.length / 2)], [amounts]);
  const [value, setValue] = useState<number>(defaultAmount ?? center);

  const onContinue = () => {
    const amt = Number(value).toFixed(2);
    const noteEnc = encodeURIComponent(note);
    // Native app scheme (best on iOS)
    const appUrl = `venmo://paycharge?txn=pay&recipients=${encodeURIComponent(
      venmoUsername
    )}&amount=${amt}&note=${noteEnc}`;
    // Web fallback (works on desktop / when app not installed)
    const webUrl = `https://venmo.com/${encodeURIComponent(
      venmoUsername
    )}?txn=pay&amount=${amt}&note=${noteEnc}`;

    // Try app, then fall back after a short delay
    try {
      window.location.href = appUrl;
      setTimeout(() => (window.location.href = webUrl), 700);
    } catch {
      window.location.href = webUrl;
    }
  };

  return (
    <div className="w-full max-w-md mx-auto">
      <RadioGroup value={value} onChange={setValue} aria-label="Choose tip amount">
        <div className="grid grid-cols-3 gap-3">
          {amounts.map((amt) => (
            <RadioGroup.Option key={amt} value={amt} className="group focus:outline-none">
              {({ checked }) => (
                <button
                  type="button"
                  aria-pressed={checked}
                  className={[
                    "aspect-square w-full rounded-2xl border-2 bg-white text-lg font-semibold",
                    "flex items-center justify-center select-none",
                    "transition-[border,box-shadow,transform] duration-150",
                    checked
                      ? "border-purple-600 shadow-[0_0_0_3px_rgba(168,85,247,0.25)]"
                      : "border-black hover:border-black/80",
                    "active:scale-[0.98]",
                    "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-black/10",
                  ].join(" ")}
                >
                  ${amt}
                </button>
              )}
            </RadioGroup.Option>
          ))}
        </div>
      </RadioGroup>

      <button
        onClick={onContinue}
        className="mt-4 w-full h-12 rounded-2xl border-2 border-black bg-black text-white font-semibold active:scale-[0.99] transition-transform"
      >
     

*(Answer truncated — 3600 chars total)*

## Question

{'asset_pointer': 'file-service://file-R3oF7fGfz1Xv1iAkgvz8Fu', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 956, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 526995, 'width': 1470}
{'asset_pointer': 'file-service://file-QiU8c29THqwbe5L1PN8xag', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 956, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': Tru

## Answer

Mr. White — here’s the tight audit + fixes to hit “Apple-clean” across `/[handle]`, `/tip`, `/listen`, `/follow`, `/notify`, `/tour`.

**1) Layout + rhythm**
- Lock a single column: `container mx-auto max-w-[720px] px-5 sm:px-6`.
- 8-pt spacing scale only (`2,4,8,12,16,24,32,48`); never ad-hoc margins.
- Keep header static across pages; swap only the “action area” below it to avoid perceived shift.

**2) Zero layout shift**
- Reserve image space: `next/image` with fixed `width/height` and `priority` on avatar.
- Reserve space for the verified check and subtitle by fixing line counts: `min-h-[28px]` for subtitle row.
- Preload fonts with `next/font` (SF Pro via `@fontsource` alt or system stack); set `font-feature-settings: "ss01","tnum"`.
- Skeletons with fixed heights for the action section (`h-[140px]` for tip grid, `h-[56px]` CTA).

**3) Type + color**
- Type scale: Title `text-3xl/9 font-semibold`, subtitle `text-sm text-zinc-500`, body `text-base/7`.
- Palette: neutral-first (white/black/gray). One accent token only: `--accent` (your purple). Use strictly for selection + primary CTA focus ring.

**4) Shared header (one component)**
- `ProfileHeader`: avatar (96), name (ellipsis handling), verified chip, subtitle that swaps per page:
  - Profile: “Artist”/“Creator”
  - Tip: “Tip with Venmo”
  - Listen: “Select a service”
  - Follow: “Follow”
  - Notifications: “Get updates”
  - Tour: “Tour dates”
- All pages import this; nothing else above the fold changes.

**5) Action modules (swappable card)**
Wrap each page’s core UI in the same card:
```tsx
<Card className="rounded-3xl border border-zinc-200 bg-white shadow-sm p-4 sm:p-5">
  {/* slot per page */}
</Card>
```
- Tip: your 3-square `RadioGroup`, `aspect-square` tiles, center preselected, accent border on checked.
- Listen: service tiles in a 2–3 column grid; identical tile component (icon + label).
- Follow: row of circular icon pills with labels (same hit area).
- Notifications: segmented toggles (SMS/Email/IG) + single primary CTA.
- Tour: list with date pill (monospaced `tabular-nums`), venue, city; sticky “Get Tickets” CTA.

**6) CTAs**
- One primary CTA per page. Full-width, 56px tall, `rounded-2xl`, black background, accent focus ring.
- Use a persistent bottom “safe area” pad on mobile: `pb-[calc(env(safe-area-inset-bottom)+12px)]`.

**7) Interaction polish**
- Micro-motion only on state change (Framer Motion 120–160ms, 10–20px translate, 0.08 ease).
- Press feedback: `active:scale-[0.98]` on tiles/CTAs. Focus: `ring-4 ring-[var(--accent)]/25`.
- Route transitions: keep header fixed; cross-fade only the card (`layoutId` or keyed `<AnimatePresence>`).

**8) Accessibility**
- RadioGroup for exclusive selections; every icon pill has `aria-label`.
- Targets ≥44×44; contrast ≥4.5:1 (tile text `#111`, disabled `#9ca3af`).
- Reduce motion media query respected.

**9) Data & perf**
- Prefetch subpages via `<Link prefetch>` when profile becomes visible.
- Venmo deep link: try app → 700ms → we

*(Answer truncated — 4443 chars total)*

## Question

release teh abtter y door on a sony a7iii so i can add a battery grip

## Answer

Mr. White — 20-second version:

1) Power OFF. Pop the battery out.  
2) Open the battery door fully.  
3) On the **inside edge of the door (by the hinge)** there’s a tiny spring-loaded **release slider**. **Slide it**, then **pull the door away** from the body—it lifts off the hinge. citeturn0search16turn0search24  
4) Attach the grip: insert the grip’s post/contacts into the battery bay, align the tripod screw, tighten the wheel. Most grips have a **holder to stash the removed door**—use it. citeturn0search14

Reinstall is the reverse: align the hinge, hold the slider, seat the door, release. Don’t force it.
