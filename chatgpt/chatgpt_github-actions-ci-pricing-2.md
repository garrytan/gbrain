---
title: "GitHub Actions CI Pricing"
type: guide
created: 2026-01-18
updated: 2026-01-18
source: chatgpt-export
conversation_id: 696c412b-6174-832a-87b6-9bede3a864be
message_count: 4
tags: [chatgpt, import, code]
---
# GitHub Actions CI Pricing

> Conversation ID: 696c412b-6174-832a-87b6-9bede3a864be
> Created: 2026-01-18T02:10:51Z
> Updated: 2026-01-18T02:11:45Z
> Messages: 4

---

## User

how much is githubs actions on CI on a public repo

---

## Assistant

**GitHub Actions CI on a *public* repository is free.**  

- Workflows running on **standard GitHub-hosted runners** in public repos incur **no charges and no minute limits**. citeturn0search0turn0search12  
- Self-hosted runners for public repos also remain free of GitHub billing (you only pay for your own infrastructure). citeturn0search0  
- Recent pricing updates (2026) introduce a $0.002/minute platform fee on Actions usage *for private repos or self-hosted runners in private contexts*, but public repo usage is unaffected. citeturn0search1turn0search18  

**Summary:**  
✅ **Public repos:** Unlimited, free CI minutes on standard GitHub Actions runners. citeturn0search0  
❗ Paid charges apply only for private repos beyond their included quota or for certain advanced runners/configurations. citeturn0search1

If you want exact details on limits for private repos or runner tiers, I can provide those too.

---

## User

im running out of memmor on unit tests they run like 12 minutes and then error out on emory

---

## Assistant

Mr. White,

If your **GitHub Actions unit tests run ~12 minutes and then OOM**, this is almost always **memory pressure + leaks or parallelism**, not GitHub “being slow”.

### Facts first (GitHub Actions limits)
- **Standard GitHub-hosted runner (ubuntu-latest)**  
  - **7 GB RAM**
  - **2 vCPU**
- When memory is exhausted, the kernel **kills the process** → opaque OOM failure.

---

## High-probability causes (ranked)
1. **Test parallelism too high** (Jest, pytest-xdist, Go test, etc.)
2. **Memory leaks across test files** (DB connections, globals, caches)
3. **One huge test suite in a single job** (no process reset)
4. **Coverage + transpilation + test in one step**
5. **Docker-in-Docker** inside Actions (very memory expensive)

---

## Immediate fixes (do these first)

### 1. Reduce test workers (biggest win)
Examples:
- **Jest**
```bash
jest --runInBand
# or
jest --maxWorkers=50%
```

- **pytest**
```bash
pytest -n 2
# or temporarily:
pytest -n 1
```

- **Go**
```bash
go test -p 1 ./...
```

If it passes with 1 worker → you’ve confirmed memory saturation.

---

### 2. Split tests into multiple jobs
Each job gets a **fresh 7 GB RAM pool**.

```yaml
strategy:
  matrix:
    shard: [1, 2, 3]

steps:
  - run: npm test -- --shard=${{ matrix.shard }}/3
```

This is **objectively better** than one long job.

---

### 3. Disable coverage in CI (or run it separately)
Coverage often adds **30–60% memory overhead**.

```bash
NODE_ENV=test jest --coverage=false
```

Or:
- One job = tests
- One job = coverage (shorter subset)

---

### 4. Force GC / teardown between test files
Especially for Node / Python.

**Node**
```bash
node --expose-gc
global.gc();
```

**Python**
```python
import gc
gc.collect()
```

If memory usage grows monotonically, you have leaks.

---

## Structural fixes (next tier)

### 5. Use larger runners (paid, but deterministic)
```yaml
runs-on: ubuntu-latest
# replace with
runs-on: ubuntu-22.04-8core
```

Gives:
- **16+ GB RAM**
- Much higher reliability

This is the cleanest fix for large suites.

---

### 6. Move DB / heavy integration tests to separate workflow
Unit tests should be **fast + isolated**.
Integration tests:
- Separate job
- Separate trigger
- Lower frequency

---

## How to confirm the root cause
Add this step before failure:
```bash
free -h
ps aux --sort=-%mem | head -20
```

If memory steadily climbs → leak.  
If memory spikes near the end → parallelism.

---

### Bottom line
- **7 GB RAM is the hard ceiling**
- **Reduce parallelism or shard jobs**
- **Coverage + parallel tests is the usual killer**
- Paying for bigger runners is rational once the suite grows

If you tell me:
- Language
- Test runner
- Whether Docker is involved  

I’ll give you a **specific, minimal fix**.


**Topic:** [[chatgpt-clusters/business_startup]]
