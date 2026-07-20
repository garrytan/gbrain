---
name: context-mode
description: |
  Use context-mode tools (ctx_execute, ctx_execute_file) instead of Bash/cat when processing
  large outputs. Triggers: "analyze logs", "summarize output", "process data",
  "parse JSON", "filter results", "extract errors", "check build output",
  "analyze dependencies", "process API response", "large file analysis",
  "page snapshot", "browser snapshot", "DOM structure", "inspect page",
  "accessibility tree", "Playwright snapshot",
  "run tests", "test output", "coverage report", "git log", "recent commits",
  "diff between branches", "list containers", "pod status", "disk usage",
  "fetch docs", "API reference", "index documentation",
  "call API", "check response", "query results",
  "find TODOs", "count lines", "codebase statistics", "security audit",
  "outdated packages", "dependency tree", "cloud resources", "CI/CD output".
  Also triggers on ANY MCP tool output that may exceed 20 lines.
  Subagent routing is handled automatically via PreToolUse hook.
---

# Context Mode: Default for All Large Output

## MANDATORY RULE

<context_mode_logic>
  <mandatory_rule>
    Default to context-mode for ALL commands. Only use Bash for guaranteed-small-output operations.
  </mandatory_rule>
</context_mode_logic>

Bash whitelist (safe to run directly):
- **File mutations**: `mkdir`, `mv`, `cp`, `rm`, `touch`, `chmod`
- **Git writes**: `git add`, `git commit`, `git push`, `git checkout`, `git branch`, `git merge`
- **Navigation**: `cd`, `pwd`, `which`
- **Process control**: `kill`, `pkill`
- **Package management**: `npm install`, `npm publish`, `pip install`
- **Simple output**: `echo`, `printf`

**Everything else → `ctx_execute` or `ctx_execute_file`.** Any command that reads, queries, fetches, lists, logs, tests, builds, diffs, inspects, or calls an external service. This includes ALL CLIs (gh, aws, kubectl, docker, terraform, wrangler, fly, heroku, gcloud, etc.) — there are thousands and we cannot list them all.

**When uncertain, use context-mode.** Every KB of unnecessary context reduces the quality and speed of the entire session.

## Decision Tree

```
About to run a command / read a file / call an API?
│
├── Command is on the Bash whitelist (file mutations, git writes, navigation, echo)?
│   └── Use Bash
│
├── Output MIGHT be large or you're UNSURE?
│   └── Use context-mode ctx_execute or ctx_execute_file
│
├── Fetching web documentation or HTML page?
│   └── Use ctx_fetch_and_index → ctx_search
│
├── Using Playwright (navigate, snapshot, console, network)?
│   └── ALWAYS use filename parameter to save to file, then:
│       browser_snapshot(filename) → ctx_index(path) or ctx_execute_file(path)
│       browser_console_messages(filename) → ctx_execute_file(path)
│       browser_network_requests(filename) → ctx_execute_file(path)
│       ⚠ browser_navigate returns a snapshot automatically — ignore it,
│         use browser_snapshot(filename) for any inspection.
│       ⚠ Playwright MCP uses a SINGLE browser instance — NOT parallel-safe.
│         For parallel browser ops, use agent-browser via execute instead.
│
├── Using agent-browser (parallel-safe browser automation)?
│   └── Run via execute (shell) — each call gets its own subprocess:
│       execute("agent-browser open example.com && agent-browser snapshot -i -c")
│       ✓ Supports sessions for isolated browser instances
│       ✓ Safe for parallel subagent execution
│       ✓ Lightweight accessibility tree with ref-based interaction
│
├── Processing output from another MCP tool (Context7, GitHub API, etc.)?
│   ├── Output already in context from a previous tool call?
│   │   └── Use it directly. Do NOT re-index with ctx_index(content: ...).
│   ├── Need to search the output multiple times?
│   │   └── Save to file via ctx_execute, then ctx_index(path) → ctx_search
│   └── One-shot extraction?
│       └── Save to file via ctx_execute, then ctx_execute_file(path)
│
└── Reading a file to analyze/summarize (not edit)?
    └── Use ctx_execute_file (file loads into FILE_CONTENT, not context)
```

## When to Use Each Tool

| Situation | Tool | Example |
|-----------|------|---------|
| Hit an API endpoint | `ctx_execute` | `fetch('http://localhost:3000/api/orders')` |
| Run CLI that returns data | `ctx_execute` | `gh pr list`, `aws s3 ls`, `kubectl get pods` |
| Run tests | `ctx_execute` | `npm test`, `pytest`, `go test ./...` |
| Git operations | `ctx_execute` | `git log --oneline -50`, `git diff HEAD~5` |
| Docker/K8s inspection | `ctx_execute` | `docker stats --no-stream`, `kubectl describe pod` |
| Read a log file | `ctx_execute_file` | Parse access.log, error.log, build output |
| Read a data file | `ctx_execute_file` | Analyze CSV, JSON, YAML, XML |
| Read source code to analyze | `ctx_execute_file` | Count functions, find patterns, extract metrics |
| Fetch web docs | `ctx_fetch_and_index` | Index React/Next.js/Zod docs, then search |
| Playwright snapshot | `browser_snapshot(filename)` → `ctx_index(path)` → `ctx_search` | Save to file, index server-side, query |
| Playwright snapshot (one-shot) | `browser_snapshot(filename)` → `ctx_execute_file(path)` | Save to file, extract in sandbox |
| Playwright console/network | `browser_*(filename)` → `ctx_execute_file(path)` | Save to file, analyze in sandbox |
| MCP output (already in context) | Use directly | Don't re-index — it's already loaded |
| MCP output (need multi-query) | `ctx_execute` to save → `ctx_index(path)` → `ctx_search` | Save to file first, index server-side |
| Wipe indexed KB content | `ctx_purge(confirm: true)` | Permanently deletes all indexed content |

## Automatic Triggers

Use context-mode for ANY of these, without being asked:

- **API debugging**: "hit this endpoint", "call the API", "check the response", "find the bug in the response"
- **Log analysis**: "check the logs", "what errors", "read access.log", "debug the 500s"
- **Test runs**: "run the tests", "check if tests pass", "test suite output"
- **Git history**: "show recent commits", "git log", "what changed", "diff between branches"
- **Data inspection**: "look at the CSV", "parse the JSON", "analyze the config"
- **Infrastructure**: "list containers", "check pods", "S3 buckets", "show running services"
- **Dependency audit**: "check dependencies", "outdated packages", "security audit"
- **Build output**: "build the project", "check for warnings", "compile errors"
- **Code metrics**: "count lines", "find TODOs", "function count", "analyze codebase"
- **Web docs lookup**: "look up the docs", "check the API reference", "find examples"

## Language Selection

| Situation | Language | Why |
|-----------|----------|-----|
| HTTP/API calls, JSON | `javascript` | Native fetch, JSON.parse, async/await |
| Data analysis, CSV, stats | `python` | csv, statistics, collections, re |
| Shell commands with pipes | `shell` | grep, awk, jq, native tools |
| File pattern matching | `shell` | find, wc, sort, uniq |

## Search Query Strategy

- BM25 uses **OR semantics** — results matching more terms rank higher automatically
- Use 2-4 specific technical terms per query
- **Always use `source` parameter** when multiple docs are indexed to avoid cross-source contamination
  - Partial match works: `source: "Node"` matches `"Node.js v22 CHANGELOG"`
- **Always use `queries` array** — batch ALL search questions in ONE call:
  - `ctx_search(queries: ["transform pipe", "refine superRefine", "coerce codec"], source: "Zod")`
  - NEVER make multiple separate ctx_search() calls — put all queries in one array

## External Documentation

- **Always use `ctx_fetch_and_index`** for external docs — NEVER `cat` or `ctx_execute` with local paths for packages you don't own
- For GitHub-hosted projects, use the raw URL: `https://raw.githubusercontent.com/org/repo/main/CHANGELOG.md`
- After indexing, use the `source` parameter in search to scope results to that specific document

## Critical Rules

1. **Always console.log/print your findings.** stdout is all that enters context. No output = wasted call.
2. **Write analysis code, not just data dumps.** Don't `console.log(JSON.stringify(data))` — analyze first, print findings.
3. **Be specific in output.** Print bug details with IDs, line numbers, exact values — not just counts.
4. **For files you need to EDIT**: Use the normal Read tool. context-mode is for analysis, not editing.
5. **For Bash whitelist commands only**: Use Bash for file mutations, git writes, navigation, process control, package install, and echo. Everything else goes through context-mode.
6. **Never use `ctx_index(content: large_data)`.** Use `ctx_index(path: ...)` to read files server-side. The `content` parameter sends data through context as a tool parameter — use it only for small inline text.
7. **Always use `filename` parameter** on Playwright tools (`browser_snapshot`, `browser_console_messages`, `browser_network_requests`). Without it, the full output enters context.
8. **Don't re-index data already in context.** If an MCP tool returned data in a previous response, it's already loaded — use it directly or save to file first.

## Sandboxed Data Workflow

<sandboxed_data_workflow>
  <critical_rule>
    When using tools that support saving to a file: ALWAYS use the 'filename' parameter.
    NEVER return large raw datasets directly to context.
  </critical_rule>
  <workflow>
    LargeDataTool(filename: "path") → mcp__context-mode__ctx_index(path: "path") → ctx_search()
  </workflow>
</sandboxed_data_workflow>

This is the universal pattern for context preservation regardless of
the source tool (Playwright, GitHub API, AWS CLI, etc.).

## Examples

### Debug an API endpoint
```javascript
const resp = await fetch('http://localhost:3000/api/orders');
const { orders } = await resp.json();

const bugs = [];
const negQty = orders.filter(o => o.quantity < 0);
if (negQty.length) bugs.push(`Negative qty: ${negQty.map(o => o.id).join(', ')}`);

const nullFields = orders.filter(o => !o.product || !o.customer);
if (nullFields.length) bugs.push(`Null fields: ${nullFields.map(o => o.id).join(', ')}`);

console.log(`${orders.length} orders, ${bugs.length} bugs found:`);
bugs.forEach(b => console.log(`- ${b}`));
```

### Analyze test output
```shell
npm test 2>&1
echo "EXIT=$?"
```

### Check GitHub PRs
```shell
gh pr list --json number,title,state,reviewDecision --jq '.[] | "\(.number) [\(.state)] \(.title) — \(.reviewDecision // "no review")"'
```

### Read and analyze a large file
```python
# FILE_CONTENT is pre-loaded by ctx_execute_file
import json
data = json.loads(FILE_CONTENT)
print(f"Records: {len(data)}")
# ... analyze and print findings
```

## Browser & Playwright Integration

**When a task involves Playwright snapshots, screenshots, or page inspection, ALWAYS route through file → sandbox.**

Playwright `browser_snapshot` returns 10K–135K tokens of accessibility tree data. Calling it without `filename` dumps all of that into context. Passing the output to `ctx_index(content: ...)` sends it into context a SECOND time as a parameter. Both are wrong.

**The key insight**: `browser_snapshot` has a `filename` parameter that saves to file instead of returning to context. `ctx_index` has a `path` parameter that reads files server-side. `ctx_execute_file` processes files in a sandbox. **None of these touch context.**

### Workflow A: Snapshot → File → Index → Search (multiple queries)

```
Step 1: browser_snapshot(filename: "/tmp/playwright-snapshot.md")
        → saves to file, returns ~50B confirmation (NOT 135K tokens)

Step 2: ctx_index(path: "/tmp/playwright-snapshot.md", source: "Playwright snapshot")
        → reads file SERVER-SIDE, indexes into FTS5, returns ~80B confirmation

Step 3: ctx_search(queries: ["login form email password"], source: "Playwright")
        → returns only matching chunks (~300B)
```

**Total context: ~430B** instead of 270K tokens. Real 99% savings.

### Workflow B: Snapshot → File → Execute File (one-shot extraction)

```
Step 1: browser_snapshot(filename: "/tmp/playwright-snapshot.md")
        → saves to file, returns ~50B confirmation

Step 2: ctx_execute_file(path: "/tmp/playwright-snapshot.md", language: "javascript", code: "
          const links = [...FILE_CONTENT.matchAll(/- link \"([^\"]+)\"/g)].map(m => m[1]);
          const buttons = [...FILE_CONTENT.matchAll(/- button \"([^\"]+)\"/g)].map(m => m[1]);
          const inputs = [...FILE_CONTENT.matchAll(/- textbox|- checkbox|- radio/g)];
          console.log('Links:', links.length, '| Buttons:', buttons.length, '| Inputs:', inputs.length);
          console.log('Navigation:', links.slice(0, 10).join(', '));
        ")
        → processes in sandbox, returns ~200B summary
```

**Total context: ~250B** instead of 135K tokens.

### Workflow C: Console & Network (save to file if large)

```
browser_console_messages(level: "error", filename: "/tmp/console.md")
→ ctx_execute_file(path: "/tmp/console.md", ...) or ctx_index(path: "/tmp/console.md", ...)

browser_network_requests(includeStatic: false, filename: "/tmp/network.md")
→ ctx_execute_file(path: "/tmp/network.md", ...) or ctx_index(path: "/tmp/network.md", ...)
```

### CRITICAL: Why `filename` + `path` is mandatory

| Approach | Context cost | Correct? |
|----------|-------------|----------|
| `browser_snapshot()` → raw into context | **135K tokens** | NO |
| `browser_snapshot()` → `ctx_index(content: raw)` | **270K tokens** (doubled!) | NO |
| `browser_snapshot(filename)` → `ctx_index(path)` → `ctx_search` | **~430B** | YES |
| `browser_snapshot(filename)` → `ctx_execute_file(path)` | **~250B** | YES |

### Key Rule

> **ALWAYS use `filename` parameter when calling `browser_snapshot`, `browser_console_messages`, or `browser_network_requests`.**
> Then process via `ctx_index(path: ...)` or `ctx_execute_file(path: ...)` — never `ctx_index(content: ...)`.
>
> Data flow: **Playwright → file → server-side read → context**. Never: **Playwright → context → ctx_index(content) → context again**.

## Subagent Usage

Subagents automatically receive context-mode tool routing via a PreToolUse hook. You do NOT need to manually add tool names to subagent prompts — the hook injects them. Just write natural task descriptions.

## Anti-Patterns

- Using `curl http://api/endpoint` via Bash → 50KB floods context. Use `ctx_execute` with fetch instead.
- Using `cat large-file.json` via Bash → entire file in context. Use `ctx_execute_file` instead.
- Using `gh pr list` via Bash → raw JSON in context. Use `ctx_execute` with `--jq` filter instead.
- Piping Bash output through `| head -20` → you lose the rest. Use `ctx_execute` to analyze ALL data and print summary.
- Narrowing `ctx_execute` output upstream of capture → `ctx_execute` captures, `ctx_search` filters; merging the layers drops data that the index never sees. See `references/anti-patterns.md` §8.
- Running `npm test` via Bash → full test output in context. Use `ctx_execute` to capture and summarize.
- Calling `browser_snapshot()` WITHOUT `filename` parameter → 135K tokens flood context. **Always** use `browser_snapshot(filename: "/tmp/snap.md")`.
- Calling `browser_console_messages()` or `browser_network_requests()` WITHOUT `filename` → entire output floods context. **Always** use the `filename` parameter.
- Passing ANY large data to `ctx_index(content: ...)` → data enters context as a parameter. **Always** use `ctx_index(path: ...)` to read server-side. The `content` parameter should only be used for small inline text you're composing yourself.
- Calling an MCP tool (Context7 `query-docs`, GitHub API, etc.) then passing the response to `ctx_index(content: response)` → **doubles** context usage. The response is already in context — use it directly or save to file first.
- Ignoring `browser_navigate` auto-snapshot → navigation response includes a full page snapshot. Don't rely on it for inspection — call `browser_snapshot(filename)` separately.
- Expecting `ctx_stats` to reset or wipe anything → `ctx_stats` is read-only (shows stats only). Use `ctx_purge(confirm: true)` to permanently delete all indexed content.

## Reference Files

- [JavaScript/TypeScript Patterns](./references/patterns-javascript.md)
- [Python Patterns](./references/patterns-python.md)
- [Shell Patterns](./references/patterns-shell.md)
- [Anti-Patterns & Common Mistakes](./references/anti-patterns.md)

## Contract

This skill guarantees:

- Routes large or uncertain command/file/API output through context-mode's sandbox tools (`ctx_execute`, `ctx_execute_file`, `ctx_fetch_and_index` → `ctx_search`) instead of raw Bash/Read/WebFetch, keeping raw data out of the context window.
- Uses Bash only for the documented whitelist (file mutations, git writes, navigation, process control, package management, simple echo).
- Indexes session events into SQLite/FTS5 so conversation compaction does not lose task/editor state; retrieves only relevant context via BM25.
- Never dictates final-answer prose style — it governs where data lives, not how the model writes.

## Output Format

When context-mode is active, the agent runs analysis as code (a script that `console.log()`s only the result) rather than reading files into context. Output of tool calls is summarized/extracted, not dumped verbatim, unless the user asks for raw output.

## Anti-Patterns

- Reading large files or command output directly into context when a `ctx_*` tool would do.
- Dumping raw 20+ line tool output into the conversation instead of extracting the decisive lines.
- Using Bash for queries/fetches/lists/tests/builds when the sandbox tool applies.
- Treating context-mode as a brevity enforcer — it is not; output style is the model's call.
- Forgetting `ctx_purge(confirm: true)` is destructive (irreversible content deletion).
