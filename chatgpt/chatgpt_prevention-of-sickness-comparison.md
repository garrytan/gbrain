---
title: "Prevention of sickness comparison"
type: guide
created: 2025-11-23
updated: 2025-11-23
source: chatgpt-export
conversation_id: 69233ce4-3930-832f-9e9b-1e41c829f3fc
message_count: 4
tags: [chatgpt, import, code]
---
# Prevention of sickness comparison

> Conversation ID: 69233ce4-3930-832f-9e9b-1e41c829f3fc
> Created: 2025-11-23T16:57:27Z
> Updated: 2025-11-23T17:00:02Z
> Messages: 4

---

## User

Scientific evidence of emergence or airborne preventing sickness vs orange juice vs nothing

---

## Assistant

Mr. White, here’s what the evidence says about preventing respiratory colds/“getting sick” (common cold–type infections) with **Emergen-C**, **Airborne**, **orange juice**, vs **nothing**.

**Bottom line:**  
For the average adult, **none of these reliably prevents you from catching colds.** At best, adequate vitamin C (from food or supplements) **slightly reduces symptom severity and duration**, not incidence. citeturn0search3turn0search6turn0search12turn1search0

---

## 1. Emergen-C
- **What it is:** high-dose vitamin C (usually ~1,000 mg) + some B vitamins, sometimes zinc.  
- **Prevention evidence:**  
  - There are **no strong randomized trials showing Emergen-C as a product prevents colds**. Reviews note lack of product-specific evidence. citeturn0search7turn0search11turn1search4  
  - Since its main active idea is vitamin C, the best inference comes from vitamin C trials in general: **regular daily vitamin C doesn’t reduce cold incidence in most people**. citeturn0search6turn0search3turn1search0
- **Effect if you take it daily:** modest benefit on **duration/severity** only (roughly ~8–10% shorter colds; severity down ~15% in meta-analyses). citeturn0search4turn0search6turn0search2  
- **Taking it only when you feel a cold starting:** not shown to help much. citeturn0search3turn0search10

## 2. Airborne
- **What it is:** vitamin C (~1,000 mg) + zinc + herbal blends (like echinacea).  
- **Prevention evidence:**  
  - **No credible clinical evidence that Airborne prevents colds.** The FTC specifically cited lack of credible evidence and Airborne settled false-advertising charges. citeturn1search1turn1search3turn1search19turn0search1  
  - As with Emergen-C, any possible small benefit would be from vitamin C/zinc in general, not the branded product. citeturn0search5turn0search11turn0search6

## 3. Orange juice
- **What it is:** food source of vitamin C (8 oz OJ ~70–120 mg depending on brand), plus flavonoids.  
- **Prevention evidence:**  
  - **Drinking orange juice doesn’t prevent colds** in trials; it’s basically just a way to meet vitamin C needs. citeturn0search9turn0news34turn0search3  
  - If you were vitamin-C deficient, correcting that helps normal immune function, but that’s true for any adequate diet. citeturn0search3turn0news43
- **Downside:** juice adds sugar and lacks fiber vs whole fruit. citeturn0search9turn0news34

## 4. Nothing (placebo/normal diet)
- If your diet already supplies enough vitamin C (~75–90 mg/day for adults), **adding more doesn’t stop colds.** citeturn0news43turn0search3turn0search6  
- The only consistently supported “prevention” factors are boring basics: vaccination (for flu/COVID), sleep, hand hygiene, avoiding close exposure, and not being nutrient-deficient. Vitamin C megadoses aren’t in that list. citeturn0search3turn0search6turn0search12

---

## Practical takeaways
- **If your goal is prevention:** Emergen-C and Airborne are **not worth it** for most people. OJ is fine as food, but not a shield.  
- **If you like a small recovery edge:** taking **vitamin C daily** (food or supplement) might make colds slightly shorter/milder. Don’t expect miracles. citeturn0search4turn0search6turn0search2  
- **Dose caution:** staying under ~2,000 mg/day vitamin C avoids most GI side effects; higher chronic doses can cause diarrhea and may raise kidney-stone risk in susceptible people. citeturn0news43turn1search11

If you want, tell me what “getting sick” means for you (common colds only, or also flu/COVID), and I’ll tailor a prevention stack that actually moves the needle.

---

## User

code

---

## Assistant

Mr. White, here’s the “code” summary in a compact, evidence-graded way:

```yaml
goal: prevent_common_cold / airborne_URIs
comparison:
  Emergen-C:
    main_actives: [vitamin_C ~1000mg, small_zinc, B_vitamins]
    prevents_colds_in_general_population: false
    effect_on_duration_severity_if_taken_daily: small_benefit
    evidence_quality: moderate_for_vitC_general; low_product_specific
    notes: benefit = vit C effect, not brand-specific
  Airborne:
    main_actives: [vitamin_C ~1000mg, zinc, herbs]
    prevents_colds: false
    evidence_quality: low_product_specific
    notes: FTC: "no credible evidence" for prevention/benefit; settled deceptive-ads case
  Orange_juice:
    vitC_per_serving: ~70-120mg
    prevents_colds: false
    evidence_quality: old_RCTs_show_no_incidence_reduction
    notes: good for meeting vit C needs if diet low, not a shield
  Nothing (adequate diet):
    prevents_colds: same_as_above
    notes: if not vitC-deficient, extra vit C doesn't reduce incidence

evidence_core:
  vitamin_C_regular_daily:
    incidence_reduction: none_or_trivial_in_most_people
    duration_reduction: ~8-10_percent_shorter
    severity_reduction: modest
  vitamin_C_start_after_symptoms:
    benefit: minimal/inconsistent
  special_case:
    heavy_physical_stress (e.g., endurance athletes/subarctic training):
      incidence_reduction: yes_in_some_trials

safety:
  vitamin_C_upper_practical_limit: ~2000mg/day (GI upset above this common)
  caution: kidney_stones_in_susceptible_people
```

Key evidence behind that code:
- Meta-analyses/RC Ts show **vitamin C doesn’t prevent colds for most adults**, but **daily use slightly shortens and softens them**. citeturn0search2turn0search6turn0search0turn0search13  
- **Airborne specifically has no credible prevention evidence**; FTC settlement over deceptive “cold prevention” claims. citeturn0search1turn0search5turn0search8  
- An RCT of **orange juice (80 mg vit C/day) vs placebo found no prevention effect**. citeturn0search3  
- Product-level writeups of **Emergen-C** align with the above: not preventive, maybe mild symptom help via vit C. citeturn0search9turn0news41  

If you meant “code” as in an actual program/spreadsheet to calculate expected benefit or dosing, tell me what inputs you want (age, training load, diet, etc.) and I’ll draft it.


## See Also
- [[chatgpt/chatgpt_ai-coding-plan-comparison]]
- [[chatgpt/chatgpt_ai-model-comparison-for-nextjs]]
- [[chatgpt/chatgpt_amazon-battery-lifespan-comparison]]
- [[chatgpt/chatgpt_best-deal-comparison]]
- [[chatgpt/chatgpt_bleach-developer-comparison]]
