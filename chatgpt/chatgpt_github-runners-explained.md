---
title: "GitHub Runners Explained"
type: note
created: 2026-02-22
updated: 2026-02-22
source: chatgpt-export
conversation_id: 699b8ac6-83a4-832c-82a6-0faaa651e160
message_count: 6
tags: [chatgpt, import, long-form]
---
# GitHub Runners Explained

> Conversation ID: 699b8ac6-83a4-832c-82a6-0faaa651e160
> Created: 2026-02-22T23:01:30Z
> Updated: 2026-02-22T23:02:59Z
> Messages: 6

---

## User

github runners

---

## Assistant

**GitHub Actions “runners”** are the machines that actually **execute the jobs** defined in your workflow files when you use GitHub Actions for CI/CD automation. They take each job step-by-step, checking out code, running builds, tests, deployments, etc. citeturn0search2

### What a Runner Is  
- A **runner** is the application or environment that runs a GitHub Actions job. citeturn0search14  
- When an event (like a push or pull request) triggers a workflow, GitHub hands off the job to a runner; the runner then executes your defined steps. citeturn0search15

### Two Main Types of Runners  

**1. GitHub-Hosted Runners (Default)**  
- These are VMs or containers **provided and managed by GitHub**. citeturn0search0  
- You choose the environment with `runs-on` in your YAML (e.g., `ubuntu-latest`, `windows-latest`, `macos-latest`). citeturn0search5  
- They come preconfigured with common tools, are automatically patched, and are ephemeral (clean slate each job). citeturn0search4  
- Perfect if you want minimal setup and don’t want to manage infrastructure. citeturn0search1

**2. Self-Hosted Runners**  
- You **install and manage** these yourself on your own machines (local, data center, or cloud). citeturn0search6  
- Provides full control over the OS, installed software, hardware specs, and networking. citeturn0search18  
- Useful if you need **specific environments**, compliance restrictions, or have heavy compute needs. citeturn0search1  
- However, you’re responsible for upgrades, security, availability, and scaling. citeturn0search1

### How They Work
- GitHub Actions workflows define jobs with steps. When triggered, GitHub dispatches the job to an available runner. citeturn0search5  
- On GitHub-hosted runners, jobs run on fresh VMs or containers. citeturn0search0  
- On self-hosted runners, you register the machine to your repo/org, and it listens for jobs to run. citeturn0search6

### Choosing Between Them
- **GitHub-hosted** → fastest setup, no infrastructure to maintain. citeturn0search1  
- **Self-hosted** → max control, potential cost savings on heavy usage, but more operational responsibility. citeturn0search1

In summary, runners are the execution engines for GitHub Actions workflows, and you choose between GitHub-managed or self-managed environments depending on control, cost, and complexity needs. citeturn0search2

---

## User

cost on private vs oublic repo

---

## Assistant

Here’s how **GitHub Actions costs differ between public and private repositories** (simple, factual breakdown):

### 🆓 **Public Repositories**
- Standard GitHub-hosted runners: **completely free (unlimited minutes)** for workflows running on public repos. There’s *no billing for compute minutes or orchestration*. citeturn0search0turn0search18
- Self-hosted runners: also **free** for public repos — no platform charge applies. citeturn0search9

**Summary:** CI/CD on public repos doesn’t generate a GitHub bill for Actions minutes. citeturn0search21

---

### 💼 **Private Repositories**
Costs depend on runner type and your plan:

#### 📌 1. *GitHub-Hosted Runners*
- You get a **quota of free minutes per month** based on your plan:
  - Free/Pro: ~2,000–3,000 minutes/mo
  - Team: ~3,000 minutes/mo
  - Enterprise Cloud: ~50,000 minutes/mo  
  These free minutes apply to private-repo workflows on standard runners. citeturn0search6
- If you exceed the free minutes, you are billed **per minute** for additional usage at published rates (varies by runner OS/size). citeturn0search0

> Example (illustrative, pre-2026 prices):  
> Linux might be ~\$0.008/min, Windows ~\$0.016/min (these are rough historic figures). citeturn0search14

#### 📌 2. *Self-Hosted Runners*
- Historically free, but **starting March 1 2026**, GitHub will charge a **$0.002 per-minute *platform fee*** for workflows running on self-hosted runners in private repos (this covers GitHub’s orchestration, scheduling, logging, etc.). citeturn0search7turn0search15
- That fee **counts against your plan’s included free minutes first**, then overage billing applies. citeturn0search16
- You also still pay for your own infrastructure costs separately (cloud/servers). citeturn0search7

---

### 📌 Key Takeaways
- **Public repos:** GitHub Actions minutes are fully free on both hosted and self-hosted runners (no bill). citeturn0search0  
- **Private repos:** You get a monthly free minutes quota. Beyond that, GitHub-hosted minutes cost money, and self-hosted runners now incur a platform charge ($0.002/min) starting 2026. citeturn0search7

If you’d like precise dollar estimates for a specific volume of CI runs (build time + minutes), tell me your expected usage and runner types and I can calculate it.

---

## User

any reason or company shouldnt use a public repo to save cash?

---

## Assistant

Yes. There are multiple **serious reasons** a company should not switch to a public repo just to save on GitHub Actions costs.

---

## 1️⃣ Intellectual Property Risk

Using a public repo means:

- Source code is visible to everyone  
- Competitors can inspect architecture and business logic  
- Proprietary algorithms and trade secrets are exposed  

If your code is a competitive advantage, this alone makes public repos a non-starter.

Example: Companies like entity["company","Stripe","us payments company"] or entity["company","Snowflake","data cloud company"] would never expose core infrastructure code.

---

## 2️⃣ Security Surface Area

Public repos:
- Attract automated scanning and vulnerability probing  
- Increase social engineering attack attempts  
- Expose dependency graph publicly  

Even if security is strong, visibility increases attack attempts.

---

## 3️⃣ Compliance & Legal Exposure

Many companies must comply with:
- SOC 2  
- HIPAA  
- PCI-DSS  
- GDPR  

Public repos can create compliance conflicts, especially if:
- Secrets are accidentally committed  
- Internal configs leak  
- Client-specific code is visible  

For regulated industries, private repos are mandatory.

---

## 4️⃣ Trade Secret Protection

Once code is public:
- It may no longer qualify as a trade secret  
- Future patent filings can be compromised  
- Licensing becomes complex  

You cannot “un-public” exposure in practical terms.

---

## 5️⃣ Signal to Customers & Investors

Investors often expect:
- Strong IP protection  
- Controlled code access  
- Professional infrastructure governance  

Public repos for core product code can signal immaturity in certain sectors.

---

## 6️⃣ Cost Savings Are Often Marginal

For private repos:
- GitHub gives included minutes  
- Linux runners are inexpensive  
- Self-hosted runners can reduce compute costs significantly  

For many startups, CI cost is tiny compared to payroll, cloud infra, or tooling.

Example:
Even 20,000 Linux minutes/month is often < $200.

That is trivial compared to IP risk.

---

## When Public *Does* Make Sense

Public repos are rational when:

- Open source is part of strategy  
- Community adoption drives growth  
- The moat is distribution, brand, or data — not code  

Examples:
- entity["company","HashiCorp","infrastructure software company"] (originally open core)  
- entity["company","Red Hat","enterprise linux company"]  
- entity["company","Elastic","search company"]  

---

## Blunt Conclusion

If your company:
- Has proprietary software
- Plans to monetize that software
- Relies on unique implementation

Then using a public repo purely to save CI money is almost always a bad trade.

You’re risking strategic assets to save what is typically a rounding error.

---

If you'd like, tell me:
- What stage your company is in  
- Rough monthly CI minutes  
- Whether your moat is code vs distribution  

I can give you a sharper recommendation.


## See Also
- [[chatgpt/chatgpt_github-self-hosted-runners]]
- [[chatgpt/chatgpt_paid-ci-runners-github]]
- [[chatgpt/chatgpt_github-pr-tasks-explained]]
- [[chatgpt/chatgpt_ai-elements-explained]]
- [[chatgpt/chatgpt_ai-test-writing-explained]]
