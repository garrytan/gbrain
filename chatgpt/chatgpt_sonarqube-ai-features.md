---
title: "SonarQube AI Features"
type: guide
created: 2025-12-30
updated: 2025-12-30
source: chatgpt-export
conversation_id: 6953549d-2354-832d-a0e4-e4513893c832
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# SonarQube AI Features

> Conversation ID: 6953549d-2354-832d-a0e4-e4513893c832
> Created: 2025-12-30T04:27:09Z
> Updated: 2025-12-30T04:29:02Z
> Messages: 6

---

## User

sonarqube an ai

---

## Assistant

Yes — **SonarQube includes AI-related capabilities** to help developers maintain and improve code quality, especially when using AI-generated or AI-assisted code.citeturn0search0turn0search1

**Key AI features in SonarQube:**

- **AI CodeFix:** SonarQube can use large language models (LLMs) such as **OpenAI’s GPT-4(o)** or **Anthropic’s Claude Sonnet 4** to generate suggested code fixes for issues found by SonarQube’s analysis engine. These suggestions aim to resolve bugs or security issues while retaining the original functionality.citeturn0search12turn0search21

- **AI Code Assurance:** This feature focuses on **verifying and managing AI-generated code**. It can tag or autodetect AI-generated code in your projects, apply stricter quality gates and standards for such code, and ensure it meets your team’s security and maintainability requirements before merging or deployment.citeturn0search0turn0search1

- **IDE and AI agent integration:** SonarQube supports tools that connect your IDE and AI code assistants (e.g., Copilot or other agents), letting you trigger SonarQube checks or AI fix suggestions directly while you code.citeturn0search5

**What SonarQube *is***  
SonarQube itself is primarily a **static code analysis platform** that finds bugs, vulnerabilities, code smells, and maintainability issues across 30+ languages, integrates into CI/CD pipelines, and enforces quality gates. The recent AI features extend that by assisting with fixes and managing AI-generated code quality.citeturn0search27

In short:  
- It **uses AI (LLMs) for automated fix suggestions**.citeturn0search12  
- It provides **quality assurance workflows for AI-generated code**.citeturn0search0  
- Its core analysis (static code analysis) isn’t itself generative AI, but the new AI tools augment that process.citeturn0search27

If you want, I can break down how to enable and use these AI features in SonarQube Server or Cloud.

---

## User

i have sonarqube scanning my repo and tons of fixes i want to trigger ai agents to fix. whats the best workflow

---

## Assistant

Mr. White, here’s the **most effective, low-friction workflow** to use AI agents to fix large volumes of SonarQube findings **without destroying code quality or velocity**.

---

## Best-Practice Workflow for AI-Fixing SonarQube Issues

### 1. **Treat SonarQube as the source of truth**
Use **entity["organization","SonarQube","static code analysis platform"]** (or SonarQube Cloud) strictly for:
- Issue detection
- Severity classification
- Quality Gates (pass/fail)

Do **not** let the AI “freestyle” fixes without Sonar rules as constraints.

---

### 2. **Batch issues by type, not by file**
This is critical.

Create fix batches like:
- One batch = *NullPointer risks*
- One batch = *SQL injection*
- One batch = *Cognitive complexity*
- One batch = *Unused variables*

Why:
- LLMs perform best on **homogeneous transformations**
- Reduces regression risk
- Easier review and rollback

---

### 3. **Use AI only for “safe” categories first**
Start with:
- Code smells
- Minor bugs
- Duplication
- Style violations
- Low-risk refactors

Avoid initially:
- Auth logic
- Crypto
- Concurrency
- Financial calculations

This keeps blast radius low.

---

### 4. **Trigger AI fixes locally, not directly in CI**
Recommended pattern:

1. Developer (or bot) pulls a branch
2. Run SonarQube scan → export issues
3. AI agent applies fixes locally
4. Re-run SonarQube
5. Commit only **net-improving diffs**

Never let AI push directly to `main`.

---

### 5. **Use Sonar’s AI CodeFix where available**
If you’re on newer versions:
- Enable **AI CodeFix**
- Let Sonar propose fixes
- Accept selectively

Sonar’s fixes are **rule-aware**, which generic agents are not.

---

### 6. **Wire an AI agent with hard constraints**
If using Copilot, Cursor, Claude, or custom GPT:

Your system prompt must include:
- “Fix only SonarQube-reported issues”
- “Do not change behavior”
- “Do not refactor beyond the rule”
- “One issue per change”

This massively improves correctness.

---

### 7. **One PR per issue class**
Example:
- PR 1: “Fix all S2259 null dereference issues”
- PR 2: “Reduce cognitive complexity >15”

Benefits:
- Fast review
- Easy revert
- Clean audit trail

---

### 8. **Lock in gains with Quality Gates**
After cleanup:
- Enforce **zero new issues**
- Especially for AI-generated code paths
- This prevents regressions permanently

---

## TL;DR (Optimal Setup)
- SonarQube finds issues
- AI fixes **small, typed batches**
- Humans review diffs
- SonarQube re-verifies
- Quality Gates prevent backsliding

This is the workflow used successfully in large Java, TypeScript, and Python codebases with tens of thousands of findings.

If you want, I can:
- Design a **bot-driven PR workflow**
- Write a **Cursor / Claude / GPT prompt**
- Map this to **GitHub Actions or GitLab CI**

Just say which stack you’re on.

---

## User

can i run it in cli?

---

## Assistant

Yes, Mr. White — **you can run the entire workflow from the CLI**, and that’s the **correct way** to do this at scale.

Below is the **clean, production-grade CLI workflow**.

---

## What Runs in CLI (and What Doesn’t)

### ✅ CLI-native
- **entity["organization","SonarQube","static code analysis platform"] scan**
- Issue export (API)
- AI agent execution
- Re-scan + verification
- Git commits / PRs

### ❌ Not CLI-native (yet)
- Sonar’s built-in **AI CodeFix UI**  
  (that one lives in the web UI only)

So for **mass automated fixing**, CLI + external AI agent is the right answer.

---

## Canonical CLI Workflow

### 1. Run SonarQube scan
```bash
sonar-scanner \
  -Dsonar.projectKey=my-project \
  -Dsonar.sources=. \
  -Dsonar.host.url=https://sonar.mycompany.com \
  -Dsonar.token=$SONAR_TOKEN
```

Uses **entity["organization","SonarScanner","sonarqube cli scanner"]**.

---

### 2. Export issues via Sonar API
Example (JSON output):
```bash
curl -s -u $SONAR_TOKEN: \
  "https://sonar.mycompany.com/api/issues/search?projectKeys=my-project&types=BUG,CODE_SMELL&ps=500" \
  > sonar-issues.json
```

You now have **machine-readable fix targets**.

---

### 3. Slice issues by rule (critical step)
Example:
```bash
jq '.issues[] | select(.rule=="java:S2259")' sonar-issues.json > null-deref.json
```

This is what makes AI reliable.

---

### 4. Run AI agent from CLI
Examples:
- OpenAI / Claude via script
- Cursor headless
- Custom agent loop

Pattern:
```bash
ai-fix \
  --rule java:S2259 \
  --issues null-deref.json \
  --repo .
```

**Hard constraints for the agent:**
- Fix only the listed issue
- No behavior changes
- No refactors beyond the rule
- One issue at a time

---

### 5. Re-run SonarQube
```bash
sonar-scanner
```

Fail the run if:
- New issues appear
- Severity increases
- Coverage drops

---

### 6. Commit + PR
```bash
git checkout -b fix/java-s2259-null-deref
git commit -am "Fix Sonar rule java:S2259 (null dereference)"
git push origin fix/java-s2259-null-deref
```

---

## Recommended Automation Pattern
**Nightly or on-demand**
- Bot opens PRs per rule
- Max 1 rule per PR
- Auto-close if scan regresses

This scales to **10k–100k issues safely**.

---

## Summary
- ✔ Fully CLI-driven
- ✔ Deterministic
- ✔ CI-friendly
- ✔ Human-reviewable
- ✔ Safe for large codebases

If you want, I can:
- Provide a **ready-to-run Bash/Python script**
- Generate a **battle-tested AI prompt**
- Wire this into **GitHub Actions / GitLab CI**

Say the word and your stack.
