---
title: "MacroFactor trend weight calculation"
type: note
created: 2025-11-22
updated: 2025-11-22
source: chatgpt-export
conversation_id: 692123c1-ee90-832d-a54e-89e9c04b5f99
message_count: 4
tags: [chatgpt, import]
---
# MacroFactor trend weight calculation

**Related:** [[personal_health]]

> Conversation ID: 692123c1-ee90-832d-a54e-89e9c04b5f99
> Created: 2025-11-22T02:45:26Z
> Updated: 2025-11-22T02:47:22Z
> Messages: 4

---

## User

How does macro factor calculate trend weight

---

## Assistant

Mr. White, MacroFactor’s “trend weight” is essentially a smoothed version of your scale weight:

- **Step 1: Build a daily scale-weight series.** If you miss weigh-ins, MacroFactor fills the gaps with **linear interpolation** (e.g., 151 Mon, 150 Wed → assumes 150.5 Tue). This reconstructed line is what they call **Scale Weight**. citeturn1view0  
- **Step 2: Apply a recency-weighted moving average.** They run a moving-average style algorithm that **puts more weight on recent days and less on older days** to filter water/food noise but still track real change. In other words, newer weigh-ins influence the trend more, but older data still matters. citeturn1view0turn2view0  
- **Time scale / responsiveness:** While they don’t publish the exact math constants, MacroFactor describes it as weighting data over a **fairly long window**. Practically, the app’s downstream calculations treat trend changes over about **20 days** as the key signal (their “change rate” is based on the last 20 days of trend weight). That implies a smoothing horizon on the order of a few weeks. citeturn0search5turn1view0  

**Net effect:** trend weight moves slower than daily scale weight, ignores short spikes/drops, and gives a better read on your “true” direction of gain/loss. citeturn1view0turn2view0

---

## User

We need trend weight calculation in our app and we need FFMI to be calculated off trend weight rather than scale weight.  Give me a simple one paragraph prompt to add this to our app

---

## Assistant

Mr. White, here’s a single-paragraph prompt you can drop into your task/spec:  

“Implement a **Trend Weight** metric that smooths daily scale weigh-ins to estimate true bodyweight: build a daily weight series (linearly interpolate across missing days), then compute a recency-weighted moving average (e.g., exponential moving average) so newer days influence the value more while filtering short-term water/food noise; expose this as `trend_weight` updated each day. Then modify our **FFMI** calculation to use `trend_weight` instead of raw scale weight: `lean_mass_kg = trend_weight_kg * (1 - bodyfat_decimal)`, `FFMI = lean_mass_kg / (height_m^2)` (apply any existing height-normalization/adjusted-FFMI step we already use), and ensure all FFMI charts/exports reference trend weight as the base.”


**Topic:** [[chatgpt-clusters/personal_health]]


## See Also
- [[chatgpt/chatgpt_bmi-calculation-for-weight]]
- [[chatgpt/chatgpt_bmi-weight-calculation-request]]
- [[chatgpt/chatgpt_current-weight-calculation-design]]
- [[chatgpt/chatgpt_steady-weight-loss-trend]]
- [[chatgpt/chatgpt_target-weight-calculation]]
