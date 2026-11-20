# Skill resolver: a score gate so it can say "no skill fits" (shipped, 2026-11-14)

- **We learned that the skill resolver had no way to say "no skill fits".** On a labelled set it suggested a skill on 61 of 61 requests that needed none. Turning on its existing score gate at 0.6 cut that to 7 of 61, at a cost of about 1 request in 100 that needed a skill.
- **We learned that the right gate depends on the catalog.** In a real OpenClaw gateway with 750 skills, the same gate still showed a block on 93 of 112 no-skill requests. You should measure the gate on your own catalog size.

## Question

`gbrain skills resolve` matches a user turn to installed skills with no model call and shows the top matches to the agent. Can it stay quiet when nothing fits, without hiding the right skill when something does?

## What was tried

- An earlier preregistered offline test in gbrain-evals ([#388](https://github.com/garrytan/gbrain-evals/pull/388), 2026-11-07) found that word-matching ranking beats the static skill lists harnesses use, but that no shippable ranker passed its "no skill applies" gate.
- A threshold sweep of the existing `top_gate` on public set P (351-skill catalog, Codex kit, top 5): 0.6 was chosen on the dev half as the lowest setting under 25% of no-skill requests blocked, then checked on the held-out half.
- The fix makes 0.6 the default and makes the OpenClaw plugin, the Pi extension and the CLI pass the setting through.
- Later, a keyless test inside a real OpenClaw gateway (fake model, fake Telegram API) benched 750 skills and 320 labelled requests, top 3.

## Results

| Gate | No-skill requests with a block | Right skill in block |
|---|---|---|
| Off (before) | 61 of 61 (100%) | 176 of 228 (77.2%) |
| 0.5 | 14 of 61 (23.0%) | 175 (76.8%) |
| **0.6 (shipped)** | **7 of 61 (11.5%)** | **174 (76.3%)** |
| 0.7 | 3 of 61 (4.9%) | 166 (72.8%) |

- Held-out half at 0.6: 2 of 30 no-skill requests blocked; the right skill showed on 85 of 113, against 86 with the gate off.
- Real gateway, 750 skills, gate 0.6: a block on 93 of 112 no-skill requests (110 with the gate off); the right skill in the block for 69 of 173. `gbrain skills resolve` gave identical counts, so the high rate comes from the data and catalog, not the gateway. Why it differs from set P is not explained yet.

Sources: [#9356](https://github.com/garrytan/gbrain/pull/9356) (merged as `5b4cbe81`) and [#9799](https://github.com/garrytan/gbrain/pull/9799) (merged as `559311bb`); internal reports (refs GST-2704, GBRA-509, GBRA-649).

## Decision and why

Shipped the 0.6 default (`top_gate: 0` turns it off), approved by the maintainer as a default change. It removed most false suggestions on the labelled set at almost no loss of right ones.

## Cost

About $27.50 of model use for the fix; no paid evals.

## What would reopen it

- The 750-skill result: a gate that holds at large catalogs probably needs a different score or a catalog-size-aware threshold. That is open, not decided.
