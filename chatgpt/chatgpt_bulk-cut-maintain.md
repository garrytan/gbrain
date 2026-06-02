---
title: "Bulk, Cut, & Maintain"
type: guide
created: 2023-11-07
updated: 2023-11-07
source: chatgpt-export
conversation_id: a50beaf4-7a2c-443f-8a52-dc10a70c5735
message_count: 4
tags: [chatgpt, import, code]
---
# Bulk, Cut, & Maintain

> Conversation ID: a50beaf4-7a2c-443f-8a52-dc10a70c5735
> Created: 2023-11-07T20:00:48Z
> Updated: 2023-11-07T20:01:17Z
> Messages: 4

---

## User

I would like to minicut for 4 weeks, then bulk for as long as i can, then cut for 10 weeks.


My current weight on scale today184.4lbs
Bf on scale 11.7%

please provide me the plan using the below guidelines:



When i ask for a plan, concisely show me the phases. Then ask if i want a prompt created. If i say yes, create a prompt for chat gpt that i can use with a doc create plugin to make the spreadsheet using the guidelines ive provided.


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

Based on your guidelines, here's a concise outline of the phases for your plan:

1. **Mini Cut (4 weeks)**: Aim for a 1% body weight loss per week.
2. **Bulk (Until BF reaches 21% on DEXA or 16 weeks max)**: Aim for a 0.5% body weight gain per week.
3. **Cut (10 weeks)**: Aim for a 0.75% body weight loss per week.
4. **Maintenance (Post-cut before any new phase)**: Duration will depend on the cut phase's results.

Would you like me to create a prompt for ChatGPT with the doc_maker plugin to make the spreadsheet using these guidelines?

---

## User

yes

---

## Assistant

Great, here's a prompt you can use with the doc_maker plugin to create a spreadsheet for your plan:

```
I need to create a spreadsheet for a fitness plan that includes a 4-week mini-cut, followed by a bulk phase until either body fat reaches 21% on DEXA or 16 weeks have passed, and then a 10-week cut. The rates of weight change should be -1% per week for the mini-cut, +0.5% per week for the bulk, and -0.75% per week for the cut. After the cut, include a maintenance phase before any new phase begins.

The spreadsheet should have the following columns: Date, Week Number (Overall), Week Number (Phase), Phase Type (Bulk, Cut, Mini Cut, or Maintenance), Weight Change for That Week, Cumulative Weight Loss or Gain for That Phase, Current Weight, BF on DEXA, BF on Scale, and FFMI.

Each row should represent a different week, and there should be an extra row to label the start of a new phase. Use the provided body fat and weight measurements to infer a discrepancy ratio between scale and DEXA readings for accurate tracking.
```

You can use this prompt to instruct the doc_maker plugin to generate the document. Would you like to proceed with creating this document now?


## See Also
- [[chatgpt/chatgpt_maintain-first-diet-length]]
- [[chatgpt/chatgpt_bulk-and-cut-plan]]
- [[chatgpt/chatgpt_bulk-clean-bookmarks-guide]]
- [[chatgpt/chatgpt_bulk-cut-cycle-system]]
- [[chatgpt/chatgpt_bulk-export-emails-ipad]]
