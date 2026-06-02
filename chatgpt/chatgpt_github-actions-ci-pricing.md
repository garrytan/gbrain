---
conversation_id: 696c4068-6318-832f-8cab-4297c2566755
created: 2026-01-18
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: GitHub Actions CI Pricing
type: note
updated: 2026-01-18
---

# GitHub Actions CI Pricing

**Related:** [[coding_devops]]

> Conversation ID: 696c4068-6318-832f-8cab-4297c2566755
> Created: 2026-01-18T02:07:36Z
> Updated: 2026-01-18T02:08:14Z
> Messages: 2

---

## User

github actions ci pricing

---

## Assistant

Here’s a concise breakdown of **GitHub Actions CI pricing** as of early 2026:

### 🧾 Core Pricing Model
- GitHub Actions is **usage-based**: you pay per minute of CI/CD runtime. citeturn0search2
- **Public repositories:** Actions usage (GitHub-hosted runners, self-hosted) remains **free**. citeturn0search11
- **Private repositories:** Usage beyond free quotas is billable based on minutes consumed on runners. citeturn0search0

### 💲 GitHub-Hosted Runner Pricing
GitHub’s pricing calculator lists per-minute rates for hosted runners (includes a platform charge): citeturn0search7
- **1-core runner:** ~$0.002/min  
- **2-core runner:** ~$0.006/min  
- **4-core runner:** ~$0.012/min  
- **8-core runner:** ~$0.022/min  
- **16-core runner:** ~$0.042/min

These are billed for each workflow job minute used.

### 🏠 Self-Hosted Runner Pricing (Update)
GitHub announced that starting **March 1, 2026** a **$0.002 per minute platform charge** will apply to jobs running on self-hosted runners in **private** repositories — even though you supply the hardware. citeturn0search3turn0search8  
- This change applies to the **control plane orchestration** (scheduling & workflow management).  
- You still pay for your own infrastructure separately (cloud/VPS cost).  
- **Public repo self-hosted usage remains free.** citeturn0search0

> Note: Some reports indicate GitHub may be reviewing/postponing self-hosted billing specifics after community feedback, but the billed model is the current announced approach. citeturn0search18

### 🆓 Free Quotas
- GitHub plans include **free Actions minutes** for private repos depending on subscription tier — check your plan details. citeturn0search0

### 📊 Summary
- **Public CI usage:** Free. citeturn0search11  
- **Private CI on GitHub-hosted runners:** Charged per minute based on runner size. citeturn0search7  
- **Self-hosted private runners:** ~$0.002/min platform charge (plus your own infrastructure costs). citeturn0search3

If you want, I can estimate your monthly bill based on your expected CI minutes and runner types.


**Topic:** [[chatgpt-clusters/business_startup]]
