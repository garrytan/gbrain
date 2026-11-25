#!/usr/bin/env bun
/**
 * The eval-gates pin publisher (.github/workflows/eval-gates-pin.yml; swap criterion 10, plan c-ts).
 *
 *   GH_TOKEN=<token> bun run scripts/eval-gates-pin.ts --out <dir> [--github-output]
 *
 * For each of the last 100 releases of gbrain (the FINAL eval file lands about two days after a tag, and releases come
 * several a day, so a window of 10 let a delayed file's release fall out before its file arrived) it lists `eval/results/engine-bench/eval-gates/<tag>/` on gbrain-evals main
 * and reads each file at `evals_ref`, the squash commit on main that landed it (the file is never rewritten, so that
 * commit never changes and the pin of an old release comes out byte for byte the same on every run). It takes the
 * first FINAL file that is for THAT release (its own `gbrain_tag`, never today's VERSION) and whose tag resolves to the file's `gbrain_commit`,
 * and writes `<out>/<tag>/gbrain-eval-gates.pin.json` for the workflow to attach to that release. A release that has
 * the pin already is checked, not rewritten: an identical pin is a no-op, a different one fails the run and names the
 * tag, because replacing a pin must be an explicit repair.
 *
 * The data it reads is parsed, never run: nothing fetched reaches a shell, a path (tags are matched against FINAL_TAG
 * first) or a command. The publish job only uploads the files this step wrote.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalGatesPath, evalGatesUrl, FINAL_TAG, MAX_FILE_BYTES, parseEvalGatesFile, PIN_ASSET, type EvalGatesPin } from '../src/shadow/eval-gates.ts';

const API = 'https://api.github.com';
const RELEASES_LOOKED_AT = 100;

export interface ReleaseInfo { tag: string; assets: Array<{ name: string; url: string }> }

/** What the publisher reads from GitHub; tests replace it. A missing thing is `null`, a failure throws. */
export interface PinSource {
  releases(): Promise<ReleaseInfo[]>;
  /** File names under the tag's eval-gates directory on gbrain-evals main; [] when the directory does not exist. */
  evalFiles(tag: string): Promise<string[]>;
  /** The commit on main that added the file at `path` (the oldest commit that touched it), or null when none did. */
  landingCommit(path: string): Promise<string | null>;
  evalFileText(path: string, ref: string): Promise<string>;
  /** The commit the tag points at, or null when the tag does not exist. */
  tagCommit(tag: string): Promise<string | null>;
  assetText(url: string): Promise<string>;
}

export interface PinPlan {
  publish: Array<{ tag: string; pin: EvalGatesPin }>;
  unchanged: string[];
  waiting: string[];
  conflicts: Array<{ tag: string; reason: string }>;
}

export function buildPin(tag: string, text: string, name: string, ref: string, tagCommit: string | null): EvalGatesPin | null {
  const file = parseEvalGatesFile(text);
  if (!file || file.status !== 'FINAL' || file.gbrain_tag !== tag || !FINAL_TAG.test(tag)) return null;
  if (name !== `${file.evals_commit}.json` || tagCommit === null || tagCommit !== file.gbrain_commit) return null;
  const path = evalGatesPath(file.evals_commit, tag);
  return {
    schema_version: 1, gbrain_tag: tag, gbrain_commit: file.gbrain_commit, evals_commit: file.evals_commit, evals_ref: ref, path,
    url: evalGatesUrl(ref, path), sha256: createHash('sha256').update(text).digest('hex'), target: file.target,
  };
}

const canonical = (pin: unknown): string => JSON.stringify(pin, Object.keys(pin as object).sort());

/** Decides, per release, whether to publish a pin, leave an existing one, or fail on a conflicting one. */
export async function planPins(source: PinSource): Promise<PinPlan> {
  const plan: PinPlan = { publish: [], unchanged: [], waiting: [], conflicts: [] };
  const releases = (await source.releases()).filter(r => FINAL_TAG.test(r.tag)).slice(0, RELEASES_LOOKED_AT);
  for (const release of releases) {
    const found = await findPin(source, release.tag);
    const existing = release.assets.find(a => a.name === PIN_ASSET);
    if (!existing) { if (found) plan.publish.push({ tag: release.tag, pin: found }); else plan.waiting.push(release.tag); continue; }
    if (!found) { plan.unchanged.push(release.tag); continue; }
    let same = false;
    try { same = canonical(JSON.parse(await source.assetText(existing.url))) === canonical(found); } catch { same = false; } // silent-read-ok: an unreadable existing pin is reported as a conflict below
    if (same) plan.unchanged.push(release.tag);
    else plan.conflicts.push({ tag: release.tag, reason: `${release.tag} already has a different ${PIN_ASSET}; replacing a pin needs an explicit repair` });
  }
  return plan;
}

async function findPin(source: PinSource, tag: string): Promise<EvalGatesPin | null> {
  const names = (await source.evalFiles(tag)).filter(n => /^[A-Za-z0-9._-]+\.json$/.test(n));
  const candidates: Array<{ name: string; text: string; at: number; ref: string }> = [];
  for (const name of names) {
    const path = `eval/results/engine-bench/eval-gates/${tag}/${name}`;
    const ref = await source.landingCommit(path);
    if (!ref || !/^[0-9a-f]{40}$/.test(ref)) continue;
    const text = await source.evalFileText(path, ref);
    const file = parseEvalGatesFile(text);
    candidates.push({ name, text, at: file ? Date.parse(file.generated_at) || 0 : 0, ref });
  }
  candidates.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  const commit = candidates.length ? await source.tagCommit(tag) : null;
  for (const c of candidates) {
    const pin = buildPin(tag, c.text, c.name, c.ref, commit);
    if (pin) return pin;
  }
  return null;
}

/** GitHub's REST API with a token, bounded in time and size. */
export function githubSource(token: string, doFetch: typeof fetch = fetch): PinSource {
  const get = async (url: string, accept = 'application/vnd.github+json'): Promise<Response> =>
    doFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20_000) });
  const json = async <T>(url: string): Promise<T | null> => {
    const res = await get(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${url.replace(API, '')} answered ${res.status}`);
    return await res.json() as T;
  };
  const text = async (url: string, accept?: string): Promise<string> => {
    const res = await get(url, accept);
    if (!res.ok) throw new Error(`GET ${url.replace(API, '')} answered ${res.status}`);
    const body = await res.text();
    if (Buffer.byteLength(body) > MAX_FILE_BYTES) throw new Error('a file is over the size cap');
    return body;
  };
  return {
    releases: async () => {
      const list = await json<Array<{ tag_name: string; draft: boolean; assets: Array<{ name: string; url: string }> }>>(`${API}/repos/garrytan/gbrain/releases?per_page=${RELEASES_LOOKED_AT}`);
      return (list ?? []).filter(r => !r.draft).map(r => ({ tag: r.tag_name, assets: r.assets.map(a => ({ name: a.name, url: a.url })) }));
    },
    evalFiles: async tag => {
      const list = await json<Array<{ name: string; type: string }>>(`${API}/repos/garrytan/gbrain-evals/contents/eval/results/engine-bench/eval-gates/${tag}?ref=main`);
      return (list ?? []).filter(f => f.type === 'file').map(f => f.name);
    },
    landingCommit: async path => {
      const list = await json<Array<{ sha: string }>>(`${API}/repos/garrytan/gbrain-evals/commits?sha=main&path=${encodeURIComponent(path)}&per_page=100`);
      return list?.length ? list[list.length - 1]!.sha : null;
    },
    evalFileText: (path, ref) => text(`${API}/repos/garrytan/gbrain-evals/contents/${path}?ref=${ref}`, 'application/vnd.github.raw+json'),
    tagCommit: async tag => {
      const ref = await json<{ object: { type: string; sha: string } }>(`${API}/repos/garrytan/gbrain/git/ref/tags/${tag}`);
      if (!ref) return null;
      if (ref.object.type === 'commit') return ref.object.sha;
      const annotated = await json<{ object: { type: string; sha: string } }>(`${API}/repos/garrytan/gbrain/git/tags/${ref.object.sha}`);
      return annotated?.object.type === 'commit' ? annotated.object.sha : null;
    },
    assetText: url => text(url, 'application/octet-stream'),
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const out = args[args.indexOf('--out') + 1];
  if (args.indexOf('--out') < 0 || !out) { console.error('eval-gates-pin: --out <dir> is required'); return 2; }
  const token = process.env.GH_TOKEN;
  if (!token) { console.error('eval-gates-pin: GH_TOKEN is required'); return 2; }
  const plan = await planPins(githubSource(token));
  for (const { tag, pin } of plan.publish) {
    mkdirSync(join(out, tag), { recursive: true });
    writeFileSync(join(out, tag, PIN_ASSET), JSON.stringify(pin, null, 2) + '\n');
  }
  const tags = plan.publish.map(p => p.tag);
  console.log(JSON.stringify({ publish: tags, unchanged: plan.unchanged, waiting: plan.waiting, conflicts: plan.conflicts }, null, 2));
  if (args.includes('--github-output') && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tags=${tags.join(' ')}\n`);
  for (const c of plan.conflicts) console.error(`::error::${c.reason}`);
  return plan.conflicts.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
