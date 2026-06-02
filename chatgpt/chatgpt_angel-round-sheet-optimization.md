---
title: "Angel Round Sheet Optimization"
type: guide
created: 2026-02-15
updated: 2026-02-15
source: chatgpt-export
conversation_id: 69922e98-408c-8330-a598-1f7ef42d877e
message_count: 2
tags: [chatgpt, import, code]
---
# Angel Round Sheet Optimization

> Conversation ID: 69922e98-408c-8330-a598-1f7ef42d877e
> Created: 2026-02-15T20:38:59Z
> Updated: 2026-02-15T20:40:04Z
> Messages: 2

---

## User

We're starting to go for Jovie's first funding round. an angel round. we really just want 150k to get us 12 months of runway to get enough traction to get into YCombinator or speedrun.

help me build out this sheet and optimize it.

im going to dump a billion names first then go from there sorting them. and im gonna have ai do research and fill in this sheet

---

## Assistant

Mr. White — good. Treat this like a sales pipeline, not a contact list.

You’re raising $150k. That likely means:
- 10–20 angels
- $5k–25k checks
- Fast close
- Minimal diligence

Your sheet should optimize for **speed, prioritization, and probability of close**, not vanity tracking.

---

# 1. Fix the Core Structure

Your current columns are a start, but they’re missing decision-critical fields.

## 🔥 Replace “Status” With a Clean Pipeline

Use numeric stage only (no text inside cell):

| Stage # | Meaning |
|----------|----------|
| 0 | Not researched |
| 1 | Researched |
| 2 | Warm intro requested |
| 3 | Intro made |
| 4 | Meeting done |
| 5 | Follow-up |
| 6 | Soft commit |
| 7 | Hard commit |
| 8 | Signed |
| 9 | Dead |

Keep it clean so AI can reason about it.

---

# 2. Add High-Leverage Columns

Here’s the optimized structure for an angel round:

### Identity

- Investor Name  
- Type (Angel / Scout / Micro-VC)  
- Check Size Min  
- Check Size Max  
- Location  
- Twitter  
- LinkedIn  
- Email  
- YC / Speedrun connection? (Y/N)  

---

### Thesis Fit (AI-fillable)

- Stage Focus (Pre-seed / Seed / Other)  
- Sector Focus  
- Consumer / B2B / Creator Economy / AI  
- Geography Preference  
- Has invested in YC before? (Y/N)  
- Has invested in similar startups? (Y/N)  
- Portfolio overlap with Jovie (1–5 score)

---

### Warmth & Access

- Warm intro path (Name of connector)  
- Degree of warmth (Cold / Weak / Strong / Direct)  
- Already knows you? (Y/N)  
- Engaged on social? (Y/N)

---

### Deal Probability System (Critical)

Add:

- Interest Level (1–5 after meeting)  
- Conviction Score (AI estimate 1–5)  
- Estimated Check ($)  
- Close Probability (%)  

Then compute:

**Weighted Expected Capital**
```
= Estimated Check * Close Probability
```

This lets you see real pipeline health.

---

### Process Management

- Last Contact Date  
- Next Action  
- Next Action Date  
- Round # (if multiple touches)  
- Notes (structured, not essay)

---

# 3. Add a Scoring Column (Auto-Prioritize)

Create a **Priority Score**:

Example logic:

```
(Thesis Match * 2) 
+ (Warmth Score * 2)
+ (Check Size Score)
+ (YC Alignment Score)
```

This lets you sort instantly.

---

# 4. Separate “Mass List” From “Active Pipeline”

You said you’re dumping a billion names.

Don’t mix them.

Create 3 tabs:

### 1️⃣ Raw List (Mass Dump)
Only:
- Name
- Source
- URL

That’s it.

---

### 2️⃣ Research Queue
Where AI enriches:
- Check size
- Thesis
- Portfolio
- Intro path
- YC investments

---

### 3️⃣ Active Raise Tracker
Only investors you’re actively working.

Keep this clean.

---

# 5. Add a Runway + Target Math Dashboard

On your Dashboard tab:

Add:

- Target Raise: 150,000
- Committed
- Signed
- Weighted Pipeline
- Gap to Target
- Months of Runway Funded

Then calculate:

```
Committed + (Weighted Pipeline * 0.5 conservative)
```

You want visibility on:
- If you’re actually going to hit 150k
- How many more meetings you need

---

# 6. Angel Round Optimization Strategy

For $150k:

You don’t need prestige.
You need speed + belief.

Prioritize:

1. Former founders
2. YC alumni angels
3. Operators in your category
4. Angels writing $10k–25k checks
5. People who invest pre-YC

Deprioritize:
- Institutional VCs
- $100M+ funds
- People who “wait for traction”

---

# 7. How AI Should Fill the Sheet

Have AI extract:

- Average check size
- Most recent 5 investments
- Whether they invest pre-product
- Whether they invest solo
- Whether they co-invest with YC scouts
- Whether they’ve invested in companies later accepted into YC

That last one is huge.

---

# 8. What Actually Gets You Into YC

YC cares about:
- Growth
- Founder quality
- Speed
- Signal

Angels that help:
- YC alumni
- YC scouts
- Repeat YC angel investors
- Angels who tweet about YC

Add a binary column:

**“Signal to YC?” (Y/N)**

---

# 9. Your Real KPI

For a $150k angel round:

You likely need:
- 40–60 investor conversations
- 15–25 serious follow-ups
- 10–15 checks

Track:

**Meetings Booked**
**Meetings Completed**
**Conversion % to Commit**

---

If you want, I can:

- Rebuild your sheet structure cleanly
- Design the formulas
- Or create a tight “Angel Raise OS” template for you

What stage are you at right now — zero outreach, or already in conversations?
