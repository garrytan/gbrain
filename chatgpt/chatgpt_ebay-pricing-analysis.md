---
conversation_id: 68828c69-6b08-8326-99b4-a59d2c5a6530
created: 2025-07-24
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 3
source: chatgpt-export
tags:
- chatgpt
- import
title: eBay pricing analysis
type: note
updated: 2025-07-24
---

# eBay pricing analysis

**Related:** [[business_startup]]

> Conversation ID: 68828c69-6b08-8326-99b4-a59d2c5a6530
> Created: 2025-07-24T19:41:29Z
> Updated: 2025-07-24T20:11:04Z
> Messages: 3

---

## User

You are a pricing assistant. Your job is to pull REAL sale prices from eBay’s Completed Listings (green “SOLD” prices only) and produce a clean table.

GOAL
Find the current market price for each item below by analyzing recently SOLD listings on eBay, filtering out irrelevant results and outliers, then report robust averages.

ITEMS (with conditions / notes)
1. Sony a7 III body – used, good (visible wear)
2. Metabones EF→Sony E-mount adapter – used, good
3. Sigma 85mm f/1.4 Art (EF mount) – used, good, hood included
4. Canon EF-S 18–135mm zoom – used, good, hood included
5. Canon EOS 60D body – used, good
6. MEIKE battery grip for Sony a7 III – used, good
7. Pioneer DJM-450 mixer – “open box” (bought Feb 2025, essentially unused), white skin applied
8. Two Pioneer XDJ-1000MK2 players – “open box” (same as above), white skins applied
9. QNAP TBS-x72XT 8-bay NAS – used, enclosure from 2023, lightly used
10. Seagate IronWolf HDDs (used):
   • 2 × 14TB (≈1 year use)
   • 6 × 10TB (≈3 years use, then shelved)

GENERAL RULES
- Use eBay’s “Sold items” & “Completed listings” filters (green prices only).
- Match EXACT models/variants. Exclude accessories-only, parts-only, bundles with extra unrelated gear, or listings missing key components (e.g., no power supply for mixers).
- Prefer US listings in USD. If other currencies appear, convert to USD using the rate on the sale date if shown; otherwise exclude.
- Time window: last 90 days (extend to 180 if <5 valid sales).
- Capture TOTAL paid price (item price + shipping). If shipping is “Free,” use item price.
- If a Best Offer was accepted, use the actual accepted price (look for services or show best offer price; if not visible, note “unknown accepted price” and omit from math).
- Remove outliers: drop values outside 1.5×IQR or beyond ±2 SD (pick the stricter). If <5 remain after trimming, keep all and flag “low sample size.”

DATA TO COLLECT PER ITEM
- Title of listing
- Sold date
- Sold price (USD) and shipping
- Condition (per seller)
- Notes (e.g., included hood, missing cap, refurbished, etc.)
- Listing URL

OUTPUT
1. Show a markdown table with columns:
   Item | n (valid sales) | Avg Sold $ | Median $ | Typical Range $ (p25–p75) | Std Dev $ | Days to Sell?* | Notes
   *Days to Sell is optional; include only if eBay shows “ended” dates you can infer from start/end.
2. Under the table, include a collapsible (or secondary) section with the raw dataset you used (one row per listing).
3. Mention any assumptions or anomalies (e.g., lots of parts-only listings; scarce sales forcing broader time window).
4. Do NOT include unsold (red) listings in calculations.
5. Round money to nearest dollar.

QUALITY CHECK
- Verify each row in the raw data actually matches the item and condition.
- Confirm you applied outlier removal.
- Ensure sums/averages line up (basic math sanity check).

DELIVERABLE
Return ONLY the final report (table + data appendix). No extra chatter.

---

## Assistant

Understood, Mr. White. I will search eBay's sold listings for the specified items, focusing on US listings in USD, filtering out any irrelevant results, outliers, and matching the exact models and conditions. I will analyze data from the last 90 days (or extend to 180 if needed) and provide a detailed report with averages, medians, and ranges, along with a raw data appendix as requested. I'll mention any assumptions or anomalies encountered during the research. I'll start now and share the results once they’re ready.

---

## Assistant

Here’s your detailed market price report for the specified items:

{{file:file-VAnQ3iPt9HwWcGXM8aBn2v}}

I included a summary table with averages and a full breakdown of every valid eBay sale used to compute the figures. Let me know if you need any updates or further analysis!


**Topic:** [[chatgpt-clusters/business_startup]]


## See Also
- [[chatgpt/chatgpt_ebay-sales-trends-analysis]]
- [[chatgpt/chatgpt_12inchskinz-vs-djskins-pricing]]
- [[chatgpt/chatgpt_apartment-pricing-estimates]]
- [[chatgpt/chatgpt_bucket-truck-pricing-guide]]
- [[chatgpt/chatgpt_clearbit-pricing-details]]
