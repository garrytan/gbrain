---
title: "Missing merge queue setting"
type: note
created: 2025-08-30
updated: 2025-08-30
source: chatgpt-export
conversation_id: 68b3165f-ac08-8328-b7c5-4b7e2f2d7e0c
message_count: 10
tags: [chatgpt, import, long-form]
---
# Missing merge queue setting

> Conversation ID: 68b3165f-ac08-8328-b7c5-4b7e2f2d7e0c
> Created: 2025-08-30T15:18:56Z
> Updated: 2025-08-30T15:23:44Z
> Messages: 10

---

## User

https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule#creating-a-branch-protection-rule

I dont have the require merge queue setting in my repo settings

---

## Assistant

Mr. White,

You’re not alone—if you don’t see the **“Require merge queue”** option in your GitHub repo’s branch protection settings, it’s almost certainly due to eligibility restrictions. Here’s a clear breakdown:

---

###  Why the “Require merge queue” Setting May Be Missing

#### 1. **Repository or Organization Plan Eligibility**
- **Merge queues are only available in**:
  - **Public repositories** owned by an organization, **or**
  - **Private repositories** owned by an organization **on GitHub Enterprise Cloud**.  
  Personal repositories—and organization repositories on the Free or Team plan—don’t support this feature.citeturn0search2turn0search9

#### 2. **Wildcard Patterns in Branch Protection**
- The **“Require merge queue”** option **cannot be used** with branch protection rules defined using **wildcards** (like `release-v*`). You must specify an **exact branch name** (e.g. `main` or `release-v1.2.3`).citeturn0search1turn0search12

#### 3. **Rulesets Configuration**
- If you’ve migrated to **Rulesets** (the newer configuration system), enabling merge queue in a ruleset doesn’t always apply the merge queue correctly. Some users have had to revert to classic branch protection to make it work.citeturn0search3

---

###  What You Can Do Next

1. **Check your organization’s plan**:
   - Is the repository public and owned by an organization?  
   - Or is it private but under an **Enterprise Cloud** plan?  
   If neither condition applies, mapping merge queue won’t appear.

2. **Use an exact branch pattern**:
   - Navigate to **Settings → Branches → Add rule** for your target branch (e.g. `main`).
   - Ensure **no wildcard** is used. If you're currently using a pattern like `release-v*`, you'll need an explicit rule for each branch.citeturn0search8turn0search12

3. **If using Rulesets**, consider:
   - Adding a classic branch protection rule that explicitly targets the branch and enables merge queue.
   - Alternatively, check if GitHub’s API or GraphQL allows configuring merge queue via Rulesets—though many users report that only branch protection works reliably.citeturn0search3turn0search7

---

###  Summary Table

| Issue                       | Why It Happens                                               | Suggested Fix                                      |
|----------------------------|--------------------------------------------------------------|----------------------------------------------------|
| Repo not eligible          | Feature limited to org. public or private Enterprise repos   | Verify repo type and plan                          |
| Wildcard branch rule       | Merge queues don’t work with wildcards                       | Use exact branch names for protection rules        |
| Using Rulesets only        | Merge queue may not be applied through Rulesets              | Add classic branch protection with merge queue     |

---

Let me know which scenario applies to you (e.g. public vs private, plan details, branch patterns), and I’ll help you craft the precise configuration to get **Require merge queue** working.

Mr. White, concise and to the point—just as you prefer.

---

## User

If I switch our repo ownership to organization how to does that effect costs?

---

## Assistant

Mr. White, here’s the breakdown:

---

### **Free vs. Paid Orgs**
- **Free Organization**: $0.  
  - Unlimited public & private repos.  
  - 2,000 CI/CD (Actions) minutes per month.  
  - 500 MB of Packages storage.  
  - No merge queue (needs Enterprise).  

- **Team Plan**: $4/user/month.  
  - More CI/CD minutes (3,000).  
  - 2 GB of storage.  
  - Still **no merge queue**.  

- **Enterprise Cloud**: $21/user/month.  
  - Merge queue available.  
  - Advanced security, compliance, SSO, etc.  
  - 50,000 CI/CD minutes, 50 GB storage included.  

---

### **Personal vs. Org**
- If your repo is under your **personal account** now:
  - Free → Free org: no cost increase, but no merge queue.  
  - To get merge queue → must move to **Enterprise Cloud org** → **$21 per user/month**.  

- Billing is **per seat**: every member with access counts.  

---

### **Effect on You**
If it’s just you right now:
- Switching to an org costs **nothing extra** on Free or Team.  
- To unlock **merge queues**, you’d pay **$21/month** for yourself (and any collaborators).  

---

Want me to give you a direct migration plan (steps + gotchas) for moving your existing repo into an org cleanly?

---

## User

So our repo is public. We currently have a free plan. Whats my costs now vs if i go enterprise? Personal vs organization orqneeshop? Can i have an org own it and still be on a free paln?

---

## Assistant

Got it, Mr. White. Here’s the exact comparison for your **public repo**:  

---

### **Personal Account (Free, Public Repo)**
- **Cost**: $0  
- Features: unlimited public repos, 2,000 Actions minutes/month, 500 MB Packages.  
- **Merge queue: not available.**

---

### **Organization – Free Plan (Public Repo)**
- **Cost**: $0 (same as personal)  
- You can move your repo into an **org** and still stay on the free plan.  
- Features: same as above → unlimited public repos, 2,000 Actions minutes, 500 MB storage.  
- **Merge queue: still not available.**

---

### **Organization – Enterprise Cloud (Public Repo)**
- **Cost**: **$21 per user/month**  
  - Each seat in the org costs $21/mo.  
  - If it’s just you, that’s $21/mo total.  
- Features:  
  - Merge queue enabled.  
  - SAML/SSO, audit logs, 50k Actions minutes, 50 GB storage.  

---

### **Summary**
- Personal Free (now): **$0**, no merge queue.  
- Org Free: **$0**, no merge queue.  
- Org Enterprise Cloud: **$21/user/month**, **merge queue enabled**.  

---

👉 Yes, you **can absolutely have an org own it and stay on free**—but that won’t unlock merge queues.  
To get merge queues, you need **Enterprise Cloud**, regardless of whether it’s a personal or org repo.  

---

Do you want me to map out the migration steps if you decide to move the repo into a free org first (to keep the door open for Enterprise later)?

---

## User

I want merge queue. Is there a 3rd party service i should use?

---

## Assistant

Mr. White,

If you're looking for a **merge queue** without upgrading to GitHub Enterprise, there are third-party tools you can use—and they might even offer richer features than GitHub’s native solution. Here’s a concise breakdown:

---

###  1. Mergify — Cloud Merge Queue Service
- A SaaS-based tool that automates pull request merges via customizable rules.
- Lets you define rules for when a PR qualifies (e.g., specific CI statuses, approvals).
- Supports:
  - **Prioritization** of PRs based on importance or urgency—something GitHub’s native queue doesn’t offer (it’s strictly FIFO) citeturn0search6.
  - **Batching** and optimized merging workflow to unlock significantly higher throughput citeturn0search6turn0search5.
- **Best for** teams wanting flexibility and advanced merge logic without self-hosting.

---

###  2. Graphite — Stack-Aware Merge Queue
- A GitHub App plus CLI tool optimized for teams using **stacked pull requests** (dependent chains).
- Key features:
  - **Stack-aware batching**: Runs CI for entire PR stacks together and can fast-forward merge them when validated—reducing redundant test runs citeturn0search2turn0search10.
  - Supports parallel CI validation and smart merging.
- **Best for** teams working with monorepos or complex stacked workflows, seeking performance and CI efficiency.

---

###  3. GitHub’s Native Merge Queue
- Built-in option available for **public repos owned by organizations**—but only on **Enterprise Cloud** for private repos citeturn0search0.
- Features:
  - FIFO ordering with temporary `merge_group` branches and concurrent CI builds.
  - Basic settings: merge method, concurrency, inclusion of failing PRs citeturn0search0turn0search10.
- **Limitations**:
  - No prioritization of PRs—strict FIFO only citeturn0search6.
  - CI cost is duplicated—on both the PR and the merged group.
  - Limited visibility and control compared to third-party tools citeturn0search10.

---

###  Quick Comparison Table

| Tool                         | Requires GitHub Enterprise? | Key Strength                        | Best Use Case                            |
|------------------------------|------------------------------|--------------------------------------|-------------------------------------------|
| **Mergify**                  | No                           | Flexible prioritization, batching    | Teams needing rules-driven automation     |
| **Graphite**                 | No                           | Stack-aware, CI optimization         | Monorepos with stacked PR workflows       |
| **GitHub Native Merge Queue** | Yes (for private); No (public org) | Native integration, minimal setup | Simple FIFO merge needs in GitHub         |

---

###  Recommendation
If upgrading to **Enterprise Cloud** is not feasible, your best bets are **Mergify** or **Graphite**. Choose based on your workflow:
- **Choose Mergify** if you want flexible, prioritized merging rules.
- **Choose Graphite** if you work with stacked PRs and want to reduce redundant CI and improve merge speed.

Would you like a quick setup walkthrough for Mergify or Graphite?

---

## User

If its a public repo, whats the options to enable it on github?

---

## Assistant

Mr. White, here’s the straight answer for **public repos**:  

---

### ✅ GitHub Native Merge Queue (Public Repo)
- **Available if** the repo is **owned by an Organization** (not a personal account).  
- **Cost**: $0 — works on the **Free plan** for orgs, since the repo is public.  
- **How it works**:
  1. Move your repo into an **org** (you can create one free).  
  2. Go to **Settings → Branches → Add rule** for `main` (must be exact branch, not a wildcard).  
  3. Under protections, the **“Require merge queue”** option appears.  
- **Caveats**: Only works with exact branch names (not `release-*` patterns).  

---

### ❌ Not Available
- Public repo under a **personal account** → no merge queue option.  
- Private repos without **Enterprise Cloud** → no merge queue option.  

---

### 🔑 Summary
For your repo:
- **Keep it personal, free, public** → no merge queue.  
- **Move it to a free org, keep it public** → merge queue available, no extra cost.  
- **Enterprise Cloud only matters** if the repo is private.  

---

Do you want me to write out the **step-by-step migration** from your personal account → free org so you can enable merge queue today?


## See Also
- [[chatgpt/chatgpt_merge-queue-delay-explanation-part1]]
- [[chatgpt/chatgpt_merge-queue-delay-explanation-part2]]
- [[chatgpt/chatgpt_merge-queue-delay-explanation-part3]]
- [[chatgpt/chatgpt_merge-queue-delay-explanation-part4]]
- [[chatgpt/chatgpt_merge-queue-eta-explained]]
