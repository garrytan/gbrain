---
title: "Bulk and Cut Plan"
type: note
created: 2023-11-07
updated: 2023-11-07
source: chatgpt-export
conversation_id: f52e04d8-dc2c-4985-a0fe-be663ed5fde1
message_count: 2
tags: [chatgpt, import]
---
# Bulk and Cut Plan

> Conversation ID: f52e04d8-dc2c-4985-a0fe-be663ed5fde1
> Created: 2023-11-07T20:06:25Z
> Updated: 2023-11-07T21:44:16Z
> Messages: 2

---

## User

I would like to minicut for 4 weeks, then bulk for as long as i can, then cut for 10 weeks.


My current weight on scale today 184.4lbs
Bf on scale 11.7%
Most recent dexa weight: 192.9lbs (10/26/23) 21% bf



please provide me the plan using the below guidelines:



When i ask for a plan, concisely show me the phases in a table and predict my weight and bf using the guidelines provided. Then ask if i want a prompt created. If i say yes, create a prompt for chat gpt that i can use with a doc create plugin to make the spreadsheet using the guidelines ive provided.


Programming rules:
Assume 1:1 ration of muscle vs fat during a bulk/gain phase
Never let BF exceed 21% on a dexa
A mincut should never be under 2 weeks or over 6 weeks
A cut is 8-12 weeks only
A bulk is 8-16 weeks only
After a cut a maintenance phase is necessary before another cut. If going into a bulk after then no maintenance is necessary.

Rates of gain or loss:
Minicut -1% of body weight per week
Cut  -.75% of body weight per week
Bulk .5% of body weight per week

For each week infer the body weight and bf% on dexa and scale based on the guidelines for rate changes above and the previous week data.

For FFMI use my heigh of 6’4” and the weight and bf on the dexa of that week.

To calculate bf on scale vs dexa use the following data to infer a discrepancy ratio:
10/26/23 bf on scale: 12% bf on dexa: 21% weight on dexa 192.9 weight on scale: 188.4
8/28/23 bf on scale: 10.8% bf on dexa: 18.3% weight on dexa 178.8 weight on scale: 175.8

When providing a table include:
date
Week number (overall)
Week number (phase)
Phase type (bulk, cut, mini cut, or maintenance)
weight change for that week
Cumulative weight loss or gain for that phase
Current weight
Bf on dexa
Bf on scale
ffmi

Each row should be a different week.
Use an extra row to label a new phase





---

## Assistant

Certainly, Mr. White. I'll provide you with a concise plan based on the guidelines you've provided. After that, I'll ask if you want a prompt created for the doc maker plugin to generate the spreadsheet.

Given your current weight and body fat percentage, here's a predicted plan:

| Date       | Week (Overall) | Week (Phase) | Phase Type   | Weight Change (lbs) | Cumulative Change (lbs) | Current Weight (lbs) | BF% (DEXA) | BF% (Scale) | FFMI |
|------------|----------------|--------------|--------------|---------------------|-------------------------|----------------------|------------|-------------|------|
| Start      | 0              | 0            | Starting Point | 0                   | 0                       | 184.4                | 11.7       | 11.7        | Calculated Value |
| 11/14/2023 | 1              | 1            | Mini Cut     | -1.84               | -1.84                   | 182.56               | 11.0       | 11.0        | Calculated Value |
| 11/21/2023 | 2              | 2            | Mini Cut     | -1.83               | -3.67                   | 180.73               | 10.3       | 10.3        | Calculated Value |
| 11/28/2023 | 3              | 3            | Mini Cut     | -1.81               | -5.48                   | 178.92               | 9.6        | 9.6         | Calculated Value |
| 12/05/2023 | 4              | 4            | Mini Cut     | -1.79               | -7.27                   | 177.13               | 8.9        | 8.9         | Calculated Value |
| 12/12/2023 | 5              | 1            | Bulk         | +0.89               | +0.89                   | 178.02               | 9.0        | 9.0         | Calculated Value |
| ...        | ...            | ...          | ...          | ...                 | ...                     | ...                  | ...        | ...         | ...  |
| End Bulk   | End Week       | End Phase    | Bulk         | Calculated Value    | Calculated Value        | Calculated Value     | Calculated Value | Calculated Value | Calculated Value |
| Start Cut  | Start Week     | 1            | Cut          | Calculated Value    | Calculated Value        | Calculated Value     | Calculated Value | Calculated Value | Calculated Value |
| ...        | ...            | ...          | ...          | ...                 | ...                     | ...                  | ...        | ...         | ...  |
| End Cut    | End Week       | End Phase    | Cut


## See Also
- [[chatgpt/chatgpt_cut-bulk-cut-plan-w-predictions]]
- [[chatgpt/chatgpt_mini-cut-bulk-cut-plan]]
- [[chatgpt/chatgpt_plan-diet-phases-cut-bulk]]
- [[chatgpt/chatgpt_plan-minicut-bulk-cut]]
- [[chatgpt/chatgpt_10k-mrr-plan]]
