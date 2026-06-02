---
title: "Paid CI Runners GitHub"
type: note
created: 2026-02-23
updated: 2026-02-23
source: chatgpt-export
conversation_id: 699cb9f4-53d4-8327-836e-9db7eada7fc7
message_count: 4
tags: [chatgpt, import]
---
# Paid CI Runners GitHub

> Conversation ID: 699cb9f4-53d4-8327-836e-9db7eada7fc7
> Created: 2026-02-23T20:35:13Z
> Updated: 2026-02-23T20:35:32Z
> Messages: 4

---

## User

paid ci runners github

---

## Assistant

Here’s a clear summary of **paid CI runners on GitHub (GitHub Actions)**:

### 1) **GitHub-hosted runners (built-in CI)**
- These are the default runners that GitHub provides to execute your workflows.
- For **public repositories**, their use is **free**. citeturn0search0
- For **private repositories**, you get a monthly minutes quota based on your plan (e.g., Free, Pro, Team, Enterprise). Minutes beyond that quota are billed. citeturn0search0turn0search11
- There are **per-minute rates** for different runner sizes/OS when billed beyond quota: Linux/Windows/macOS have increasing costs based on CPU and features (e.g., GPU runners cost more). citeturn0search5

### 2) **Self-hosted runners**
- Traditionally, you could self-host runners on your own infrastructure with **no GitHub per-minute charge**; you just paid for your own compute. citeturn0search0
- GitHub *planned* to introduce a **$0.002 per minute “platform fee”** for self-hosted runner usage in private repos starting March 2026. This fee applies even though you supply the hardware/compute. citeturn0search8turn0search15
- This change means two cost components:
  1. Your own compute cost (e.g., cloud/servers)  
  2. GitHub’s actions control-plane charge per minute. citeturn0search14
- **Public repositories** remain free for self-hosted usage. citeturn0search0

### 3) Summary of how billing works
- **Hosted runner costs:** Billed per minute when you exceed free quotas on private repos. citeturn0search0
- **Self-hosted costs:** Historically free other than your own infrastructure; a platform fee may be introduced (was being evaluated for March 2026). citeturn0search26
- **Public open-source workflows:** Free for both hosted and self-hosted runners. citeturn0search0

If you want exact minute costs for a specific runner type (e.g., macOS vs. Linux), I can list that too.

---

## User

whats the concurrent limit on runners on a public repo

---

## Assistant

For **GitHub Actions on public repositories**, there *is* a concurrency limit — even though minutes are free, you can’t run *unlimited* jobs in parallel. citeturn0search8

**Concurrent job limits (default GitHub-hosted runners):**
- **Up to ~20 concurrent jobs per repository by default on the free tier.** If you exceed that, additional jobs queue until runners free up. citeturn0search8

**Notes:**
- That limit applies per **repository** for standard GitHub-hosted runners. citeturn0search8
- Larger or organization plans can increase concurrency (e.g., Pro/Team/Enterprise) but public repos still follow those defaults unless org account settings override them. citeturn0search6

If you need higher concurrency than the default, you can look into **GitHub Enterprise with larger runner autoscaling** or use **self-hosted runners** to add parallel capacity. citeturn0search6
