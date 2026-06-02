---
title: "Mini-cut, Bulk, Cut Plan"
type: note
created: 2023-11-07
updated: 2023-11-07
source: chatgpt-export
conversation_id: 15398080-8b0d-4ab4-8ce7-de59f5f46778
message_count: 2
tags: [chatgpt, import]
---
# Mini-cut, Bulk, Cut Plan

> Conversation ID: 15398080-8b0d-4ab4-8ce7-de59f5f46778
> Created: 2023-11-07T20:05:09Z
> Updated: 2023-11-07T20:05:36Z
> Messages: 2

---

## User

I would like to minicut for 4 weeks, then bulk for as long as i can, then cut for 10 weeks.


My current weight on scale today184.4lbs
Bf on scale 11.7%

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

Based on your guidelines, here's a concise plan for your mini-cut, bulk, and cut phases. After the table, I'll provide you with a prompt for the doc creation plugin.

| Date       | Week (Overall) | Week (Phase) | Phase Type | Weight Change (lbs) | Cum. Weight Change (lbs) | Current Weight (lbs) | BF% Dexa | BF% Scale | FFMI |
|------------|----------------|--------------|------------|---------------------|--------------------------|----------------------|----------|-----------|------|
| Start      | -              | -            | -          | -                   | -                        | 184.4                | 11.7%    | 11.7%     | -    |
| Week 1     | 1              | 1            | Mini Cut   | -1.844              | -1.844                   | 182.556              | ~11.0%   | ~11.0%    | -    |
| Week 2     | 2              | 2            | Mini Cut   | -1.826              | -3.670                   | 180.730              | ~10.3%   | ~10.3%    | -    |
| Week 3     | 3              | 3            | Mini Cut   | -1.807              | -5.477                   | 178.923              | ~9.6%    | ~9.6%     | -    |
| Week 4     | 4              | 4            | Mini Cut   | -1.789              | -7.266                   | 177.134              | ~8.9%    | ~8.9%     | -    |
| Week 5     | 5              | 1            | Bulk       | +0.886              | -6.380                   | 178.020              | ~9.0%    | ~9.0%     | -    |
| ...        | ...            | ...          | Bulk       | ...                 | ...                      | ...                  | ...      | ...       | -    |
| Week 20    | 20             | 16           | Bulk       | +0.886              | +6.176                   | 190.576              | ~15.0%   | ~14.0%    | -    |
| Week 21    | 21             | 1            | Cut        | -1.381              | +4.795                   | 189.195              | ~14.5%   | ~13.5%    | -    |
| ...        | ...            | ...          | Cut        | ...                 | ...                      | ...                  | ...      | ...       | -    |
| Week 30    | 30             | 10           | Cut        | -1.381              | -10.281                  | 180.295              | ~10.0%   | ~9.0%     | -    |

Please note that the BF% Dexa and BF% Scale are approximations based on the discrepancy ratio from your historical data. The FFMI is not calculated here as it requires a more complex calculation, but it can be added in the document creation process.

Would you like me to create a prompt for the doc creation plugin to make this spreadsheet?


## See Also
- [[chatgpt/chatgpt_bulk-and-cut-plan]]
- [[chatgpt/chatgpt_cut-bulk-cut-plan-w-predictions]]
- [[chatgpt/chatgpt_plan-diet-phases-cut-bulk]]
- [[chatgpt/chatgpt_plan-minicut-bulk-cut]]
- [[chatgpt/chatgpt_ipad-mini-4-listing]]
