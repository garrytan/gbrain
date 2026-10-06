/**
 * Shared GitHub issue helpers for the CI watchers (scripts/nightly-issue.ts,
 * scripts/ci-health-report.ts).
 *
 * - `inert()` makes a run-derived string (job, step and test names, error
 *   text) safe to show an agent: control characters stripped, length capped,
 *   backticks and pipes replaced, `@` mentions and links neutralised, so the
 *   text renders as data and never pings, links or breaks out of a fence.
 * - `GitHubClient` is the one seam both scripts call; tests pass a recorded
 *   fake, production uses `restClient()` (fetch + GH_TOKEN/GITHUB_TOKEN in
 *   Actions, or the authenticated `gh api` CLI for local dry runs).
 * - `findIssueByTitle` looks an issue up through the list API by label and
 *   exact title (open first, else the most recently updated closed one, so a
 *   flapping workflow reopens its own issue).
 * - `fetchArtifactJson` reads one JSON file out of a run artifact's zip
 *   (`readZipEntry`, stored or deflated entries); every failure is returned
 *   as a reason string so callers report incomplete evidence, never zero
 *   failures.
 * - `redactCredentials` strips user:password from database URLs in any text
 *   shown to an agent.
 */
import { inflateRawSync } from 'node:zlib';

export interface GitHubClient {
  request<T = unknown>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T>;
  /** Raw bytes of a GET (artifact archives); follows the redirect to blob storage without forwarding the token. */
  download?(path: string): Promise<Uint8Array>;
}

export interface Issue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  body?: string | null;
  labels?: Array<{ name: string } | string>;
  created_at?: string;
  updated_at?: string;
  pull_request?: unknown;
}

const ZWSP = '\u200b';

export function inert(value: unknown, max = 200): string {
  let s = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/`/g, "'")
    .replace(/\|/g, '/')
    .replace(/@/g, `@${ZWSP}`)
    .replace(/:\/\//g, `:${ZWSP}//`)
    .replace(/\bwww\./gi, m => `${m.slice(0, 3)}${ZWSP}.`)
    .replace(/[<>]/g, c => (c === '<' ? '‹' : '›'))
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/** Multi-line run-derived text for a `~~~text` fence: same neutralisation, newlines kept, fences broken. */
export function inertBlock(value: unknown, max = 1500): string {
  const lines = String(value ?? '').split(/\r?\n/).map(line => inert(line, 400).replace(/~{3,}/g, '~ ~ ~'));
  let s = lines.join('\n');
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/** Production client: REST with GH_TOKEN/GITHUB_TOKEN (Actions), else the authenticated `gh api` CLI (local dry runs). */
export function restClient(repo: string, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN): GitHubClient {
  const resolve = (path: string) => path.replace('{repo}', repo).replace(/^\//, '');
  if (!token) return ghCliClient(resolve);
  return {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      const url = `https://api.github.com/${resolve(path)}`;
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`GitHub API ${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
      }
      return (res.status === 204 ? undefined : await res.json()) as T;
    },
    async download(path: string): Promise<Uint8Array> {
      const url = `https://api.github.com/${resolve(path)}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }, redirect: 'manual' });
      const location = res.headers.get('location');
      const body = location ? await fetch(location) : res;
      if (!body.ok) throw Object.assign(new Error(`GitHub download ${url} -> ${body.status}`), { status: body.status });
      return new Uint8Array(await body.arrayBuffer());
    },
  };
}

function ghCliClient(resolve: (path: string) => string): GitHubClient {
  return {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      const args = ['gh', 'api', '-X', method, resolve(path), ...(body === undefined ? [] : ['--input', '-'])];
      const r = Bun.spawnSync(args, { stdin: body === undefined ? 'ignore' : Buffer.from(JSON.stringify(body)), stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) {
        const err = `${r.stderr.toString()} ${r.stdout.toString()}`.trim();
        const status = Number(/HTTP (\d{3})/.exec(err)?.[1]) || undefined;
        throw Object.assign(new Error(`gh api ${method} ${resolve(path)} failed: ${err.slice(0, 300)}. Fix: gh auth login, or export GH_TOKEN.`), { status });
      }
      const out = r.stdout.toString().trim();
      return (out ? JSON.parse(out) : undefined) as T;
    },
    async download(path: string): Promise<Uint8Array> {
      const r = Bun.spawnSync(['gh', 'api', resolve(path)], { stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) throw new Error(`gh api ${resolve(path)} failed: ${r.stderr.toString().slice(0, 300)}. Fix: gh auth login, or export GH_TOKEN.`);
      return new Uint8Array(r.stdout);
    },
  };
}

/** Create a label unless it exists (422 = already there). */
export async function ensureLabel(client: GitHubClient, name: string, color: string, description: string): Promise<void> {
  try {
    await client.request('POST', 'repos/{repo}/labels', { name, color, description });
  } catch (e) {
    if ((e as { status?: number }).status !== 422) throw e;
  }
}

export async function findIssueByTitle(client: GitHubClient, label: string, title: string, maxPages = 3): Promise<Issue | undefined> {
  const matches: Issue[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await client.request<Issue[]>('GET', `repos/{repo}/issues?labels=${encodeURIComponent(label)}&state=all&sort=updated&direction=desc&per_page=100&page=${page}`);
    matches.push(...batch.filter(i => !i.pull_request && i.title === title));
    if (batch.length < 100) break;
  }
  return matches.find(i => i.state === 'open') ?? matches[0];
}

export const labelNames = (issue: Issue): string[] => (issue.labels ?? []).map(l => (typeof l === 'string' ? l : l.name));

export async function createIssue(client: GitHubClient, title: string, body: string, labels: string[]): Promise<Issue> {
  return client.request<Issue>('POST', 'repos/{repo}/issues', { title, body, labels });
}

export async function updateIssue(client: GitHubClient, number: number, patch: { body?: string; state?: 'open' | 'closed'; labels?: string[] }): Promise<Issue> {
  return client.request<Issue>('PATCH', `repos/{repo}/issues/${number}`, patch);
}

export async function commentIssue(client: GitHubClient, number: number, body: string): Promise<void> {
  await client.request('POST', `repos/{repo}/issues/${number}/comments`, { body });
}

/** Extract the fenced JSON block a watcher wrote between its markers; undefined when absent or not valid JSON. */
export function readJsonBlock<T>(body: string | null | undefined, marker: string): T | undefined {
  const text = body ?? '';
  const tag = `<!-- ${marker} -->`;
  const at = text.indexOf(tag);
  if (at === -1) return undefined;
  const rest = text.slice(at + tag.length).trimStart();
  const open = '```json\n';
  if (!rest.startsWith(open)) return undefined;
  const end = rest.indexOf('\n```', open.length - 1);
  if (end === -1) return undefined;
  try { return JSON.parse(rest.slice(open.length, end)) as T; } catch { return undefined; }
}

export function jsonBlock(marker: string, value: unknown): string {
  return `<!-- ${marker} -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export async function getIssue(client: GitHubClient, number: number): Promise<Issue> {
  return client.request<Issue>('GET', `repos/{repo}/issues/${number}`);
}

/** Issues carrying a label (newest created first), pull requests excluded. */
export async function listLabeled(client: GitHubClient, label: string, state: 'open' | 'all', maxPages = 3): Promise<Issue[]> {
  const out: Issue[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await client.request<Issue[]>('GET', `repos/{repo}/issues?labels=${encodeURIComponent(label)}&state=${state}&sort=created&direction=desc&per_page=100&page=${page}`);
    out.push(...batch.filter(i => !i.pull_request));
    if (batch.length < 100) break;
  }
  return out;
}

export interface LinkedPull { number: number; merged_at: string | null; state: string; user?: string }

/** Pull requests that cross-reference or connect to an issue (its timeline), oldest first. */
export async function linkedPulls(client: GitHubClient, number: number): Promise<Array<LinkedPull & { linked_at: string }>> {
  const events = await client.request<Array<{ event: string; created_at?: string; source?: { issue?: { number: number; state: string; user?: { login: string }; pull_request?: { merged_at?: string | null } } } }>>(
    'GET', `repos/{repo}/issues/${number}/timeline?per_page=100`);
  const seen = new Set<number>();
  const out: Array<LinkedPull & { linked_at: string }> = [];
  for (const e of events) {
    const src = e.source?.issue;
    if (e.event !== 'cross-referenced' || !src?.pull_request || seen.has(src.number)) continue;
    seen.add(src.number);
    out.push({ number: src.number, merged_at: src.pull_request.merged_at ?? null, state: src.state, user: src.user?.login, linked_at: e.created_at ?? '' });
  }
  return out;
}

const DB_URL_CREDENTIALS = /\b((?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/)[^\s/@:]*(?::[^\s/@]*)?@/gi;

/** Remove user:password from database URLs (`postgres://u:p@h/db` -> `postgres://<redacted>@h/db`). */
export function redactCredentials(text: string): string {
  return text.replace(DB_URL_CREDENTIALS, '$1<redacted>@');
}

/** Read one file from a zip archive (stored or deflated entries, central directory lookup). */
export function readZipEntry(zip: Uint8Array, name: string): Uint8Array | undefined {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return undefined;
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < entries && at + 46 <= zip.length; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) return undefined;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entryName = decoder.decode(zip.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    if (method === 0) return data;
    if (method === 8) return new Uint8Array(inflateRawSync(data));
    return undefined;
  }
  return undefined;
}

/** One JSON file from a run's named artifact; `reason` says why it could not be read (missing, expired, unreadable). */
export async function fetchArtifactJson(client: GitHubClient, runId: number, artifact: string, file: string): Promise<{ value?: unknown; reason?: string }> {
  if (!client.download) return { reason: 'this client cannot download artifacts' };
  try {
    const list = await client.request<{ artifacts: Array<{ id: number; name: string; expired: boolean }> }>('GET', `repos/{repo}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(artifact)}&per_page=10`);
    const found = list.artifacts.find(a => a.name === artifact);
    if (!found) return { reason: `run ${runId} has no '${artifact}' artifact` };
    if (found.expired) return { reason: `run ${runId}'s '${artifact}' artifact has expired` };
    const bytes = readZipEntry(await client.download(`repos/{repo}/actions/artifacts/${found.id}/zip`), file);
    if (!bytes) return { reason: `run ${runId}'s '${artifact}' artifact has no readable ${file}` };
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (e) {
    return { reason: `reading run ${runId}'s '${artifact}' artifact failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
