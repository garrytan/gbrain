---
title: "GitHub Self-Hosted Runners"
type: note
created: 2026-02-23
updated: 2026-02-23
source: chatgpt-export
conversation_id: 699cdc46-5cf4-8328-ab75-d9d74dcb8564
message_count: 2
tags: [chatgpt, import, code]
---
# GitHub Self-Hosted Runners

> Conversation ID: 699cdc46-5cf4-8328-ab75-d9d74dcb8564
> Created: 2026-02-23T23:01:26Z
> Updated: 2026-02-23T23:02:05Z
> Messages: 2

---

## User

github self hosted runers

---

## Assistant

**GitHub Self-Hosted Runners – Quick Overview**

A **self-hosted runner** for GitHub Actions is a machine (physical, VM, container, cloud instance, etc.) that you configure and manage yourself to run jobs from your GitHub workflows. Instead of using GitHub’s hosted runners, your infrastructure executes your CI/CD workflows. citeturn0search0turn0search26

### What They Are
- A **runner** is the agent that executes jobs defined in your `.github/workflows/*.yml` files. citeturn0search29  
- A **self-hosted runner** is hosted on your own hardware/cloud, not by GitHub. citeturn0search0  
- It **connects outbound to GitHub** to receive jobs and keeps that connection open. citeturn0search24

### Why Use Them
**Pros**
- Full control over hardware, OS, installed tools, networking, and storage. citeturn0search28  
- Useful for builds requiring specific environments not offered by GitHub hosted runners. citeturn0search28  
- Can reduce compute cost if you have idle capacity. citeturn0search5

**Cons/Considerations**
- You must manage, secure, and scale the infrastructure yourself. citeturn0search17  
- Exposes your environment to code executed from GitHub workflows (security risk if untrusted code runs). citeturn0search18  

### Levels Where You Can Add Them
- **Repository level** — runner only serves one repo. citeturn0search35  
- **Organization level** — runner serves multiple repos under an org. citeturn0search35  
- **Enterprise level** — central runner pool across many orgs. citeturn0search42

### How to Set One Up (High Level)
1. In your GitHub repo or org: go to **Settings → Actions → Runners**. citeturn0search1  
2. Click **New self-hosted runner** and choose OS/architecture. citeturn0search1  
3. Download and extract the provided runner package on your machine. citeturn0search7  
4. Run the provided **config** script with the URL/token to register the runner. citeturn0search7  
5. Start the runner (often via a service script). citeturn0search4

Once running, workflows specifying `runs-on: self-hosted` (optionally with labels) will dispatch jobs to your runner. citeturn0search31

### Example Workflow Snippet
```yaml
jobs:
  build:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v3
      - run: echo "Running on my own runner"
```

### Best Practice Notes
- Keep your runner updated; it periodically auto-updates itself. citeturn0search9  
- Plan security hardening since workflows run code you host. citeturn0search18  
- Label runners to control which jobs land on which machines. citeturn0search16

If you want instructions tailored to a specific OS (Linux/Windows/macOS) or deployment environment (e.g., Kubernetes, cloud autoscaling), let me know.


## See Also
- [[chatgpt/chatgpt_github-runners-explained]]
- [[chatgpt/chatgpt_paid-ci-runners-github]]
- [[chatgpt/chatgpt_allow-claude-biom-github]]
- [[chatgpt/chatgpt_building-a-github-action]]
- [[chatgpt/chatgpt_fastlane-match-github-token]]
