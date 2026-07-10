---
name: firecrawl-research-index
description: Find the papers that answer a research query with Firecrawl Research, using semantic search, semantic and structural expansion, and in-body verification. Always use this skill for any literature-finding / paper-retrieval task — single-paper lookups or full multi-paper sets.
triggers:
  - firecrawl
  - scrape
  - web data
---

# Firecrawl Research Index

Find the research papers that answer a research query. Some questions have a single answer; many have several — and when in doubt, lean toward returning the fuller relevant set (most relevant first) rather than narrowing to one. A reader is better served seeing the neighboring methods and papers than having them silently dropped.

There is **no fixed recipe**. Read the query, decide what kind it is, and choose the approach below. Some queries need a single search; others need heavy sturctural/semantic expansion. Don't run machinery a query doesn't call for.

## The tools, and what each is uniquely good at

- MCP: **`firecrawl_research_search_papers(query, k?)`**
  CLI: **`firecrawl research search-papers <query> [--k <number>]`**
  Semantic (HyDE) search over **abstracts**. The natural first move for almost any query.
  If results look thin or all-alike, re-run with a different framing (sibling domain, rival method, dataset/benchmark name) rather than giving up.

- MCP: **`firecrawl_research_related_papers(seed_ids, intent, mode?, k?)`**
  CLI: **`firecrawl research related-papers <seedIds...> --intent <intent> [--mode <similar|citers|references>] [--k <number>]`**
  Semantic and structural expansion, ranked to your `intent`.
  This reaches papers semantic search *cannot*, and it's how you turn one good hit into the rest of a set.
  `mode=similar` → niche siblings; `citers` → who uses/builds on the seeds; `references` → what they build on / compare against.

- MCP: **`firecrawl_research_inspect_paper(id)`**
  CLI: **`firecrawl research inspect-paper <id>`**
  Canonical metadata for **one** paper: title, abstract, authors, categories, source ids, and dates.
  Use it after `search_papers` or `related_papers` when you need the complete citation/metadata for a candidate, or when you have an id from elsewhere and need to confirm what paper it resolves to.
  This does **not** read the paper body; use `read_paper` for specific full-text questions.

- MCP: **`firecrawl_research_read_paper(id, question)`**
  CLI: **`firecrawl research read-paper <id> --question <question>`**
  In-body passages of **one** paper, to verify a load-bearing constraint (a method actually used, a score actually reported, an affiliation, what a paper compares to).
  Use it to settle a specific doubt, not on everything.

- MCP: **`firecrawl_search(query)` / `firecrawl_scrape(url)`**
  CLI: **`firecrawl search <query>` / `firecrawl scrape <url>`**
  General **web** search and page fetch, for facts that don't live in paper abstracts: benchmark **leaderboards**, rankings, "who scores best / is largest / is most used."
  Find the ranking on the web, then map the top entries back to papers with `search_papers`.
  Reach for these only when the corpus can't answer the question on its own.

## Match the approach to the query

- **Single *named* paper** ("the Qwen3 report") → one `search_papers`, done. This is the only case that truly wants exactly one paper.
- **Paper by description / by method or technique** ("the paper that introduced X", "training-free N-gram detection of AI text") → find the best match, then assume there's a *family*: expand with `related_papers` and **include the closely-related methods/papers too**. Even when one paper is the exact literal match, surface and keep its neighbors — don't narrow to the single best hit and reason the rest out. Only treat it as one-answer if the query names a specific paper.
- **Enumeration / method-family** ("papers that do X", "alternatives to Adam", "benchmarks for Y") → the answer is a *set*, and this is where `related_papers` earns its keep: expand several strong anchors with `mode=similar`, re-seed from new strong hits. One search is never enough here.
- **Exhibiting** ("papers that *use* / exhibit property P") → the relevant papers apply P but their abstracts may not describe it. Go from P's defining paper outward via `citers`/`references`, and use `read_paper` to confirm a candidate actually uses P.
- **Superlative / leaderboard** ("best on benchmark X", "largest", "most popular") → the ranking lives on **leaderboards / the web**, not in any single abstract. Use `firecrawl_search` / `firecrawl_scrape` to find the benchmark's leaderboard or rankings, read off the top models/papers, then `search_papers` each to get its paper. As a fallback, search the benchmark and `read_paper` candidates for reported numbers. The hardest kind — cast wide.
- **Org / author filtered** ("from \<org\>", "by \<author\>") → topical match isn't enough; verify the affiliation/authorship (metadata or `read_paper`) before keeping a paper.
- **Compare-against** ("what does paper X benchmark against / build on") → the answer is *inside* paper X: `read_paper(X, ...)` or `related_papers([X], ..., mode="references")`.

## Principles

- **When in doubt, include.** For any topic / method / comparison question, return the relevant *family*, not just the single best match — err toward keeping a plausibly-relevant paper rather than dropping it. The neighboring methods are part of a good answer; don't reason close work out just because one paper is the most exact match.
- **Follow the literature, and keep what you find.** The seminal source, the competing methods, the close neighbors are usually a hop away — use `related_papers`, and *include* them, not just the first hit. Stopping at one good result is the most common way to leave the reader with half an answer.
- **Verify to exclude, not to gatekeep.** Use `read_paper` to rule a paper *out* when a hard constraint clearly fails (wrong org/author, doesn't actually report the score). When a paper is plausibly relevant, lean toward keeping it rather than demanding proof.
- **Only drop the clearly off-topic.** Don't pad with papers you're confident are unrelated — but that's a high bar; most plausibly-relevant work should make the cut.

## Contract
- Inputs: skill request + project context (and Firecrawl API key when calling live endpoints).
- Outputs: concrete integration guidance, code snippets, and endpoint choices that match Firecrawl docs.
- Failure modes: missing API key, wrong endpoint for the task, or out-of-scope one-off terminal scrapes (use firecrawl CLI skill instead when applicable).

## Output Format
1. Confirm the target endpoint(s) and why they fit.
2. Provide the minimal working code/config changes.
3. Call out auth/env requirements and common pitfalls.

## Anti-Patterns
- Do not invent Firecrawl endpoints or response fields.
- Do not hardcode live API keys into source.
- Do not recommend crawl when a single `/scrape` or `/search` call is enough.
- Do not use these product-integration skills for disposable terminal-only lookups when a CLI path is intended.
