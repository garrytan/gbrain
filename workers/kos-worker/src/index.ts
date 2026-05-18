/**
 * KOS Worker — Notion Worker for Jarvis Knowledge OS v2
 *
 * Provides 3 tools for Notion AI agents (📚 Knowledge Agent):
 * - kosQuery: Search the knowledge base
 * - kosIngest: Ingest a URL OR a markdown blob
 * - kosStatus: Get knowledge base sample statistics
 *
 * v3 changes (2026-05-XX): MCP-over-HTTP + OAuth 2.1 cutover
 * - Wire moved from fork-side `kos-compat-api` (kos.chenge.ink, Bearer
 *   KOS_API_TOKEN) to upstream `gbrain serve --http` (kos.chenge.ink,
 *   OAuth 2.1 + MCP JSON-RPC). See docs/JARVIS-ARCHITECTURE.md §6.28.
 * - kosDigest tool RETIRED. patrol digest still written by fork-side
 *   kos-patrol cron at ~/brain/.agent/digests/patrol-*.md (host-local;
 *   no longer surfaced to Notion Agent).
 * - kosIngest URL mode: worker-side fetch + naive HTML strip (lost
 *   fork-side Tavily/FlareSolverr for X.com — pass markdown directly
 *   for protected pages).
 * - kosStatus: list_pages sample mode (avoid admin scope; exact total
 *   via `gbrain status` on host).
 * - Token strategy: per-tool-call fresh access_token (no module-level
 *   cache; Notion Worker isolate reuse semantics undefined per CLAUDE.md).
 *
 * Env vars (set via `ntn workers env push` after `ntn workers env set`):
 * - KOS_MCP_BASE              default https://kos.chenge.ink
 * - KOS_OAUTH_CLIENT_ID       from ~/.gbrain/oauth-clients/kos-worker.json
 * - KOS_OAUTH_CLIENT_SECRET   from ~/.gbrain/oauth-clients/kos-worker.json
 */

import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

const KOS_MCP_BASE = process.env.KOS_MCP_BASE ?? "http://localhost:7225";
const KOS_OAUTH_CLIENT_ID = process.env.KOS_OAUTH_CLIENT_ID ?? "";
const KOS_OAUTH_CLIENT_SECRET = process.env.KOS_OAUTH_CLIENT_SECRET ?? "";

// Cloudflare Workers default fetch-subrequest timeout is ~30s; an MCP
// put_page on a large page can take 20-60s (chunk + embed + facts queue),
// and kosQuery synthesis adds latency. 240s matches the prior contract
// in docs/integration-clients.md for cold-ingest tolerance.
const KOS_FETCH_TIMEOUT_MS = 240_000;

// ─── OAuth helper ───
// Per-tool-call fresh token. Notion Worker `execute` invocations are
// stateless from our perspective; module-level cache MAY work across
// warm V8 isolates but is fragile and saves only 100-300ms. The OAuth
// /token endpoint is rate-limited at 50 req / 15 min server-side
// (src/commands/serve-http.ts:268-274) — well above any plausible
// kos-worker call frequency.
async function getAccessToken(): Promise<string> {
	if (!KOS_OAUTH_CLIENT_ID || !KOS_OAUTH_CLIENT_SECRET) {
		throw new Error(
			"kos-worker: KOS_OAUTH_CLIENT_ID / KOS_OAUTH_CLIENT_SECRET not configured. " +
				"Run `gbrain auth register-client \"kos-worker\" --grant-types client_credentials --scopes \"read write\"` " +
				"on the jarvis host, then `ntn workers env set` + `ntn workers env push`.",
		);
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 30_000);

	try {
		const res = await fetch(`${KOS_MCP_BASE}/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "client_credentials",
				client_id: KOS_OAUTH_CLIENT_ID,
				client_secret: KOS_OAUTH_CLIENT_SECRET,
				scope: "read write",
			}),
			signal: controller.signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(
				`KOS OAuth /token failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
			);
		}

		const data = (await res.json()) as {
			access_token?: string;
			expires_in?: number;
			error?: string;
			error_description?: string;
		};

		if (data.error) {
			throw new Error(
				`KOS OAuth /token error: ${data.error} - ${data.error_description ?? ""}`,
			);
		}
		if (!data.access_token) {
			throw new Error(`KOS OAuth /token: missing access_token in response`);
		}
		return data.access_token;
	} finally {
		clearTimeout(timeoutId);
	}
}

// ─── MCP JSON-RPC helper ───
// Calls `tools/call` on the MCP endpoint with a fresh OAuth token. Parses
// the upstream's content[0].text envelope (per src/mcp/dispatch.ts:14-28
// — all op results are JSON.stringify'd into content[0].text, NOT in
// structuredContent). Handles isError:true by parsing the error JSON
// (per src/core/operations.ts:77-85: {error, message, suggestion, docs}).
async function mcpCall<T = unknown>(
	toolName: string,
	args: Record<string, unknown>,
): Promise<T> {
	const accessToken = await getAccessToken();
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), KOS_FETCH_TIMEOUT_MS);

	try {
		const res = await fetch(`${KOS_MCP_BASE}/mcp`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				// SDK may stream SSE; we handle both content-types below.
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: "1",
				method: "tools/call",
				params: { name: toolName, arguments: args },
			}),
			signal: controller.signal,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(
				`MCP ${toolName} HTTP ${res.status}: ${text.slice(0, 300)}`,
			);
		}

		// Defensive: response may be JSON or SSE (StreamableHTTPServerTransport
		// supports both per SDK; tools/call typically returns JSON but health
		// of upstream framing isn't guaranteed across versions).
		const contentType = res.headers.get("content-type") ?? "";
		let envelope: {
			jsonrpc?: string;
			id?: string;
			result?: {
				content?: Array<{ type: string; text?: string }>;
				isError?: boolean;
			};
			error?: { code: number; message: string };
		};
		if (contentType.includes("text/event-stream")) {
			const raw = await res.text();
			const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
			if (!dataLine) {
				throw new Error(
					`MCP ${toolName} SSE response with no data line: ${raw.slice(0, 200)}`,
				);
			}
			envelope = JSON.parse(dataLine.slice(5).trim());
		} else {
			envelope = (await res.json()) as typeof envelope;
		}

		if (envelope.error) {
			throw new Error(
				`MCP ${toolName} JSON-RPC error: ${envelope.error.message}`,
			);
		}

		const textBlock = envelope.result?.content?.[0]?.text;
		if (textBlock == null) {
			throw new Error(
				`MCP ${toolName}: no content[0].text in result envelope`,
			);
		}

		// Op-layer errors land in content[0].text with isError:true. Try to
		// parse and re-throw with the structured error info per
		// OperationError.toJSON contract.
		if (envelope.result?.isError) {
			try {
				const errObj = JSON.parse(textBlock) as {
					error?: string;
					message?: string;
					suggestion?: string;
				};
				const tail = errObj.suggestion ? ` (try: ${errObj.suggestion})` : "";
				throw new Error(
					`MCP ${toolName} op error (${errObj.error ?? "unknown"}): ${errObj.message ?? textBlock}${tail}`,
				);
			} catch (_parseErr) {
				throw new Error(`MCP ${toolName} op error: ${textBlock.slice(0, 300)}`);
			}
		}

		// All op results are JSON.stringify'd into content[0].text per
		// src/mcp/dispatch.ts:254 — including query (which returns a hit
		// array, not prose). Always parse back to structured.
		return JSON.parse(textBlock) as T;
	} finally {
		clearTimeout(timeoutId);
	}
}

// ─── Markdown / frontmatter helpers (ported from server/kos-compat-api.ts) ───

// KOS `kind` → gbrain `type` mapping. Upstream gbrain's lint requires
// `type:` in frontmatter from its fixed enum. KOS keeps `kind:` as the
// quality-gate profile tag. Mapping rules at skills/kos-jarvis/type-mapping.md.
const KIND_TO_TYPE: Record<string, string> = {
	source: "source",
	concept: "concept",
	project: "project",
	entity: "note", // entity is too coarse; `note` is upstream's catch-all
	decision: "concept", // decisions live in concepts/ with kind preserved
	synthesis: "writing",
	comparison: "writing",
	protocol: "concept",
	timeline: "note",
	person: "person",
	company: "company",
};

function kindToType(kind: string): string {
	return KIND_TO_TYPE[kind] ?? "note";
}

// KOS kind → upstream-conventional dir prefix (for slug namespacing).
// Upstream put_page accepts any slug — slashes are allowed (max 255 chars
// per src/core/operations.ts:147-160). Putting pages under `sources/<slug>`
// preserves the directory convention that dream-cycle/kos-patrol assume.
const KIND_TO_DIR: Record<string, string> = {
	source: "sources",
	concept: "concepts",
	entity: "entities",
	project: "projects",
	decision: "decisions",
	synthesis: "syntheses",
	comparison: "comparisons",
	protocol: "protocols",
	timeline: "timelines",
	person: "people",
	company: "companies",
};

function kindToDir(kind: string): string {
	return KIND_TO_DIR[kind] ?? "sources";
}

// YAML-safe single-quoted scalar: ' → '' and wrap in single quotes.
// Identical to server/kos-compat-api.ts:87-89 for round-trip parity.
function yamlQuoteSingle(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

function deriveSlug(s: string): string {
	return s
		.replace(/^https?:\/\//, "")
		.replace(/[^a-z0-9]+/gi, "-")
		.toLowerCase()
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function deriveTitle(body: string, fallback: string): string {
	const m = body.match(/^#\s+(.+?)\s*$/m);
	if (m) return m[1].trim().slice(0, 240);
	return fallback;
}

// Worker-side URL fetch + naive HTML→text strip. Replaces fork-side
// skills/kos-jarvis/url-fetcher (UltimateSearchSkill with Tavily/FireCrawl
// chain) which can't run inside the Notion Worker sandbox.
//
// LIMITATION: protected pages (X/Twitter, Cloudflare-shielded sites) will
// often return login walls or 403/empty content. For those, callers should
// pass `markdown` directly (e.g., paste the page text into the agent prompt).
async function fetchUrlAsMarkdown(
	url: string,
): Promise<{ text: string; bytes: number }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 20_000); // 20s upper bound
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				// Best-effort UA to avoid trivial bot blocks; protected sites
				// still won't honor this — that's the documented trade-off.
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
					"(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
				Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
			},
		});
		if (!res.ok) {
			throw new Error(`fetch ${url} returned HTTP ${res.status}`);
		}
		const html = await res.text();
		const plain = html
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/\s+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
			.slice(0, 50_000);
		return { text: plain, bytes: html.length };
	} finally {
		clearTimeout(timeoutId);
	}
}

// ─── Tool: kosQuery ───
worker.tool("kosQuery", {
	title: "Knowledge Query",
	description:
		"在 Jarvis Knowledge OS 中检索知识。基于 3100+ 编译页面的 wiki 网络" +
		"（概念/综合/决策/对比/协议），涵盖 harness engineering、context engineering、" +
		"agent 架构、Lucien 项目记录等主题。适用于需要深度、跨来源综合答案的问题。" +
		"返回 raw retrieval（agent 端自行综合最终答案）。",
	schema: j.object({
		question: j.string().describe("要查询的问题（中文优先）"),
	}),
	execute: async ({ question }) => {
		// Upstream `query` op (src/core/operations.ts:1084-1260) returns
		// `results` = array of hybridSearch hits {slug, score, snippet,
		// chunks, ...} + optional meta. Notion Custom Agent LLM synthesizes
		// the final answer from this structured retrieval — no double-LLM
		// pass like the old fork-side kos-compat-api `/query` did.
		const hits = await mcpCall<unknown>("query", { query: question });
		return JSON.stringify(hits, null, 2);
	},
});

// ─── Tool: kosIngest ───
worker.tool("kosIngest", {
	title: "Knowledge Ingest",
	description:
		"将 URL 或 markdown 内容摄入 Jarvis Knowledge OS。" +
		"- 提供 url：worker 端 fetch + 简单 HTML→text → put_page。" +
		"  注意：X/Twitter / Cloudflare-保护页常返登录墙；这类内容请直接传 markdown。" +
		"- 提供 markdown：直接 put_page。若已含 YAML frontmatter（--- 开头）则原样保留，" +
		"  否则服务端会补默认 frontmatter。" +
		"两种方式都会自动 chunk + embed（Gemini）+ facts extraction（异步）。" +
		"entity-graph (auto_links + auto_timeline) 不在 put_page 时建立（remote safety gate）；" +
		"dream-cycle (03:11 daily cron) 当晚 backfill。耗时 5-30 秒。",
	schema: j.object({
		url: j.string().describe("要摄入的 URL。与 markdown 二选一。").nullable(),
		markdown: j
			.string()
			.describe(
				"要摄入的 markdown 正文。与 url 二选一。包含 YAML frontmatter（--- 开头）将原样保留。",
			)
			.nullable(),
		title: j.string().describe("页面标题。默认从 markdown/URL 推断。").nullable(),
		slug: j
			.string()
			.describe("自定义 slug（英文短横线格式）。默认从 title/URL 推断。")
			.nullable(),
		kind: j
			.string()
			.describe(
				"页面 kind: source|concept|project|decision|synthesis|protocol|timeline|comparison|entity。默认 source。",
			)
			.nullable(),
		source: j
			.string()
			.describe("来源标识。URL / notion:<page_id> / manual:<note>。默认从 url/notion_id 推断。")
			.nullable(),
		notion_id: j
			.string()
			.describe("Notion 页面 ID（UUID）。转 source=notion:<id>。")
			.nullable(),
		tags: j
			.array(j.string())
			.describe("追加到 frontmatter.tags 的额外标签。")
			.nullable(),
	}),
	execute: async ({ url, markdown, title, slug, kind, source, notion_id, tags }) => {
		if (!url && !markdown) {
			throw new Error("kosIngest: 必须提供 url 或 markdown 之一");
		}

		const today = new Date().toISOString().slice(0, 10);
		const kindStr = (kind ?? "source").trim();
		const dir = kindToDir(kindStr);
		const sourceRef =
			source?.trim() || url || (notion_id ? `notion:${notion_id}` : "manual");
		const extraTags = Array.isArray(tags) ? tags : [];
		const tagList = ["ingest-via-kos-worker", ...extraTags];

		// Resolve body + title
		let body: string;
		let resolvedTitle: string;
		let resolvedSlug: string;

		if (markdown) {
			// markdown path
			const md = markdown.trim();
			const hasFrontmatter = /^---\n[\s\S]*?\n---/.test(md);
			if (hasFrontmatter) {
				// Caller-supplied frontmatter — trust as-is. Slug must be
				// provided (or derived) since we won't reach into the YAML.
				resolvedSlug =
					slug?.trim() ||
					(title ? deriveSlug(title) : `ingest-${Date.now()}`);
				const fullSlug = `${dir}/${resolvedSlug}`;
				const result = await mcpCall<{
					slug?: string;
					status?: string;
					chunks?: number;
				}>("put_page", { slug: fullSlug, content: md });
				return formatIngestResult(result, fullSlug, "markdown");
			}
			body = md;
			resolvedTitle = title?.trim() || deriveTitle(body, "untitled");
			resolvedSlug = slug?.trim() || deriveSlug(resolvedTitle);
		} else {
			// URL fetch path
			const fetched = await fetchUrlAsMarkdown(url!);
			body = fetched.text;
			resolvedTitle = title?.trim() || deriveSlug(url!);
			resolvedSlug = slug?.trim() || deriveSlug(url!);
		}

		const fullSlug = `${dir}/${resolvedSlug}`;
		const yamlTitle = yamlQuoteSingle(resolvedTitle);
		const fullMd = `---
id: '${kindStr}-${resolvedSlug}'
type: ${kindToType(kindStr)}
kind: ${kindStr}
title: ${yamlTitle}
status: draft
created: '${today}'
updated: '${today}'
owners:
  - jarvis
confidence: low
source_of_truth: raw
source_refs:
  - ${sourceRef}
tags: [${tagList.join(", ")}]
---

# ${resolvedTitle}

> Ingested via kos-worker MCP on ${today}.
> Source: ${sourceRef}

${body}
`;

		const result = await mcpCall<{
			slug?: string;
			status?: string;
			chunks?: number;
		}>("put_page", { slug: fullSlug, content: fullMd });
		return formatIngestResult(result, fullSlug, url ? "url" : "markdown");
	},
});

function formatIngestResult(
	result: { slug?: string; status?: string; chunks?: number },
	fallbackSlug: string,
	mode: "url" | "markdown",
): string {
	return JSON.stringify(
		{
			imported: result.status === "created_or_updated",
			slug: result.slug ?? fallbackSlug,
			status: result.status,
			chunks: result.chunks,
			mode,
			next:
				"page chunked + embedded; vector + keyword search will find it immediately. " +
				"entity-graph (auto_links/auto_timeline) backfills via dream-cycle within 24h.",
		},
		null,
		2,
	);
}

// ─── Tool: kosStatus ───
worker.tool("kosStatus", {
	title: "Knowledge Status (sampled)",
	description:
		"获取 Jarvis Knowledge OS 采样统计：最新 100 个 page 的 type/kind 直方图。" +
		"注：受 list_pages 默认 limit=100 限制，total_pages 是采样数，不是 brain 全量。" +
		"若需精确全量统计，请 ssh 到 brain host 跑 `gbrain status` 或 `gbrain doctor`。",
	schema: j.object({}),
	execute: async () => {
		const pages = await mcpCall<
			Array<{ slug: string; type: string; title: string; updated_at: string }>
		>("list_pages", {
			limit: 100,
			sort: "updated_desc",
		});

		const byType: Record<string, number> = {};
		// Note: list_pages doesn't expose frontmatter; only slug/type/title/updated_at.
		// by_kind from old /status was sourced from pages.frontmatter.kind — not
		// available here without an extra round-trip per page. We surface by_type
		// (gbrain's enum) which is the practical signal anyway.
		for (const p of pages) {
			byType[p.type] = (byType[p.type] ?? 0) + 1;
		}

		const isCapped = pages.length === 100;
		return JSON.stringify(
			{
				sampled_pages: pages.length,
				by_type: byType,
				latest_updated_at: pages[0]?.updated_at,
				oldest_in_sample_updated_at: pages[pages.length - 1]?.updated_at,
				note: isCapped
					? "Sample of latest 100 pages (list_pages MCP op caps at 100). " +
						"For exact brain-wide total + full by_kind histogram, run `gbrain status` or `gbrain doctor` on host."
					: `Full count — brain has ${pages.length} non-deleted pages.`,
			},
			null,
			2,
		);
	},
});
