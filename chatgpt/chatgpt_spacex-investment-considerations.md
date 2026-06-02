---
title: "Spacex Investment Considerations"
type: note
created: 2026-04-10
updated: 2026-04-11
source: chatgpt-export
conversation_id: 69d98c9c-e0a4-83e8-b952-330adeb2585a
message_count: 5
tags: [chatgpt, import]
---
# Spacex Investment Considerations

> Conversation ID: 69d98c9c-e0a4-83e8-b952-330adeb2585a
> Created: 2026-04-10T23:49:49Z
> Updated: 2026-04-11T00:08:22Z
> Messages: 5

---

## User

100k spacex investment in a spv in 2018. when it goes public inclined not to sell it for at least 10 years. anything to consieder around that?

---

## Assistant

I’m checking the key variables that drive this answer: how the SPV was structured, whether any QSBS treatment can survive the SPV, what an IPO changes for lockups and resale, and the California tax angle.

---

## Assistant

A 10-year post-IPO hold does not itself create a special tax break. The bigger questions are whether the SPV preserved any Section 1202 benefit, whether California still taxes the full gain, and whether the SPV can force a sale or taxable share distribution.

---

## Assistant

One useful update: for a 2018 SpaceX SPV, federal QSBS looks like a long shot. Common blockers are secondary-share acquisition instead of original issuance and the older $50 million gross-asset cap.

---

## Assistant

Mr. White, yes. I would focus on three things first: QSBS, who controls the exit, and California tax.

1. **Your 10-year hold only matters if the SPV lets you keep the stock.**  
If the SPV is taxed as a partnership and it sells the SpaceX shares after an IPO, the gain passes through to you that year, and partners report partnership items whether or not cash is distributed. Current section 1202 also lets a qualifying partnership distribute stock to a partner without resetting how the stock was acquired or how long it has been held, if the pass-through requirements were met. citeturn895076view1turn895076view0turn728708view1

2. **Federal QSBS is the big swing.**  
Current law says stock acquired after September 27, 2010 and on or before the current “applicable date” can still get a **100% federal exclusion** after more than 5 years; the current statute ties that applicable date to **July 4, 2025**. For a partnership/SPV, you only get the pass-through benefit if you held your SPV interest when the SPV acquired the stock and continuously afterward. QSBS also generally requires stock acquired at **original issue** in a domestic C corporation that meets the active-business rules, so a secondary block bought from existing holders is a common failure point. Waiting longer does not fix a broken original-issue or continuous-holding setup. citeturn863372view0turn981371view2turn728708view1turn112600view1turn112600view3

3. **Model the federal QSBS cap now.**  
The current statute applies a per-issuer cap. For stock acquired on or before July 4, 2025, eligible gain is generally capped at the greater of **$10 million** or **10x basis**. On a rough $100k basis, the 10x-basis limb is about **$1 million**, so the dollar cap is usually the more relevant one if this becomes a very large win. citeturn883576view2

4. **California is likely the painful part.**  
California does **not** conform to the federal section 1045 or section 1202 QSBS deferral/exclusion rules, and California taxes capital gains at ordinary-income rates. California residents are taxed on all income regardless of source. So if you are a California resident when the exit happens, a gain that is excluded federally can still be taxable in California. citeturn229138search0turn773720view3turn118247search1

5. **IPO does not guarantee immediate liquidity.**  
Early holders often face restricted-security rules and lock-ups around an IPO, commonly around 180 days, and the prospectus typically discloses when shares become eligible for future sale. Even after Rule 144 conditions are met, legend removal can still require issuer and transfer-agent cooperation. Your SPV agreement can be more restrictive than the IPO itself. citeturn343993view0turn343993view1

6. **There is no standard tax bonus for waiting 10 years after IPO.**  
Ordinary long-term capital-gain treatment generally starts after more than 1 year. Because your investment dates to 2018, the 5-year federal QSBS clock is already satisfied **if** the structure qualifies. Extra hold time is mainly a concentration decision. If QSBS fails, you fall into the normal federal long-term capital-gain regime, and NIIT can also apply under current law. citeturn900374view0turn773720view4

7. **Be careful with hedging after IPO.**  
Section 1202 has a specific short-position rule. Collars, short hedges, and similar downside-protection trades can complicate or impair QSBS treatment. citeturn883576view3

The practical checklist is straightforward: confirm whether the SPV is a partnership or blocker, whether it bought **original-issue** shares or a secondary block, and whether an IPO triggers an **in-kind distribution** or a **forced sale/wind-down**. Then review the operating agreement for sponsor carry, fee bleed, tax distributions, and manager discretion to sell shares. The single most useful document is the SPV operating agreement together with your latest K-1.
