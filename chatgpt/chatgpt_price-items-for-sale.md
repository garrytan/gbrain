---
title: "Price items for sale"
type: guide
created: 2025-07-24
updated: 2025-07-24
source: chatgpt-export
conversation_id: 68828c0a-0368-8332-91f3-42b34b2ca5ba
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# Price items for sale

> Conversation ID: 68828c0a-0368-8332-91f3-42b34b2ca5ba
> Created: 2025-07-24T19:39:55Z
> Updated: 2025-07-24T19:40:20Z
> Messages: 2

---

## User

I need you to construct a prompt for an AI agent. I would like the agent to go to eBay and look at completed listings and use the completed listings feature to figure out the sale price for certain items. So I'm going to list out a bunch of items I have that I want to sell and I would like you to go through and price out each item first. So I have a Sony a7 III camera. I have a Metabones that adapts an EF lens to the Sony E-mount. I have a Sigma Art Series 85mm prime lens. I have a, and all of those are used, like good condition but not great condition like classic signs of wear that I've had for a few years. I also have a Canon 18-135mm, EF-S 18-135mm zoom lens. All of the lenses mentioned come with hoods. I also have a Canon EOS 60D and I have a battery grip from the brand MEIKE for the Sony a7 III. I have a, so all that stuff so far has been used in good condition. Then I have brand new a DJM 450 with a white skin and two XDJ-1000 Mark II's, also brand new, also with white skins. The white skins for the three devices cost me $250 new and then the XDJs and the DJM were skinned with them immediately so that when the skins are removed they'll look brand new. But also these devices were purchased in February and have been taken out of the box once so they're still in the box brand new with all the original stuff. So basically should be sold as like an open box item but we should price them out without the skins and then I'll just have to calculate adding the skins to the price or we'll throw the skins in for free or whatever. I have a used QNAP TBS-X72XT. It has two 512GB M.2 cache drives in it. We'll probably have to sell everything separately I'd assume because you probably won't be able to get prices combined. It's an 8 bay and it has drives in it. The drives I'll probably sell separately so they are two 14TB Ironwolf drives from Seagate and then six 10TB Ironwolf drives from Seagate. And the the drives are used. The 14TBs replaced the 10TBs. The 10TBs were bought in 2020 probably used for like three years before being shelved. And so the 14TBs I think replaced the two 10TBs so those are newer probably only have like a year on them. And then the enclosure itself was sent out for warranty and they sent me a brand new enclosure so that is probably from 2023 and is used but was only used for one year before being shelved. The drives and the thing have been shelved for the last two years so they haven't been even turned on. Still working though, works fine. Then in addition to that I have um I guess those are the main things. So I want to get I want you to go through I want the AI to go through and look at each item on eBay and then I want it to go and look at turn on the completed item setting and then I want it to look at recent completed items that actually sold so they're green not red they actually sold. And then I want it to filter out things that aren't actually the item like I want it to find specifically the item so if it's like for example if it's a a Sigma Art Series 85 millimeter lens and the results show you a bunch of lens hoods and lens caps I need to filter those out and just show the lenses so we just get the results of like the lenses that sold successfully recently and then I want to basically figure out intelligently figure out like what's the average price that they're kind of going for and do that by removing outliers so that you don't get you know if there's like some weird ass list thing that's like 99 cents and then everything else is selling for $2,000 I don't want the 99 cent one to skew the average price so I want an accurate average price um and then take all of that and throw it together in a table for me in a table for me um so that I just get a table listing the items um and listing the price it's selling for and then if there's any other information you think would be useful from that research to use in um my own purposes then include that but if not then don't um so go ahead and give me that prompt

---

## Assistant

Here’s your agent prompt, Mr. White—drop it in and go:

```
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
```

