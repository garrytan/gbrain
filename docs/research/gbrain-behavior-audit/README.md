# Helper scripts for the gbrain behavior audit

These are the scratch helpers that the repros in [../gbrain-behavior-audit.md](../gbrain-behavior-audit.md) use. They are copied as they were run, for reference. They are not product code and no test or build loads them.

They have three paths written in:

- `/var/tmp/audit/`: the scratch root. Copy this directory to `/var/tmp/audit/` to rerun a repro without edits.
- `/code/garrytan/gbrain`: the gbrain checkout (master `fbf608cf86` for the audit).
- `/home/ubuntu/.bun/bin/bun`: Bun 1.4.4.

Change those prefixes if your machine differs.

| File | What it does |
|---|---|
| `brain.sh <home> <args>` | Runs the gbrain CLI from the checkout on an isolated, keyless brain: `HOME`/`GBRAIN_HOME` set to `<home>`, provider keys and `DATABASE_URL` unset, `TZ=UTC`, no self-upgrade or sweep. Start with `brain.sh <home> init --pglite --no-embedding`. |
| `contract/inject.ts`, `contract/inj.sh` | Fault injector. `INJECT_SQL=<regex> inj.sh <home> <args>` makes any PGLite statement that matches the regex throw `permission denied` (42501). Use it to see what a command answers when one read fails. |
| `contract/seed.sh` | Seeds a small brain: two pages, one typed link, two facts, one timeline row. |
| `*/mcp.py`, `*/mcp.ts`, `contract/mcpw2.ts`, `privacy/scripts/stdio.py` | Small stdio MCP clients that start `gbrain serve` and send `tools/call` requests, as an untrusted (remote) caller. |
| `privacy/call.sh` | Sends one `tools/call` to `gbrain serve --http` on port 31871 with a member-bound bearer token read from a file. |
| `privacy/seed/` | Pages with `readable_by`, `visibility: private` and misspelled access keys. |
| `lifecycle/repro_*.sh`, `pages/repro-*.sh` | Complete repros for LC-1, LC-2, pages-02 and pages-03. Each one makes its own brain and git repo. A checkout path that a deleted brain once owned is refused (`recovery_required`), so use new paths when you rerun a repro. |
| `health/scripts/swallow.ts` | Runs real doctor check functions against an engine whose reads throw, and shows that they report `ok`. |
| `retrieval/scripts/fault-supersede.ts` | Runs hybrid search with the supersession lookup made to throw (RET-02). |
| `vega/` | Helpers for the Vega section (LC-12, LC-13, graph-17, graph-18, RET-16, contract-11, health-12 and the N7 check). `brain-keyless.sh` and `brain-keyed.sh` run the CLI with startup hooks and the link sweep left on, as a user runs it; `brain-keyed.sh` reads an OpenAI key from the environment by name. `corpus/` is the 9-page test corpus. `call.sh` and `stdio.py` are the HTTP and stdio MCP clients, set up for `/var/tmp/audit/vega/`. |
