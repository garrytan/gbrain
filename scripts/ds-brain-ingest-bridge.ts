#!/usr/bin/env bun
/**
 * ds-brain ingest bridge (decision-only v1)
 *
 * Goal:
 * - own ingest decision shape from the gbrain side
 * - accept current ds-brain.request/v1 payload on stdin
 * - return a machine-readable decision envelope
 *
 * Current role:
 * - it is authoritative for ingest decisions
 * - it is intentionally decision-only and non-mutating
 * - the live helper executes raw capture + canonical writes from this decision
 */

type ThinRequest = {
  schema?: string;
  request_id?: string;
  intent?: string;
  input?: Record<string, unknown>;
  hints?: {
    suggested_targets?: string[];
    allow_new_pages?: boolean;
  };
  source?: {
    platform?: string;
    channel_id?: string;
    thread_ts?: string;
  };
  bridge_context?: {
    source_type?: string;
    raw_rel?: string;
    title?: string;
    url?: string;
    host?: string;
    content_hash?: string;
    note_rel?: string;
    thread_rel?: string;
    length?: number;
    text?: string;
    content?: string;
    has_body?: boolean;
  };
};

type DecisionMode = 'raw_only' | 'update_existing' | 'create_new' | 'defer';

type TargetWrite = {
  path: string;
  markdown: string;
  status: 'created' | 'updated';
};

type BridgeResponse = {
  schema: 'gbrain.ingest.decision/v1';
  status: 'success' | 'deferred' | 'partial' | 'failed';
  decision: {
    mode: DecisionMode;
    target_pages: string[];
    reason_codes: string[];
  };
  created_pages: string[];
  updated_pages: string[];
  deferred_items: Array<Record<string, unknown>>;
  summary_ko: string;
  engine_evidence: Record<string, unknown>;
  raw_capture?: {
    rel: string;
    markdown: string;
  };
  target_writes?: TargetWrite[];
  execution?: {
    owner: 'bridge';
    applied: boolean;
    export?: string;
  };
};

function fail(summary_ko: string, reason: string, req: ThinRequest): BridgeResponse {
  return {
    schema: 'gbrain.ingest.decision/v1',
    status: 'failed',
    decision: {
      mode: 'defer',
      target_pages: [],
      reason_codes: [reason],
    },
    created_pages: [],
    updated_pages: [],
    deferred_items: [{ reason }],
    summary_ko,
    engine_evidence: {
      received_intent: req.intent ?? null,
      source_platform: req.source?.platform ?? null,
      source_type: inferSourceType(req),
      bridge_stage: 'decision_only',
      mutating: false,
    },
  };
}

const CANONICAL_DIRS = ['concepts', 'research', 'projects', 'products', 'decisions', 'originals'] as const;

function repoRoot(): string {
  return process.env.DAYSUN_BRAIN_REPO || '/srv/hermes/data/gbrain-notes';
}

function shouldExecuteBridgeWrites(): boolean {
  const value = String(process.env.DS_BRAIN_BRIDGE_EXECUTE || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function gbrainCli(): string {
  return process.env.DS_BRAIN_GBRAIN_CLI || '/srv/hermes/gbrain/bin/gbrain-shared';
}

function pathExists(path: string): boolean {
  return require('node:fs').existsSync(path);
}

function isExecutableFile(path: string): boolean {
  const fs = require('node:fs');
  try {
    const real = fs.realpathSync(path);
    return (fs.statSync(real).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function bunCli(): string {
  return process.env.DS_BRAIN_BUN || '/srv/hermes/gbrain/bin/bun';
}

function decodeBuffer(value: Uint8Array | ArrayBuffer | null | undefined): string {
  if (!value) {
    return '';
  }
  return new TextDecoder().decode(value);
}

function runGbrain(args: string[]): { ok: boolean; stdout: string; stderr: string; error?: string } {
  const cli = gbrainCli();
  if (!pathExists(cli)) {
    return { ok: false, stdout: '', stderr: '', error: `gbrain_cli_missing:${cli}` };
  }
  const path = require('node:path');
  const bun = bunCli();
  const cmd = isExecutableFile(cli) ? [cli, ...args] : [bun, cli, ...args];
  if (cmd[0] === bun && !pathExists(bun)) {
    return { ok: false, stdout: '', stderr: '', error: `bun_cli_missing:${bun}` };
  }
  const proc = Bun.spawnSync({
    cmd,
    env: {
      ...process.env,
      HOME: process.env.HOME || '/srv/hermes/users/ds-brain',
      PATH: `${path.dirname(cli)}:${path.dirname(bun)}:${process.env.PATH || ''}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = decodeBuffer(proc.stdout);
  const stderr = decodeBuffer(proc.stderr);
  if (proc.exitCode !== 0) {
    const detail = (stderr || stdout).trim().replace(/\n+/g, ' ').slice(0, 200);
    return { ok: false, stdout, stderr, error: `gbrain_command_failed:${args[0] || 'unknown'}:${detail}` };
  }
  return { ok: true, stdout, stderr };
}

function parsePutStatus(output: string): 'created' | 'updated' | 'skipped' | 'created_or_updated' {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && typeof parsed.status === 'string') {
      const status = parsed.status.trim();
      if (status === 'created' || status === 'updated' || status === 'skipped' || status === 'created_or_updated') {
        return status;
      }
    }
  } catch {}
  return 'created_or_updated';
}

function isValidSuggestedTarget(value: string): boolean {
  const target = String(value || '').trim();
  return !!target && !target.startsWith('/') && target.endsWith('.md') && !target.split('/').some(part => part === '..' || part === '');
}

function executionFailure(resp: BridgeResponse, error: string): BridgeResponse {
  return {
    ...resp,
    status: 'failed',
    decision: {
      mode: 'defer',
      target_pages: [],
      reason_codes: ['bridge_execution_failed'],
    },
    created_pages: [],
    updated_pages: [],
    deferred_items: [{ reason: 'bridge_execution_failed', error }],
    summary_ko: `gbrain ingest bridge execution 실패: ${error}`,
    execution: {
      owner: 'bridge',
      applied: false,
    },
    engine_evidence: {
      ...resp.engine_evidence,
      bridge_stage: 'execution_failed',
      mutating: true,
      execution_error: error,
    },
  };
}

function executeBridgeWrites(resp: BridgeResponse): BridgeResponse {
  if (!shouldExecuteBridgeWrites() || resp.status !== 'success') {
    return resp;
  }
  if (
    (resp.decision.mode === 'update_existing' || resp.decision.mode === 'create_new')
    && resp.decision.target_pages.length > 0
    && (!resp.target_writes || resp.target_writes.length === 0)
  ) {
    return executionFailure(resp, `missing_target_writes:${resp.decision.mode}`);
  }
  const createdPages: string[] = [];
  const updatedPages: string[] = [];

  if (resp.raw_capture) {
    const existingRaw = readRepoMarkdown(resp.raw_capture.rel);
    if (existingRaw === null) {
      const rawPut = runGbrain(['put', resp.raw_capture.rel.replace(/\.md$/, ''), '--content', resp.raw_capture.markdown]);
      if (!rawPut.ok) {
        return executionFailure(resp, rawPut.error || 'raw_put_failed');
      }
      if (parsePutStatus(rawPut.stdout) !== 'skipped' && !createdPages.includes(resp.raw_capture.rel)) {
        createdPages.push(resp.raw_capture.rel);
      }
    }
  }

  for (const write of resp.target_writes || []) {
    const targetPut = runGbrain(['put', write.path.replace(/\.md$/, ''), '--content', write.markdown]);
    if (!targetPut.ok) {
      return executionFailure(resp, targetPut.error || `target_put_failed:${write.path}`);
    }
    const putStatus = parsePutStatus(targetPut.stdout);
    if (putStatus === 'skipped') {
      continue;
    }
    if (putStatus === 'created' || (putStatus === 'created_or_updated' && write.status === 'created')) {
      if (!createdPages.includes(write.path)) {
        createdPages.push(write.path);
      }
    } else if (!updatedPages.includes(write.path)) {
      updatedPages.push(write.path);
    }
  }

  const exportResult = runGbrain(['export', '--dir', repoRoot()]);
  if (!exportResult.ok) {
    return executionFailure(resp, exportResult.error || 'export_failed');
  }

  return {
    ...resp,
    created_pages: createdPages,
    updated_pages: updatedPages,
    execution: {
      owner: 'bridge',
      applied: true,
      export: 'gbrain_export',
    },
    engine_evidence: {
      ...resp.engine_evidence,
      bridge_stage: 'execution_owned',
      mutating: true,
    },
  };
}

function slugifyTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\|.*$/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/[\u2190-\u21ff\u27f0-\u27ff\u2900-\u297f]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function titleMatchKeys(value: string): string[] {
  const raw = String(value || '').trim();
  if (!raw) {
    return [];
  }
  const keys = new Set<string>();
  const pushKey = (candidate: string) => {
    const key = slugifyTitle(candidate);
    if (key) {
      keys.add(key);
    }
  };
  pushKey(raw);
  pushKey(raw.replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/u, ' '));
  pushKey(raw.replace(/["'`‘’“”]/g, ''));
  return [...keys];
}

function canonicalTargetFromTitle(titleValue: string, fallbackDir = 'concepts'): { target: string; exists: boolean; matchSource: 'slug' | 'title' | 'alias' | 'none' } | null {
  const title = String(titleValue || '').trim();
  const slug = slugifyTitle(title);
  if (!slug) {
    return null;
  }

  const repo = repoRoot();
  for (const dirname of CANONICAL_DIRS) {
    const rel = `${dirname}/${slug}.md`;
    if (pathExists(`${repo}/${rel}`)) {
      return { target: rel, exists: true, matchSource: 'slug' };
    }
  }

  const titleMatch = findRepoTitleMatch(title);
  if (titleMatch) {
    return { target: titleMatch.target, exists: true, matchSource: titleMatch.matchSource };
  }

  return { target: `${fallbackDir}/${slug}.md`, exists: false, matchSource: 'none' };
}

function extractCanonicalDocMetadata(text: string): { title: string; aliases: string[] } {
  let title = '';
  const aliases: string[] = [];
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const frontmatter = fm[1];
    const titleMatch = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    if (titleMatch?.[1]) {
      title = titleMatch[1].trim();
    }

    const inlineAliases = frontmatter.match(/^aliases:\s*\[(.+?)\]\s*$/m);
    if (inlineAliases?.[1]) {
      for (const entry of inlineAliases[1].split(',')) {
        const value = entry.trim().replace(/^["']|["']$/g, '');
        if (value) {
          aliases.push(value);
        }
      }
    }

    const blockAliases = frontmatter.match(/^aliases:\s*\n((?:\s*-\s*.+\n?)*)/m);
    if (blockAliases?.[1]) {
      for (const line of blockAliases[1].split(/\n/)) {
        const aliasMatch = line.match(/^\s*-\s*(.+?)\s*$/);
        if (!aliasMatch?.[1]) {
          continue;
        }
        const value = aliasMatch[1].trim().replace(/^["']|["']$/g, '');
        if (value) {
          aliases.push(value);
        }
      }
    }
  }

  if (!title) {
    const headingMatch = text.match(/^#\s+(.+)$/m);
    if (headingMatch?.[1]) {
      title = headingMatch[1].trim();
    }
  }
  return { title, aliases: [...new Set(aliases)] };
}

function findRepoTitleMatch(titleValue: string): { target: string; matchSource: 'title' | 'alias' } | null {
  const wantedKeys = new Set(titleMatchKeys(titleValue));
  if (wantedKeys.size === 0) {
    return null;
  }
  const fs = require('node:fs');
  const path = require('node:path');
  const repo = repoRoot();
  for (const dirname of CANONICAL_DIRS) {
    const dir = path.join(repo, dirname);
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }
      const rel = `${dirname}/${entry.name}`;
      const docText = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      const metadata = extractCanonicalDocMetadata(docText);
      for (const key of titleMatchKeys(metadata.title)) {
        if (wantedKeys.has(key)) {
          return { target: rel, matchSource: 'title' };
        }
      }
      for (const alias of metadata.aliases) {
        for (const key of titleMatchKeys(alias)) {
          if (wantedKeys.has(key)) {
            return { target: rel, matchSource: 'alias' };
          }
        }
      }
    }
  }
  return null;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function frontmatter(fields: Record<string, string | number | boolean>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'boolean') {
      lines.push(`${key}: ${value ? 'true' : 'false'}`);
    } else if (typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: "${String(value).replace(/"/g, '\\"')}"`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function shorthash(value: string): string {
  return require('node:crypto').createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function contentHash(value: string): string {
  return require('node:crypto').createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizeUrl(value: string): string {
  let trimmed = String(value || '').trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    trimmed = trimmed.slice(1, -1);
  }

  const gistMatch = trimmed.match(/^https?:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]{20,})\/?$/i);
  if (gistMatch) {
    return `https://gist.githubusercontent.com/${gistMatch[1]}/${gistMatch[2]}/raw`;
  }

  const githubBlobMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
  if (githubBlobMatch) {
    return `https://raw.githubusercontent.com/${githubBlobMatch[1]}/${githubBlobMatch[2]}/${githubBlobMatch[3]}/${githubBlobMatch[4]}`;
  }

  return trimmed;
}

function extractHtmlTitle(text: string): string {
  const candidates: string[] = [];
  for (const metaRe of [
    /<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:title["']/i,
    /<meta[^>]+name\s*=\s*["']twitter:title["'][^>]*content\s*=\s*["']([^"']+)["']/i,
  ]) {
    const match = text.match(metaRe);
    if (match?.[1]) {
      candidates.push(match[1]);
    }
  }
  const titleMatch = text.match(/<title[^>]*>(.*?)<\/title>/is);
  if (titleMatch?.[1]) {
    candidates.push(titleMatch[1]);
  }
  const h1Match = text.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (h1Match?.[1]) {
    candidates.push(h1Match[1]);
  }

  for (const raw of candidates) {
    const cleaned = raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) {
      return cleaned;
    }
  }
  return '';
}

function deriveArticleTitle(text: string): string {
  if (!text) {
    return '';
  }
  const strippedStart = text.trimStart();
  const loweredHead = strippedStart.slice(0, 500).toLowerCase();
  const looksHtml = loweredHead.startsWith('<!doctype html')
    || loweredHead.includes('<html')
    || (loweredHead.includes('<head') && loweredHead.includes('<title'));
  if (looksHtml) {
    return extractHtmlTitle(text) || 'untitled-html';
  }
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim().replace(/^#+/, '').trim();
    if (stripped) {
      return stripped.slice(0, 120);
    }
  }
  return '';
}

function classifyFetchNetworkError(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}:${err.message}` : String(err);
  const lower = String(msg).toLowerCase();
  if (lower.includes('timed out')) {
    return 'timeout';
  }
  if (
    lower.includes('unable to connect')
    || lower.includes('econnrefused')
    || lower.includes('connection refused')
    || lower.includes('connect failed')
  ) {
    return 'network_error:connect_failed';
  }
  if (
    lower.includes('enotfound')
    || lower.includes('getaddrinfo')
    || lower.includes('name or service not known')
    || lower.includes('dns')
  ) {
    return 'network_error:dns_resolution_failed';
  }
  if (
    lower.includes('tls')
    || lower.includes('ssl')
    || lower.includes('certificate')
  ) {
    return 'network_error:tls_failed';
  }
  return 'network_error:unknown';
}

async function fetchArticleContext(urlValue: string): Promise<{ url: string; host: string; title?: string; content?: string; content_hash?: string; fetch_error?: string }> {
  const url = normalizeUrl(urlValue);
  if (!url) {
    return { url: '', host: '', fetch_error: 'missing_url' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, host: '', fetch_error: 'bad_url' };
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!['http', 'https'].includes(scheme)) {
    return { url, host: parsed.host.toLowerCase(), fetch_error: `unsupported_scheme:${scheme}` };
  }
  const host = parsed.host.toLowerCase();

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'ds-brain-ingest-bridge/1.0 (+https://daysun.local)',
        'Accept': 'text/plain, text/markdown, text/html, */*;q=0.5',
      },
    });
    if (!resp.ok) {
      return { url, host, fetch_error: `http_error:${resp.status}` };
    }
    let content = await resp.text();
    if (content.length > 1_048_576) {
      content = content.slice(0, 1_048_576) + '\n\n<!-- truncated by ds-brain-ingest-bridge MAX_FETCH_BYTES -->\n';
    }
    return {
      url,
      host,
      content,
      title: deriveArticleTitle(content) || url,
      content_hash: contentHash(content),
    };
  } catch (err) {
    return { url, host, fetch_error: classifyFetchNetworkError(err) };
  }
}

async function resolveArticleRequest(req: ThinRequest): Promise<{ req: ThinRequest; fetch_error?: string }> {
  if (req.intent !== 'ingest_article') {
    return { req };
  }

  const sourceType = inferSourceType(req);
  const inputUrl = extractUrlFromInput(req);
  const existingContent = String(req.bridge_context?.content || '');
  const existingTitle = String(req.bridge_context?.title || '').trim() || (existingContent ? deriveArticleTitle(existingContent) : '');
  const existingHost = String(req.bridge_context?.host || (inputUrl ? (() => { try { return new URL(inputUrl).host.toLowerCase(); } catch { return ''; } })() : ''));
  const existingHash = String(req.bridge_context?.content_hash || (existingContent ? contentHash(existingContent) : ''));

  if (inputUrl && existingContent.trim()) {
    return {
      req: {
        ...req,
        bridge_context: {
          ...(req.bridge_context || {}),
          source_type: sourceType,
          url: inputUrl,
          host: existingHost,
          title: existingTitle || inputUrl,
          content: existingContent,
          content_hash: existingHash || contentHash(existingContent),
        },
      },
    };
  }

  if (inputUrl && existingTitle) {
    return {
      req: {
        ...req,
        bridge_context: {
          ...(req.bridge_context || {}),
          source_type: sourceType,
          url: inputUrl,
          host: existingHost,
          title: existingTitle,
          content_hash: existingHash,
        },
      },
    };
  }

  const fetched = await fetchArticleContext(inputUrl);
  if (fetched.fetch_error) {
    return {
      req: {
        ...req,
        bridge_context: {
          ...(req.bridge_context || {}),
          source_type: sourceType,
          url: fetched.url || inputUrl,
          host: fetched.host || existingHost,
        },
      },
      fetch_error: fetched.fetch_error,
    };
  }

  return {
    req: {
      ...req,
      bridge_context: {
        ...(req.bridge_context || {}),
        source_type: sourceType,
        url: fetched.url,
        host: fetched.host,
        title: fetched.title || inputUrl,
        content: fetched.content || '',
        content_hash: fetched.content_hash || '',
      },
    },
  };
}

function noteRawCapture(req: ThinRequest): { rel: string; markdown: string } | null {
  if (req.intent !== 'ingest_note') {
    return null;
  }
  const sourceType = inferSourceType(req);
  if (!['short_note', 'long_note'].includes(sourceType)) {
    return null;
  }
  const text = String(req.input?.text || '');
  if (!text.trim()) {
    return null;
  }
  const title = String(req.bridge_context?.title || text.split(/\n/, 1)[0] || 'note').trim();
  const date = todayUtc();
  const slug = slugifyTitle(`note-${title}-${shorthash(text)}`);
  const rel = sourceType === 'short_note'
    ? `inbox/notes/${date}-${slug}.md`
    : `raw/notes/${date}-${slug}.md`;
  const markdown = frontmatter({
    schema: 'raw/note/v1',
    captured_at: new Date().toISOString(),
    source_type: sourceType,
    length: text.length,
    content_hash: String(req.bridge_context?.content_hash || shorthash(text)),
    promotion: sourceType === 'short_note' ? 'inbox_only' : 'raw_only',
  }) + `\n\n${text.trimEnd()}\n`;
  return { rel, markdown };
}

function threadRawCapture(req: ThinRequest): { rel: string; markdown: string } | null {
  if (req.intent !== 'ingest_thread') {
    return null;
  }
  const sourceType = inferSourceType(req);
  if (sourceType !== 'slack_thread') {
    return null;
  }
  const text = String(req.bridge_context?.text || req.input?.text || '');
  const url = String(req.bridge_context?.url || req.input?.url || '');
  const date = todayUtc();
  const slug = slugifyTitle(`slack-thread-${shorthash(url || text || 'thread')}`);
  const rel = `raw/slack/${date}-${slug}.md`;
  const markdown = frontmatter({
    schema: 'raw/slack_thread/v1',
    url,
    captured_at: new Date().toISOString(),
    source_type: sourceType,
    has_body: Boolean(text),
    content_hash: String(req.bridge_context?.content_hash || shorthash(text || url)),
  }) + `\n\n${(text || '<!-- thread body not provided by requester -->').trimEnd()}\n`;
  return { rel, markdown };
}

function articleRawCapture(req: ThinRequest): { rel: string; markdown: string } | null {
  if (req.intent !== 'ingest_article') {
    return null;
  }
  const sourceType = inferSourceType(req);
  if (!['article_url', 'gist', 'github', 'youtube'].includes(sourceType)) {
    return null;
  }
  const url = String(req.bridge_context?.url || req.input?.url || '');
  const title = String(req.bridge_context?.title || url || 'article').trim();
  const content = String(req.bridge_context?.content || '');
  if (!url || !content.trim()) {
    return null;
  }
  const host = String(req.bridge_context?.host || '');
  const date = todayUtc();
  const slug = slugifyTitle(`${host}-${title}`);
  const rel = `raw/articles/${date}-${slug || `article-${shorthash(url)}`}.md`;
  const markdown = frontmatter({
    schema: 'raw/article/v1',
    url,
    fetched_at: new Date().toISOString(),
    host,
    source_type: sourceType,
    bytes: content.length,
    content_hash: String(req.bridge_context?.content_hash || shorthash(content)),
  }) + `\n\n${content.trimEnd()}\n`;
  return { rel, markdown };
}

function chooseArticleFallbackDir(req: ThinRequest): string {
  const text = `${String(req.bridge_context?.title || '')} ${String(req.bridge_context?.url || '')}`.toLowerCase();
  if (/(guide|research|analysis|study|benchmark|paper|blog|how\s+to|vs\b|가이드|비교|연구|벤치마크|분석)/i.test(text)) {
    return 'research';
  }
  return 'concepts';
}

function chooseNoteFallbackDir(req: ThinRequest): string {
  const text = `${String(req.bridge_context?.title || '')} ${String(req.input?.text || '')}`.toLowerCase();
  if (/(project|rollout|roadmap|milestone|owner|launch|delivery|plan\b|프로젝트|출시|계획|로드맵|마일스톤|담당자|오너)/i.test(text)) {
    return 'projects';
  }
  return 'concepts';
}

function articleCanonicalTarget(req: ThinRequest): { target: string; exists: boolean; matchSource: 'slug' | 'title' | 'alias' | 'none' } | null {
  return canonicalTargetFromTitle(String(req.bridge_context?.title || ''), chooseArticleFallbackDir(req));
}

function articleCanonicalTargetWrite(req: ThinRequest, target: string, status: 'created' | 'updated'): TargetWrite | null {
  const rawCapture = articleRawCapture(req);
  if (!rawCapture) {
    return null;
  }
  const title = String(req.bridge_context?.title || req.input?.url || 'article').trim() || 'article';
  if (status === 'created') {
    return {
      path: target,
      status,
      markdown: frontmatter({
        schema: 'canonical/page/v1',
        created_at: new Date().toISOString(),
        bootstrap: 'gbrain-ingest-bridge',
      }) + `\n\n# ${title}\n\n- source: ${String(req.bridge_context?.url || req.input?.url || '')}\n- raw: [[${rawCapture.rel}]]\n`,
    };
  }
  const existing = readRepoMarkdown(target);
  if (existing === null) {
    return null;
  }
  const reference = [
    `\n\n## Ingest reference — ${new Date().toISOString()}\n`,
    title ? `- title: ${title}\n` : '',
    req.bridge_context?.url || req.input?.url ? `- source: ${String(req.bridge_context?.url || req.input?.url)}\n` : '',
    `- raw: [[${rawCapture.rel}]]\n`,
  ].join('');
  return {
    path: target,
    status,
    markdown: existing.includes(`[[${rawCapture.rel}]]`) ? existing : `${existing.trimEnd()}${reference}`,
  };
}

function articleFetchFailureMeta(fetchError: string): { kind: string; retryable: boolean; summary: string } {
  if (fetchError === 'missing_url') {
    return { kind: 'missing_url', retryable: false, summary: 'article_url 원문 fetch 실패: URL 입력이 비어 있습니다.' };
  }
  if (fetchError === 'bad_url') {
    return { kind: 'bad_url', retryable: false, summary: 'article_url 원문 fetch 실패: URL 형식을 해석할 수 없습니다.' };
  }
  if (fetchError.startsWith('unsupported_scheme:')) {
    const scheme = fetchError.split(':', 2)[1] || 'unknown';
    return { kind: 'unsupported_scheme', retryable: false, summary: `article_url 원문 fetch 실패: 지원하지 않는 URL scheme 입니다 (${scheme}).` };
  }
  if (fetchError.startsWith('http_error:')) {
    const status = fetchError.split(':', 2)[1] || 'unknown';
    if (status === '401') {
      return { kind: 'http_auth_required', retryable: false, summary: 'article_url 원문 fetch 실패: upstream 인증이 필요합니다 (HTTP 401).' };
    }
    if (status === '403') {
      return { kind: 'http_forbidden', retryable: false, summary: 'article_url 원문 fetch 실패: upstream 접근이 거부되었습니다 (HTTP 403).' };
    }
    if (status === '404') {
      return { kind: 'http_not_found', retryable: false, summary: 'article_url 원문 fetch 실패: upstream 원문을 찾을 수 없습니다 (HTTP 404).' };
    }
    if (status === '429') {
      return { kind: 'http_rate_limited', retryable: true, summary: 'article_url 원문 fetch 실패: upstream rate limit(HTTP 429) 응답입니다.' };
    }
    if (status === '408') {
      return { kind: 'http_request_timeout', retryable: true, summary: 'article_url 원문 fetch 실패: upstream request timeout(HTTP 408) 응답입니다.' };
    }
    if (status === '502' || status === '503' || status === '504') {
      return { kind: 'http_upstream_unavailable', retryable: true, summary: `article_url 원문 fetch 실패: upstream 서버 오류(HTTP ${status}) 응답입니다.` };
    }
    return { kind: 'http_error', retryable: status.startsWith('5'), summary: `article_url 원문 fetch 실패: upstream HTTP ${status} 응답입니다.` };
  }
  if (fetchError === 'timeout') {
    return { kind: 'timeout', retryable: true, summary: 'article_url 원문 fetch 실패: 요청 시간이 초과되었습니다.' };
  }
  if (fetchError === 'network_error:connect_failed') {
    return { kind: 'network_connect_failed', retryable: true, summary: 'article_url 원문 fetch 실패: upstream 연결에 실패했습니다.' };
  }
  if (fetchError === 'network_error:dns_resolution_failed') {
    return { kind: 'network_dns_resolution_failed', retryable: false, summary: 'article_url 원문 fetch 실패: 도메인 이름을 해석할 수 없습니다.' };
  }
  if (fetchError === 'network_error:tls_failed') {
    return { kind: 'network_tls_failed', retryable: false, summary: 'article_url 원문 fetch 실패: TLS/SSL 검증에 실패했습니다.' };
  }
  if (fetchError.startsWith('network_error:')) {
    return { kind: 'network_error', retryable: true, summary: 'article_url 원문 fetch 실패: 네트워크 오류가 발생했습니다.' };
  }
  return { kind: 'unknown', retryable: false, summary: `article_url 원문 fetch 실패: ${fetchError}` };
}

function articleFetchFailureResponse(req: ThinRequest, fetchError: string, baseEvidence: Record<string, unknown>): BridgeResponse {
  const meta = articleFetchFailureMeta(fetchError);
  return {
    schema: 'gbrain.ingest.decision/v1',
    status: 'partial',
    decision: {
      mode: 'defer',
      target_pages: [],
      reason_codes: [fetchError],
    },
    created_pages: [],
    updated_pages: [],
    deferred_items: [{ reason: fetchError, url: req.bridge_context?.url || req.input?.url || null }],
    summary_ko: meta.summary,
    engine_evidence: {
      ...baseEvidence,
      decision_policy: 'article_fetch_failed',
      fetch_error: fetchError,
      fetch_error_kind: meta.kind,
      fetch_error_retryable: meta.retryable,
    },
  };
}

function noteCanonicalTarget(req: ThinRequest): { target: string; exists: boolean; matchSource: 'slug' | 'title' | 'alias' | 'none' } | null {
  return canonicalTargetFromTitle(String(req.bridge_context?.title || ''), chooseNoteFallbackDir(req));
}

const URL_RE = /https?:\/\/[^\s)]+/i;

function extractUrlFromInput(req: ThinRequest): string {
  const direct = normalizeUrl(String(req.input?.url || req.bridge_context?.url || ''));
  if (direct) {
    return direct;
  }
  const text = String(req.input?.text || '');
  const match = text.match(URL_RE);
  return normalizeUrl(match?.[0] || '');
}

function classifyArticleSource(url: string): string {
  if (!url) return 'article_url';
  let host = '';
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return 'article_url';
  }
  if (host.includes('gist.github.com') || host.includes('gist.githubusercontent.com')) return 'gist';
  if (host.includes('github.com') || host.includes('raw.githubusercontent.com')) return 'github';
  if (/^(?:www\.)?(?:youtube\.com|youtu\.be)$/i.test(host)) return 'youtube';
  return 'article_url';
}

function inferSourceType(req: ThinRequest): string {
  const explicit = String(req.bridge_context?.source_type || '').trim();
  if (explicit) {
    return explicit;
  }
  const intent = String(req.intent || '').trim();

  if (intent === 'ingest_thread') {
    return 'slack_thread';
  }
  if (intent === 'ingest_note') {
    const text = String(req.input?.text || req.bridge_context?.text || '');
    return text.length < 140 ? 'short_note' : 'long_note';
  }
  if (intent === 'ingest_article') {
    return classifyArticleSource(extractUrlFromInput(req));
  }
  if (intent === 'query') {
    return 'query';
  }
  if (intent === 'classify_only') {
    const inputType = String(req.input?.type || '').trim();
    if (inputType === 'file') return 'document';
    const text = String(req.input?.text || '');
    const extractedUrl = extractUrlFromInput(req);
    if (extractedUrl || inputType === 'url') {
      return classifyArticleSource(extractedUrl || normalizeUrl(String(req.input?.url || '')));
    }
    return text.length < 140 ? 'short_note' : 'long_note';
  }
  return 'unknown';
}

function readRepoMarkdown(rel: string): string | null {
  const fs = require('node:fs');
  const path = require('node:path');
  const full = path.join(repoRoot(), rel);
  if (fs.existsSync(full)) {
    return fs.readFileSync(full, 'utf8');
  }
  const getResult = runGbrain(['get', rel.replace(/\.md$/, '')]);
  if (!getResult.ok) {
    return null;
  }
  return getResult.stdout;
}

function noteCanonicalReference(rawRel: string, title: string): string {
  const lines = [`\n\n## Ingest reference — ${new Date().toISOString()}\n`];
  if (title) {
    lines.push(`- title: ${title}\n`);
  }
  lines.push(`- raw: [[${rawRel}]]\n`);
  return lines.join('');
}

function noteCanonicalTargetWrite(req: ThinRequest, target: string, status: 'created' | 'updated'): TargetWrite | null {
  const rawCapture = noteRawCapture(req);
  if (!rawCapture) {
    return null;
  }
  const title = String(req.bridge_context?.title || req.input?.text || 'note').split(/\n/, 1)[0].trim() || 'note';
  if (status === 'created') {
    return {
      path: target,
      status,
      markdown: frontmatter({
        schema: 'canonical/page/v1',
        created_at: new Date().toISOString(),
        bootstrap: 'gbrain-ingest-bridge',
      }) + `\n\n# ${title}\n\n- raw: [[${rawCapture.rel}]]\n`,
    };
  }
  const existing = readRepoMarkdown(target);
  if (existing === null) {
    return null;
  }
  return {
    path: target,
    status,
    markdown: existing.includes(`[[${rawCapture.rel}]]`)
      ? existing
      : `${existing.trimEnd()}${noteCanonicalReference(rawCapture.rel, title)}`,
  };
}

function threadCanonicalTarget(req: ThinRequest): { target: string; exists: boolean; matchSource: 'slug' | 'title' | 'alias' | 'none' } | null {
  const rawTitle = String(req.bridge_context?.title || '').trim();
  if (!rawTitle) {
    return null;
  }
  const structured = /^(decision|runbook|incident|policy|결정|런북|사고|정책)\s*:/i.test(rawTitle);
  if (!structured) {
    return null;
  }
  const normalized = rawTitle.replace(/^(decision|runbook|incident|policy|결정|런북|사고|정책)\s*:\s*/i, '').trim();
  if (!normalized) {
    return null;
  }
  const fallbackDir = /^(decision|결정)\s*:/i.test(rawTitle) ? 'decisions' : 'research';
  return canonicalTargetFromTitle(normalized, fallbackDir);
}

function threadCanonicalTargetWrite(req: ThinRequest, target: string, status: 'created' | 'updated'): TargetWrite | null {
  const rawCapture = threadRawCapture(req);
  if (!rawCapture) {
    return null;
  }
  const title = String(req.bridge_context?.title || req.input?.text || 'thread').split(/\n/, 1)[0].trim() || 'thread';
  if (status === 'created') {
    return {
      path: target,
      status,
      markdown: frontmatter({
        schema: 'canonical/page/v1',
        created_at: new Date().toISOString(),
        bootstrap: 'gbrain-ingest-bridge',
      }) + `\n\n# ${title}\n\n- source: ${String(req.bridge_context?.url || req.input?.url || '')}\n- raw: [[${rawCapture.rel}]]\n`,
    };
  }
  const existing = readRepoMarkdown(target);
  if (existing === null) {
    return null;
  }
  const reference = [
    `\n\n## Ingest reference — ${new Date().toISOString()}\n`,
    title ? `- title: ${title}\n` : '',
    req.bridge_context?.url || req.input?.url ? `- source: ${String(req.bridge_context?.url || req.input?.url)}\n` : '',
    `- raw: [[${rawCapture.rel}]]\n`,
  ].join('');
  return {
    path: target,
    status,
    markdown: existing.includes(`[[${rawCapture.rel}]]`) ? existing : `${existing.trimEnd()}${reference}`,
  };
}

async function decide(req: ThinRequest): Promise<BridgeResponse> {
  const intent = String(req.intent || '');
  const suggestedTargets = Array.isArray(req.hints?.suggested_targets)
    ? req.hints!.suggested_targets!
    : [];

  if (!intent) {
    return fail('gbrain ingest bridge: intent가 비어 있습니다.', 'missing_intent', req);
  }

  const supported = new Set(['ingest_article', 'ingest_note', 'ingest_thread', 'query', 'classify_only']);
  if (!supported.has(intent)) {
    return fail(`gbrain ingest bridge: 아직 지원하지 않는 intent=${intent}`, 'unsupported_intent', req);
  }

  if (suggestedTargets.some(target => !isValidSuggestedTarget(target))) {
    return fail('gbrain ingest bridge: suggested_targets 값이 repo-relative canonical markdown 경로가 아닙니다.', 'invalid_suggested_target', req);
  }

  let workingReq = req;
  if (intent === 'ingest_article') {
    const resolved = await resolveArticleRequest(req);
    workingReq = resolved.req;
    const articleEvidence = {
      received_intent: intent || null,
      source_platform: workingReq.source?.platform ?? null,
      source_channel_id: workingReq.source?.channel_id ?? null,
      source_thread_ts: workingReq.source?.thread_ts ?? null,
      has_input_url: typeof workingReq.input?.url === 'string' && workingReq.input.url.length > 0,
      has_input_text: typeof workingReq.input?.text === 'string' && workingReq.input.text.length > 0,
      suggested_target_count: suggestedTargets.length,
      article_title: workingReq.bridge_context?.title ?? null,
      article_url: workingReq.bridge_context?.url ?? null,
      note_title: workingReq.bridge_context?.title ?? null,
      thread_title: workingReq.bridge_context?.title ?? null,
      thread_url: workingReq.bridge_context?.url ?? null,
      thread_has_body: workingReq.bridge_context?.has_body ?? null,
      bridge_stage: 'decision_only',
      mutating: false,
    };
    if (resolved.fetch_error) {
      return articleFetchFailureResponse(workingReq, resolved.fetch_error, articleEvidence);
    }
  }

  const workingSourceType = inferSourceType(workingReq);

  const baseEvidence = {
    received_intent: intent || null,
    source_platform: workingReq.source?.platform ?? null,
    source_type: inferSourceType(workingReq),
    source_channel_id: workingReq.source?.channel_id ?? null,
    source_thread_ts: workingReq.source?.thread_ts ?? null,
    has_input_url: typeof workingReq.input?.url === 'string' && workingReq.input.url.length > 0,
    has_input_text: typeof workingReq.input?.text === 'string' && workingReq.input.text.length > 0,
    suggested_target_count: suggestedTargets.length,
    article_title: workingReq.bridge_context?.title ?? null,
    article_url: workingReq.bridge_context?.url ?? null,
    note_title: workingReq.bridge_context?.title ?? null,
    thread_title: workingReq.bridge_context?.title ?? null,
    thread_url: workingReq.bridge_context?.url ?? null,
    thread_has_body: workingReq.bridge_context?.has_body ?? null,
    bridge_stage: 'decision_only',
    mutating: false,
  };

  if (intent === 'classify_only') {
    return {
      schema: 'gbrain.ingest.decision/v1',
      status: 'success',
      decision: {
        mode: 'defer',
        target_pages: [],
        reason_codes: ['classify_only'],
      },
      created_pages: [],
      updated_pages: [],
      deferred_items: [],
      summary_ko: `classify_only: source_type=${workingSourceType}`,
      engine_evidence: {
        ...baseEvidence,
        source_type: workingSourceType,
        decision_policy: 'classify_only',
      },
    };
  }

  if (intent === 'ingest_thread') {
    const target = threadCanonicalTarget(workingReq);
    if (target?.exists) {
      const targetWrite = threadCanonicalTargetWrite(workingReq, target.target, 'updated');
      return {
        schema: 'gbrain.ingest.decision/v1',
        status: 'success',
        decision: {
          mode: 'update_existing',
          target_pages: [target.target],
          reason_codes: [target.matchSource === 'alias' ? 'thread_update_existing_from_repo_alias_match' : target.matchSource === 'title' ? 'thread_update_existing_from_repo_title_match' : 'thread_update_existing_from_repo_match'],
        },
        created_pages: [],
        updated_pages: [target.target],
        deferred_items: [],
        summary_ko: 'slack_thread 는 구조화된 제목과 repo match 결과에 따라 기존 canonical page를 update_existing 합니다.',
        engine_evidence: {
          ...baseEvidence,
          decision_policy: target.matchSource === 'alias' ? 'thread_update_existing_from_repo_alias_match' : target.matchSource === 'title' ? 'thread_update_existing_from_repo_title_match' : 'thread_update_existing_from_repo_match',
        },
        raw_capture: threadRawCapture(workingReq) || undefined,
        target_writes: targetWrite ? [targetWrite] : undefined,
      };
    }
    if (target && req.hints?.allow_new_pages !== false) {
      const targetWrite = threadCanonicalTargetWrite(workingReq, target.target, 'created');
      return {
        schema: 'gbrain.ingest.decision/v1',
        status: 'success',
        decision: {
          mode: 'create_new',
          target_pages: [target.target],
          reason_codes: ['thread_create_new_from_title'],
        },
        created_pages: [target.target],
        updated_pages: [],
        deferred_items: [],
        summary_ko: 'slack_thread 는 구조화된 제목을 기준으로 canonical target을 생성(create_new)합니다.',
        engine_evidence: {
          ...baseEvidence,
          decision_policy: 'thread_create_new_from_title',
        },
        raw_capture: threadRawCapture(workingReq) || undefined,
        target_writes: targetWrite ? [targetWrite] : undefined,
      };
    }
    return {
      schema: 'gbrain.ingest.decision/v1',
      status: 'success',
      decision: {
        mode: 'raw_only',
        target_pages: [],
        reason_codes: ['thread_default_raw_only'],
      },
      created_pages: [],
      updated_pages: [],
      deferred_items: [],
      summary_ko: 'slack_thread 는 현재 기본 정책이 raw/slack 보존(raw_only)입니다.',
      engine_evidence: {
        ...baseEvidence,
        decision_policy: 'thread_default_raw_only',
      },
      raw_capture: threadRawCapture(req) || undefined,
    };
  }

  if (intent === 'ingest_article' && suggestedTargets.length === 0) {
    const target = articleCanonicalTarget(workingReq);
    if (target?.exists) {
      const targetWrite = articleCanonicalTargetWrite(workingReq, target.target, 'updated');
      return {
        schema: 'gbrain.ingest.decision/v1',
        status: 'success',
        decision: {
          mode: 'update_existing',
          target_pages: [target.target],
          reason_codes: [target.matchSource === 'alias' ? 'article_update_existing_from_repo_alias_match' : target.matchSource === 'title' ? 'article_update_existing_from_repo_title_match' : 'article_update_existing_from_repo_match'],
        },
        created_pages: [],
        updated_pages: [target.target],
        deferred_items: [],
        summary_ko: 'article_url 는 gbrain repo match 결과에 따라 기존 canonical page를 update_existing 합니다.',
        engine_evidence: {
          ...baseEvidence,
          decision_policy: target.matchSource === 'alias' ? 'article_update_existing_from_repo_alias_match' : target.matchSource === 'title' ? 'article_update_existing_from_repo_title_match' : 'article_update_existing_from_repo_match',
        },
        raw_capture: articleRawCapture(workingReq) || undefined,
        target_writes: targetWrite ? [targetWrite] : undefined,
      };
    }
    if (target && req.hints?.allow_new_pages !== false) {
      const targetWrite = articleCanonicalTargetWrite(workingReq, target.target, 'created');
      return {
        schema: 'gbrain.ingest.decision/v1',
        status: 'success',
        decision: {
          mode: 'create_new',
          target_pages: [target.target],
          reason_codes: ['article_create_new_from_title'],
        },
        created_pages: [target.target],
        updated_pages: [],
        deferred_items: [],
        summary_ko: 'article_url 는 gbrain title 기반 canonical target을 생성(create_new)합니다.',
        engine_evidence: {
          ...baseEvidence,
          decision_policy: 'article_create_new_from_title',
        },
        raw_capture: articleRawCapture(workingReq) || undefined,
        target_writes: targetWrite ? [targetWrite] : undefined,
      };
    }
    return {
      schema: 'gbrain.ingest.decision/v1',
      status: 'success',
      decision: {
        mode: 'raw_only',
        target_pages: [],
        reason_codes: ['article_default_raw_only'],
      },
      created_pages: [],
      updated_pages: [],
      deferred_items: [],
      summary_ko: 'article_url 는 현재 기본 정책이 raw/articles 보존(raw_only)입니다.',
      engine_evidence: {
        ...baseEvidence,
        decision_policy: 'article_default_raw_only',
      },
      raw_capture: articleRawCapture(workingReq) || undefined,
    };
  }

  if (intent === 'ingest_article' && suggestedTargets.length > 0) {
    const targetWrite = articleCanonicalTargetWrite(workingReq, suggestedTargets[0], 'updated');
    return {
      schema: 'gbrain.ingest.decision/v1',
      status: 'success',
      decision: {
        mode: 'update_existing',
        target_pages: suggestedTargets,
        reason_codes: ['article_update_existing_from_hint'],
      },
      created_pages: [],
      updated_pages: suggestedTargets,
      deferred_items: [],
      summary_ko: 'article_url 는 hint target에 따라 기존 canonical page를 update_existing 합니다.',
      engine_evidence: {
        ...baseEvidence,
        decision_policy: 'article_update_existing_from_hint',
      },
      raw_capture: articleRawCapture(workingReq) || undefined,
      target_writes: targetWrite ? [targetWrite] : undefined,
    };
  }

  if (intent === 'ingest_note' && workingSourceType === 'short_note') {
    return {
      schema: 'gbrain.ingest.decision/v1',
      status: 'success',
      decision: {
        mode: 'raw_only',
        target_pages: [],
        reason_codes: ['short_note_default_inbox_only'],
      },
      created_pages: [],
      updated_pages: [],
      deferred_items: [],
      summary_ko: 'short_note 는 현재 기본 정책이 inbox/notes 보존(raw_only)입니다.',
      engine_evidence: {
        ...baseEvidence,
        decision_policy: 'short_note_default_inbox_only',
      },
      raw_capture: noteRawCapture(workingReq) || undefined,
    };
  }

  if (intent === 'ingest_note' && workingSourceType === 'long_note' && suggestedTargets.length > 0) {
    const targetWrite = noteCanonicalTargetWrite(workingReq, suggestedTargets[0], 'updated');
    return {
      schema: 'gbrain.ingest.decision/v1',
      status: 'success',
      decision: {
        mode: 'update_existing',
        target_pages: suggestedTargets,
        reason_codes: ['long_note_update_existing_from_hint'],
      },
      created_pages: [],
      updated_pages: suggestedTargets,
      deferred_items: [],
      summary_ko: 'long_note 는 hint target에 따라 기존 canonical page를 update_existing 합니다.',
      engine_evidence: {
        ...baseEvidence,
        decision_policy: 'long_note_update_existing_from_hint',
      },
      raw_capture: noteRawCapture(workingReq) || undefined,
      target_writes: targetWrite ? [targetWrite] : undefined,
    };
  }

  if (intent === 'ingest_note' && workingSourceType === 'long_note') {
    const target = noteCanonicalTarget(workingReq);
    if (target?.exists) {
      const targetWrite = noteCanonicalTargetWrite(workingReq, target.target, 'updated');
      return {
        schema: 'gbrain.ingest.decision/v1',
        status: 'success',
        decision: {
          mode: 'update_existing',
          target_pages: [target.target],
          reason_codes: [target.matchSource === 'alias' ? 'long_note_update_existing_from_repo_alias_match' : target.matchSource === 'title' ? 'long_note_update_existing_from_repo_title_match' : 'long_note_update_existing_from_repo_match'],
        },
        created_pages: [],
        updated_pages: [target.target],
        deferred_items: [],
        summary_ko: 'long_note 는 gbrain repo match 결과에 따라 기존 canonical page를 update_existing 합니다.',
        engine_evidence: {
          ...baseEvidence,
          decision_policy: target.matchSource === 'alias' ? 'long_note_update_existing_from_repo_alias_match' : target.matchSource === 'title' ? 'long_note_update_existing_from_repo_title_match' : 'long_note_update_existing_from_repo_match',
        },
        raw_capture: noteRawCapture(workingReq) || undefined,
        target_writes: targetWrite ? [targetWrite] : undefined,
      };
    }
    if (target && req.hints?.allow_new_pages !== false) {
      const targetWrite = noteCanonicalTargetWrite(workingReq, target.target, 'created');
      return {
        schema: 'gbrain.ingest.decision/v1',
        status: 'success',
        decision: {
          mode: 'create_new',
          target_pages: [target.target],
          reason_codes: ['long_note_create_new_from_title'],
        },
        created_pages: [target.target],
        updated_pages: [],
        deferred_items: [],
        summary_ko: 'long_note 는 gbrain title 기반 canonical target을 생성(create_new)합니다.',
        engine_evidence: {
          ...baseEvidence,
          decision_policy: 'long_note_create_new_from_title',
        },
        raw_capture: noteRawCapture(workingReq) || undefined,
        target_writes: targetWrite ? [targetWrite] : undefined,
      };
    }
  }

  return {
    schema: 'gbrain.ingest.decision/v1',
    status: 'deferred',
    decision: {
      mode: 'defer',
      target_pages: suggestedTargets,
      reason_codes: ['bridge_stub_not_yet_mutating'],
    },
    created_pages: [],
    updated_pages: [],
    deferred_items: [
      {
        reason: 'bridge_stub_not_yet_mutating',
        intent,
      },
    ],
    summary_ko: `gbrain ingest bridge 초안: ${intent} 입력을 수신했지만, 아직 실제 promote/create/update 로직은 연결되지 않았습니다.`,
    engine_evidence: baseEvidence,
  };
}

async function main() {
  const raw = await new Response(Bun.stdin.stream()).text();
  if (!raw.trim()) {
    const resp = fail('gbrain ingest bridge: stdin이 비어 있습니다.', 'empty_stdin', {});
    console.log(JSON.stringify(resp, null, 2));
    process.exit(0);
  }

  let req: ThinRequest;
  try {
    req = JSON.parse(raw) as ThinRequest;
  } catch (err) {
    const resp = fail('gbrain ingest bridge: JSON 파싱에 실패했습니다.', 'bad_json', {});
    console.log(JSON.stringify({ ...resp, engine_evidence: { ...resp.engine_evidence, parse_error: String(err) } }, null, 2));
    process.exit(0);
  }

  const resp = executeBridgeWrites(await decide(req));
  console.log(JSON.stringify(resp, null, 2));
}

await main();
