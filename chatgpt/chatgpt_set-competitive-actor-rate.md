---
title: "Set competitive actor rate"
type: note
created: 2025-08-02
updated: 2025-08-02
source: chatgpt-export
conversation_id: 688d9647-598c-832f-909a-bbf0958c8c48
message_count: 6
tags: [chatgpt, import, long-form]
---
# Set competitive actor rate

> Conversation ID: 688d9647-598c-832f-909a-bbf0958c8c48
> Created: 2025-08-02T04:38:32Z
> Updated: 2025-08-02T04:51:08Z
> Messages: 6

---

## User

I have an spiffy actor to scrape emails and social handles from YouTube. It previously was a 39/month rental and got 3 renters a month on average. now spiffy is adopting usage based models and my actors is still on legacy. Help me set a competitive rate that will maximize revenue.

---

## Assistant

Below is a compact playbook for switching your legacy $39/mo “YouTube Contact-Finder” actor to usage-based pricing without giving away margin.

---

## TL;DR (one-paragraph recap)

Competitors that only fetch basic video/channel metadata charge **$0.50-$1.00 per 1 000 results**; email-specific actors still hide behind $5-$12.99 subscription fees plus opaque overages. Apify’s new Pay-per-Result (PPR) or Pay-per-Event (PPE) models give you 80 % of gross minus platform costs, which for a lightweight Cheerio crawler average **≈ 0.02 USD per 1 000 channels**. Pricing your actor at **$0.80 / 1 000 items (min $3 per run, 10 % discount above 100 k)** under PPR keeps you under the “premium but fair” ceiling, beats e-mail rivals on transparency, and triples your historical $117/mo revenue as soon as usage tops ~150 k contacts a month. If your users value certainty over volume, add an optional “Starter bundle” $19/mo that includes 25 k contacts, then rolls into the same per-result rate.

---

## 1. What’s new on Apify

* Apify introduced **Pay-per-Event/PPR** in March 2025, letting developers charge for discrete events or results instead of flat rents. citeturn2view0  
* Profit formula: **payout = 0.8 × revenue – platform costs (CUs, traffic, proxies)**. citeturn0search8  
* CU pricing for most of your users is **$0.40 / CU on Free/Starter plans**. citeturn5view0  
* A Cheerio-based scraper averages **≈ 3 000 pages / CU → 0.05 CU per 1 000 pages ≈ $0.02 cost**. citeturn4view0

---

## 2. Competitive landscape

| Actor / Tool | Model | Price |
|--------------|-------|-------|
| YouTube Trending Scraper | PPR | **$0.50 / 1 000 videos** citeturn0search1 |
| Fast YouTube Channel Scraper | PPR | **$1.00 / 1 000 channels** citeturn1search4 |
| Contact-Info Scraper (web-wide) | PPE | **$0.002 per page + $0.005 run start** citeturn1search6 |
| Mass YouTube Email Scraper | $5/mo + usage (undisclosed) citeturn6view0 |
| Phone Scraper (YouTube) | $12.99/mo flat citeturn1search1 |
| Generic YouTube Scraper | Tiered: **$50 / 100 k results** (~$0.50 / 1 000) citeturn1search2 |

Take-away: <$0.50 is bargain tier; >$1.00 is perceived premium. None of the email-centric actors expose per-item pricing—your transparency is a differentiator.

---

## 3. Pricing maths

* **Your cost** per 1 000 contacts ≈ $0.02 (see §1).  
* **Profit at price P** → 0.8 P – 0.02.  
* Competitive sweet spot P ≈ $0.70-$0.90.  
* Choose **$0.80 / 1 000** → profit ≈ $0.62 / 1 000 (77 % margin).  
* Add **run minimum $3** to cover extremely small jobs; discount to **$0.72 / 1 000** once a single run exceeds 100 k to stay enterprise-friendly.

---

## 4. Revenue scenarios

| Monthly contacts scraped | Gross @ $0.80 | Your net* | Legacy $39×3 |
|--------------------------|--------------|-----------|--------------|
| 100 k | $80 | $62 | — |
| 150 k | $120 | $93 | $117 |
| 250 k | $200 | $158 | ↑70 % |

\*Net assumes $0.02 platform cost per 1 000.

---

## 5. Recommended SKU structure

1. **Pay-per-Result (default)**  
   * `$0.80 / 1 000 contacts`  
   * `Min charge $3 per run`  
   * `10 % off lines ≥ 100 k`  

2. **Optional Starter Bundle** (for renters who loved the old flat fee)  
   * `$19 / month` → includes 25 k contacts (worth $20)  
   * Overages at the same $0.80 / 1 000 rate  

3. **Hidden PPE tier for API integrators**  
   * Event “channel processed”: `$0.0008` (equivalent to $0.80 / 1 000)  
   * Event “email found”: `$0.002` — lets power users pay only when a contact is actually harvested.

This keeps you slightly above bargain scrapers while signaling higher value (full contact bundle), yet leaves enough room for Apify’s 20 % fee and CU costs.

---

## 6. Implementation checklist

1. In Apify Console ➜ **Monetize → Switch to PPR**.  
2. Define *result* as **one JSON item containing email + socials**; set base price and volume discount tiers.  
3. Add **run-minimum enforcement** in `APIFY_DEFAULT_PRICE` settings.  
4. Update README with clear cost calculator example: “10 000 channels ≈ $8”.  
5. Email past renters a coupon: **first 10 k results free** to seed usage and gauge new run sizes.

Follow the above and you should beat the old $117/mo floor while offering users transparent, usage-aligned billing.

---

## User

https://github.com/itstimwhite/Youtube_Channel_Apify_Actor this is my actor

---

## Assistant

Your GitHub repo confirms the actor still does exactly what email-hunters pay for—pulling addresses plus every major social link straight from a channel’s About page and batching up to 10 k channels per run while staying light on resources (maxConcurrency = 2)【turn1view0】.  Competitors with similar contact reach now sit between **$0.50–$1.00 / 1 000 results** on Apify Store【turn9search0】【turn9search3】【turn9search7】, while “old-school” email scrapers still hide behind $5-$39 flat plans【turn9search1】.  Below is a concise, evidence-driven plan to migrate off the $39/mo legacy rent and maximise profit under Apify’s Pay-per-Result (PPR) model.

---

## 1 · Cost anatomy of *your* actor  
* **CPU cost** – Apify charges **$0.40 / CU** on Starter plans【turn10search0】.  A simple Cheerio/HTTP crawl of a YouTube *About* page finishes ~3 000 requests per CU, i.e. **≈0.05 CU per 1 000 channels → $0.02 cost**.  
* **Memory** – README defaults to tiny 2 GB; keep it so to avoid Gold-tier surcharges.  
* **Proxies** – YouTube pages load fine through Apify’s shared datacenter proxy, so proxy cost is ⩬0 for most users.  
* **Result unit** – one channel item (email + socials + stats) already lands in the default dataset【turn1view0】, so no code change is needed for PPR metering.

---

## 2 · Market snapshot (June 2025)

| Actor | USP | Price |
|-------|-----|-------|
| **YouTube Scraper PPR (API Dojo)** | videos only | **$0.50 / 1 000**【turn9search0】 |
| **Fast YouTube Channel Scraper** | channel meta | **$1.00 / 1 000**【turn9search3】 |
| **Channel & User Scraper** | geo filters | **$0.50 / 1 000**【turn9search7】 |
| **Deeper Channel Scrapper** | bulk videos | **$2.00 / 1 000**【turn9search2】 |
| **Legacy email scrapers** | flat rent | **$5-$39 + usage**【turn9search1】 |

Take-away: <$0.50 signals “cheap & basic”, >$1.00 feels premium.  Email-level detail plus transparent pricing positions you comfortably at the high end of mainstream without scaring power users.

---

## 3 · Recommended price structure  

1. **Pay-per-Result (default)**  
   * **$0.80 / 1 000 channels**  
   * **$3 run minimum** (covers tiny jobs)  
   * **-10 % discount on any run ≥100 k results**  

2. **Optional “Starter Bundle”** for nostalgic renters  
   * **$19/mo** includes 25 k results (value $20)  
   * Same $0.80 overage rate  

### Why $0.80?  
Profit per 1 000 = 0.8 × 0.80 – 0.02 ≈ **$0.62** → 77 % margin after platform fees【turn8search0】【turn10search0】.  
You’d match your old $117/mo floor once users collectively pull **≈150 k contacts per month**, and everything above that scales linearly.

---

## 4 · Switching to PPR in <10 minutes  

| Step | Action |
|------|--------|
| 1 | In Apify Console → **Monetize** → choose **Pay-per-Result** |
| 2 | Set “Dataset item” price to **$0.80 / 1 000** and add a **$3 minimum** |
| 3 | Keep memory ≤ 2048 MB in `actor.json` to cap CU spend |
| 4 | Add a one-liner guard in `main.js` to push a dummy item if input is empty—prevents free runs (per Apify best-practice)【turn8search0】 |
| 5 | Update README pricing and include a cost calculator example (“10 000 channels ≈ $8”) |

No additional SDK code is required; Apify counts each `Actor.pushData()` item automatically when PPR is enabled.

---

## 5 · Migrating legacy renters  

* **Email blast** current subscribers: “Legacy plan ends Sept 1st → first 10 k results free on the new per-result model.”  
* Auto-issue a **25 % coupon for 30 days** to anyone with an active rental at switchover—reduces churn risk while they test new economics.  
* Keep the $19 Starter Bundle listed but hidden below the fold; Apify still lets you offer both rent and PPR in parallel.

---

### Bottom line  
At **$0.80 / 1 000 contacts with a $3 floor**, you undercut opaque email scrapers, beat generic meta scrapers on data depth, and triple expected revenue as soon as usage tops ~150 k contacts per month—all while maintaining ~77 % gross margin. Flip the switch, seed a small free-tier promo, and watch the usage scale instead of wrestling with fixed-fee churn.

---

## User

Give me a notice of pricing upadte that is concise

---

## Assistant

Mr. White, here’s a concise notice you can send:

---

**Subject:** Pricing Update – Effective Sept 1, 2025  

Hi there,

We’re replacing the flat **$39/mo** plan with transparent usage-based pricing: **$0.80 per 1 000 contacts (min $3/run)**, starting **Sept 1, 2025**. Your first **10 000 contacts are free**, and your existing jobs will migrate automatically—no action required.

Thanks for scraping with us!

---

*Industry-standard guidance recommends at least 30 days’ notice, a clear subject line, and upfront disclosure of the new rate.* citeturn0search8turn0search0turn0search1


## See Also
- [[chatgpt/chatgpt_actor-bio-optimization]]
- [[chatgpt/chatgpt_actor-in-modern-family]]
- [[chatgpt/chatgpt_actor-strikes-back-creator]]
- [[chatgpt/chatgpt_car-insurance-rate-increase]]
- [[chatgpt/chatgpt_competitive-analysis-jovie-vs-seated]]
