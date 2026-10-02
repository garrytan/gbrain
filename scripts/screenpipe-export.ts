// Shared local-only transport and private staging for Screenpipe recipes.
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export function validateApiUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--api-url must be a plain HTTP loopback origin (127.0.0.1 or [::1]).');
  }
  return url;
}

export function rejectProxies() {
  if (['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
    .some(name => process.env[name]?.trim())) {
    throw new Error('Clear HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy, ALL_PROXY, and all_proxy for this local-only command.');
  }
}

export async function fetchLocalJson(options: { apiUrl: string; token: string }, path: string, label: string): Promise<unknown> {
  const origin = validateApiUrl(options.apiUrl);
  const url = new URL(path, origin);
  if (url.origin !== origin.origin) throw new Error('Screenpipe request must stay on the selected loopback origin.');
  rejectProxies();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${options.token}`, 'X-Screenpipe-Client': 'api', 'X-Screenpipe-Agent': 'gbrain' },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`${label}: unable to reach the local Screenpipe API.`);
  }
  if (!response.ok) throw new Error(`${label}: Screenpipe returned HTTP ${response.status}.`);
  if (!response.body) throw new Error(`${label}: empty response.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error(`${label}: response exceeds 2 MB.`);
      chunks.push(value);
    }
  } catch (error) {
    if (size > 2_000_000) throw error;
    throw new Error(`${label}: interrupted or timed-out response.`);
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (size === 0) throw new Error(`${label}: empty response.`);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error(`${label}: invalid JSON response.`); }
}

export interface ExportPage { id: string | number; name: string; text: string }

export async function stagePages(pages: ExportPage[], output: string, write: boolean) {
  if (!write) return pages.map(page => ({ id: page.id, path: join(output, page.name), status: 'preview' }));
  await mkdir(output, { recursive: true, mode: 0o700 });
  const directory = await realpath(output);
  const results = [];
  for (const page of pages) {
    if (!/^[a-zA-Z0-9_-]+\.md$/.test(page.name)) throw new Error('Invalid staging filename.');
    const target = join(directory, page.name);
    const temporary = join(directory, `.screenpipe-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(page.text);
      try {
        await link(temporary, target);
        results.push({ id: page.id, path: target, status: 'created' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await lstat(target);
        if (!stat.isFile() || await readFile(target, 'utf8') !== page.text) {
          throw new Error(`Record ${page.id}: destination exists with different content; export to a new staging directory and review the correction.`);
        }
        results.push({ id: page.id, path: target, status: 'unchanged' });
      }
    } finally {
      await file.close();
      await unlink(temporary).catch(() => {});
    }
  }
  return results;
}

export function markdownPage(metadata: Record<string, unknown>, body: string): string {
  return `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${body.trim()}\n`;
}
