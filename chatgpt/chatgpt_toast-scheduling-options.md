---
title: "Toast scheduling options"
type: note
created: 2025-10-04
updated: 2025-10-04
source: chatgpt-export
conversation_id: 68e18eed-f8e0-832b-ab29-ba172eca0935
message_count: 2
tags: [chatgpt, import, long-form]
---
# Toast scheduling options

> Conversation ID: 68e18eed-f8e0-832b-ab29-ba172eca0935
> Created: 2025-10-04T21:17:34Z
> Updated: 2025-10-04T21:17:47Z
> Messages: 2

---

## User

Hey, real quick. So we use Toast at Vault. And I'm currently doing scheduling on a spreadsheet, which has its pros and cons. Big pro is that people don't have to download the Sling app or like 7-chips or something. Of course, we could always, you know, publish a schedule or send a screenshot or something, I guess, and that would effectively do the same thing. But as our staff starts to expand and we start to bring in more people, especially because a lot of our staff has complex availability, and as I am trying to implement, for the first time, performance-based scheduling, the people who bring in the most money are going to get the best shifts and the most shifts. And I'm trying to basically, you know, eliminate the people on our staff that are not doing a good job of bringing in money. As I start to look at that, I'm considering options for better scheduling. And one of the concerns, so what I want to know is I don't know that it necessarily, like I don't want to increase our Toast bill too much. I know that there's a Sling free app that comes with our current Toast subscription, but we don't get like some of the paid features. I think people setting their availability as a paid feature, and I'm basically just trying to weigh whether or not it makes sense for people to send their availability to me via calendar or via text, and we just like update it in the sheet or something or whatnot. Or like quite honestly, I could probably build a quick little app within our Next.js operation site and give everyone their own, you know, I could literally give everyone who has a Toast login a login on the thing, have the pin match their Toast pin, and let them just like show our whole calendar and have them click to tap their availability on and off, and that might actually be a more intuitive thing than even using Sling or anything like that. You know, so I'm wondering if maybe that's a thing that I just build really quick, because quite honestly, it wouldn't be that hard, but I'm thinking about it in terms of... I'm just thinking like what would be... If I decide to implement it, I guess I want to know is there a cap on how many employees I can add to Toast in general? Like can I give everyone in our staff Toast logins or like at least pin codes for clock in and clock out? Or is there a cap on the number of employees I can add on Toast? Or do they start charging me for having more employees and stuff? So that's one. And then two is how does adding Sling scheduling impact that on the free version of Sling? And then three, if we go to the paid option, how much would that... Would we get billed on top of our Toast subscription? Are we getting billed per user? Or is it just a flat rate upgrade?

---

## Assistant

Hey Mr. White — good questions. I dug into what’s publicly known; there’s some nuance and you’ll likely want to talk to your Toast rep for specifics. But here’s what I found + what I’d recommend thinking through.

---

## 1. Is there a cap on how many employees you can add in Toast? Do they charge extra per user?

- Toast itself is primarily a POS/payment platform. Their base plans don’t always include robust scheduling or employee management. citeturn0search0turn0search16  
- The “Payroll Bundle” (which includes “lite” scheduling) is an add-on to Toast’s POS. That costs **$90/month + $9 per employee** (for the scheduling + payroll side) according to one pricing guide. citeturn0search2  
- Another Toast plan (“Restaurant Basics”) is quoted at $110/month + $4 per employee. citeturn0search13turn0search24  
- Several users in Toast forums mention that Toast bills based on **active employees** (i.e. the ones you haven’t terminated) for its payroll/scheduling add-ons. citeturn0search19turn0search18  
- I found **no definitive public source** saying there’s a hard “cap” on number of employees you can add under Toast (for POS or clock‐in). But adding the scheduling/payroll modules is where per‐employee charges tend to creep in.

**Bottom line**: For your use case, you can likely give many staff PINs/logins under the POS/clock‐in system. But once you start using Toast’s scheduling/payroll add-ons, you’ll pay per employee (or per active employee) for that module.

---

## 2. How does the free version of Sling scheduling work / what are its limitations?

- Sling has a free plan (no cost) that includes basic features: shift scheduling, time-off requests, available shifts, news sharing, long-term scheduling, private messaging. citeturn0search9turn0search31turn0search12turn0search34  
- The free version is **limited to 30 users** in many sources. citeturn0search31turn0search12turn0search20  
- To unlock more advanced features (labor cost tracking, overtime rules, reporting, PTO management, etc.), you need to upgrade to a paid plan. citeturn0search1turn0search6turn0search12turn0search32  
- Paid tiers (Premium / Business) are priced per user per month. For example:
  - Premium: ~$2/user/month citeturn0search6turn0search33turn0search12  
  - Business: ~$4/user/month citeturn0search6turn0search12turn0search33  

So if your team is small (< 30), Sling’s free version might get you 80% of what you need for scheduling. As you grow, you’ll hit the ceiling and want features that justify paying for it.

---

## 3. If you go paid, how does billing work (with Toast + Sling)? Flat or per user?

- **With Toast**: The scheduling/payroll add-on is per-employee (or per active employee) on top of whatever base POS plan you already have. citeturn0search2turn0search3turn0search18turn0search19turn0search24  
- **With Sling**: Upgrades are per user per month (i.e. you pay for each employee on your roster under the paid plan) rather than a flat rate. citeturn0search6turn0search12turn0search33turn0search1turn0search31  
- Importantly, if you want to use Sling **in addition to** (or integrated with) Toast, that would be an extra bill separate from Toast’s charges. Toast’s scheduling module (when bundled) may reduce your need for a separate scheduling tool, but that might come with tradeoffs in feature richness.

---

## Recommendation / Hybrid Approach

Given your desire to enforce performance‐based scheduling and control costs, here’s what I’d lean toward:

- Start with **Sling’s free plan** and use it for availability, shift proposals, and basic scheduling. If your team is under 30 and you don’t need deep analytics yet, it might cover enough initially.
- Meanwhile prototype your internal minimal app idea (Next.js) for availability input / shift bidding. Use that to capture your custom logic, then export data to update the master schedule in Sling (or your sheet) initially.
- Once you cross Sling’s free ceiling or need advanced features (labor cost control, overtime alerts, performance rankings), you can upgrade that tool—or seriously evaluate Toast’s scheduling add-on to see if it’s worthwhile.
- Before fully committing to Toast’s scheduling/payroll add-on, get a quote from Toast based on your current & expected headcount. Compare that to Sling’s per-user cost + your internal dev time.

If you like, I can build a simple cost‐projection model (for, say, 50–100 staff) comparing Toast’s add-on vs Sling’s paid tiers vs building your own. Want me to run that for you?
