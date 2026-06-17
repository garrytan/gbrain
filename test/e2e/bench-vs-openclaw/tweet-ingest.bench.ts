/**
 * Tweet ingestion bench: pull a month of tweets, write a brain page, sync.
 *
 * This is a PRODUCTION benchmark. The task is real work that an agent does
 * every day: pull tweets from the X API, parse them into a structured
 * brain page, commit to git, and sync to gbrain. It's deterministic —
 * same input always produces the same steps.
 *
 * What we measure: total wall-clock for the complete pipeline, not just
 * queue overhead. This answers: "how long does it take to ingest one
 * month of tweets?" — the question a user actually asks.
 *
 * Minions side: script calls X API → writes file → git commit → 
 * gbrain jobs submit. No LLM involved.
 *
 * OpenClaw side: sessions_spawn with a task prompt → model reads task →
 * model calls exec(curl) → model calls exec(python) → model calls
 * exec(git) → model reports back. Same work, but the model decides
 * each step.
 *
 * Budget: Minions = $0 (no LLM). OpenClaw = ~$0.03 per run (Sonnet).
 * N=5 runs each = ~$0.15 total OpenClaw spend.
 *
 * Prerequisites:
 *   - X_BEARER_TOKEN (Enterprise tier for full-archive search)
 *   - DATABASE_URL (Postgres with gbrain schema)
 *   - ANTHROPIC_API_KEY (for OpenClaw side only)
 *   - A brain repo at BRAIN_PATH (default: /data/brain)
 *   - OpenClaw installed (for OC side; skip OC tests if not available)
 *
 * Run:
 *   X_BEARER_TOKEN=... DATABASE_URL=... bun test test/e2e/bench-vs-openclaw/tweet-ingest.bench.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { performance } from 'node:perf_hooks';
import { existsSync, writeFileSync, mkdirSync, unlinkSync, readFileSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { hasDatabase, setupDB, teardownDB, getEngine } from '../helpers.ts';
import { MinionQueue } from '../../../src/core/minions/queue.ts';
import { statsFromResults, formatStats, type CallResult } from './harness.ts';

const BRAIN_PATH = process.env.BRAIN_PATH || '/data/brain';
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const N = 5; // runs per method

// Use months from 2020 that are unlikely to already exist
const TEST_MONTHS = ['2020-07', '2020-08', '2020-09', '2020-10', '2020-11'];

// --- Helpers ---

function pagePath(month: string): string {
  return join(BRAIN_PATH, 'media', 'x', 'garrytan', `${month}.md`);
}

function rawPath(month: string): string {
  return join(BRAIN_PATH, 'media', 'x', 'garrytan', '.raw', `${month}-bench.json`);
}

async function pullTweets(month: string): Promise<{ count: number; rawJson: string }> {
  const [year, m] = month.split('-');
  const nextMonth = parseInt(m) === 12 
    ? `${parseInt(year) + 1}-01` 
    : `${year}-${String(parseInt(m) + 1).padStart(2, '0')}`;
  
  const url = `https://api.x.com/2/tweets/search/all?query=from%3Agarrytan&max_results=100&start_time=${month}-01T00:00:00Z&end_time=${nextMonth}-01T00:00:00Z&tweet.fields=created_at,public_metrics`;
  
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${X_BEARER_TOKEN}` },
  });
  const raw = await resp.text();
  const data = JSON.parse(raw);
  return { count: data.data?.length ?? 0, rawJson: raw };
}

function writeBrainPage(month: string, rawJson: string): number {
  const data = JSON.parse(rawJson);
  const tweets = (data.data || []).sort(
    (a: any, b: any) => (a.created_at || '').localeCompare(b.created_at || '')
  );
  
  const seen = new Set<string>();
  const unique = tweets.filter((t: any) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  
  const dir = join(BRAIN_PATH, 'media', 'x', 'garrytan');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.raw'), { recursive: true });
  
  // Save raw JSON
  writeFileSync(rawPath(month), rawJson);
  
  // Write brain page
  let page = `---\ntitle: "@garrytan — ${month}"\ntype: media/x-account/monthly\ntags: [x-archive, garrytan, benchmark]\n---\n\n# @garrytan — ${month}\n\n> ${unique.length} tweets (benchmark run).\n\n`;
  
  for (const t of unique) {
    const date = (t.created_at || '').slice(0, 10);
    const text = (t.text || '').replace(/\n/g, ' ').slice(0, 200);
    const likes = t.public_metrics?.like_count || 0;
    page += `- **${date}** [${text}](https://x.com/garrytan/status/${t.id})\n`;
    if (likes > 50) page += `  ❤️ ${likes}\n`;
  }
  
  writeFileSync(pagePath(month), page);
  return unique.length;
}

function gitCommit(month: string): void {
  try {
    execSync(`git add media/x/garrytan/${month}.md media/x/garrytan/.raw/${month}-bench.json`, {
      cwd: BRAIN_PATH, stdio: 'pipe',
    });
    execSync(`git commit -m "bench: ${month} tweet ingest" --allow-empty`, {
      cwd: BRAIN_PATH, stdio: 'pipe',
    });
  } catch { /* may already be committed */ }
}

function cleanup(month: string): void {
  try { unlinkSync(pagePath(month)); } catch {}
  try { unlinkSync(rawPath(month)); } catch {}
  try {
    execSync(`git checkout -- media/x/garrytan/${month}.md 2>/dev/null; git clean -f media/x/garrytan/${month}.md 2>/dev/null`, {
      cwd: BRAIN_PATH, stdio: 'pipe',
    });
  } catch {}
}

// --- Minions pipeline ---

async function minionsPipeline(month: string, engine: any): Promise<CallResult> {
  const t0 = performance.now();
  try {
    // 1. Pull tweets
    const { rawJson } = await pullTweets(month);
    
    // 2. Write brain page
    const count = writeBrainPage(month, rawJson);
    
    // 3. Git commit
    gitCommit(month);
    
    // 4. Submit sync job to Minions
    const queue = new MinionQueue(engine);
    await queue.add('sync', { repo: BRAIN_PATH, noPull: true, bench: true });
    
    const wallMs = Math.round(performance.now() - t0);
    return { ok: true, wallMs, reply: `${count} tweets` };
  } catch (err) {
    return { ok: false, wallMs: Math.round(performance.now() - t0), error: String(err) };
  }
}

// --- OpenClaw sub-agent pipeline ---

async function openclawPipeline(month: string): Promise<CallResult> {
  const t0 = performance.now();
  const [year, m] = month.split('-');
  const nextMonth = parseInt(m) === 12 
    ? `${parseInt(year) + 1}-01` 
    : `${year}-${String(parseInt(m) + 1).padStart(2, '0')}`;
  
  const task = `Pull @garrytan tweets for ${month} and save as a brain page.
1. Run: curl -s -H "Authorization: Bearer $X_BEARER_TOKEN" "https://api.x.com/2/tweets/search/all?query=from%3Agarrytan&max_results=100&start_time=${month}-01T00:00:00Z&end_time=${nextMonth}-01T00:00:00Z&tweet.fields=created_at,public_metrics" > /tmp/bench-${month}.json
2. Parse the JSON, write a brain page to ${BRAIN_PATH}/media/x/garrytan/${month}.md with frontmatter + tweet list
3. Git commit
4. Report tweet count`;
  
  return new Promise((resolve) => {
    const proc = spawn('openclaw', [
      'agent', '--agent', 'main', '--local',
      '--message', task,
      '--timeout', '60',
    ], { env: process.env });
    
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    
    const killer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({
        ok: false,
        wallMs: Math.round(performance.now() - t0),
        error: 'timeout (60s)',
      });
    }, 70_000);
    
    proc.on('close', (code) => {
      clearTimeout(killer);
      const wallMs = Math.round(performance.now() - t0);
      const reply = stdout.split('\n').filter(l => !l.startsWith('[')).join('\n').trim();
      resolve(code === 0 && reply.length > 0
        ? { ok: true, wallMs, reply }
        : { ok: false, wallMs, error: stderr.slice(-500) || `exit=${code}` });
    });
    
    proc.on('error', (err) => {
      clearTimeout(killer);
      resolve({ ok: false, wallMs: Math.round(performance.now() - t0), error: String(err) });
    });
  });
}

// --- Tests ---

describe('Tweet Ingestion: Minions vs OpenClaw', () => {
  const hasDB = hasDatabase();
  const hasX = !!X_BEARER_TOKEN;
  const hasBrain = existsSync(BRAIN_PATH);
  
  let engine: any;
  
  beforeAll(async () => {
    if (hasDB) {
      await setupDB();
      engine = getEngine();
    }
  });
  
  afterAll(async () => {
    // Cleanup test pages
    for (const month of TEST_MONTHS) {
      cleanup(month);
    }
    if (hasDB) await teardownDB();
  });
  
  test.skipIf(!hasDB || !hasX || !hasBrain)(
    `Minions: ${N} serial tweet ingestions`,
    async () => {
      const results: CallResult[] = [];
      
      for (let i = 0; i < N; i++) {
        const month = TEST_MONTHS[i];
        cleanup(month); // ensure clean slate
        const result = await minionsPipeline(month, engine);
        results.push(result);
        console.log(`  Minions run ${i + 1}: ${result.wallMs}ms ${result.ok ? '✅' : '❌'} ${result.reply || result.error}`);
      }
      
      const stats = statsFromResults(results);
      console.log('\n' + formatStats('Minions (tweet ingest)', stats));
      
      expect(stats.successes).toBeGreaterThan(0);
    },
    120_000,
  );
  
  test.skipIf(!hasX || !hasBrain)(
    `OpenClaw: ${N} serial tweet ingestions`,
    async () => {
      // Check if openclaw is available
      try {
        execSync('which openclaw', { stdio: 'pipe' });
      } catch {
        console.log('  openclaw not found in PATH — skipping OC benchmark');
        return;
      }
      
      const results: CallResult[] = [];
      
      for (let i = 0; i < N; i++) {
        const month = TEST_MONTHS[i];
        cleanup(month); // ensure clean slate
        const result = await openclawPipeline(month);
        results.push(result);
        console.log(`  OpenClaw run ${i + 1}: ${result.wallMs}ms ${result.ok ? '✅' : '❌'} ${result.reply || result.error}`);
      }
      
      const stats = statsFromResults(results);
      console.log('\n' + formatStats('OpenClaw (tweet ingest)', stats));
    },
    600_000, // 10 min total for 5 OC runs
  );
  
  test.skipIf(!hasDB || !hasX || !hasBrain)(
    'Summary comparison',
    async () => {
      // This test just prints the summary — actual data comes from above
      console.log('\n=== TWEET INGESTION BENCHMARK ===');
      console.log('Task: pull ~100 tweets from X API, write brain page, git commit, submit sync');
      console.log(`Runs: ${N} per method, serial`);
      console.log('Model: none (Minions) vs claude-sonnet-4 (OpenClaw)');
      console.log('Environment: ' + (process.env.RENDER ? 'Render' : process.env.FLY_APP_NAME ? 'Fly' : 'local'));
      console.log('Brain size: ' + (existsSync(BRAIN_PATH) ? execSync(`find ${BRAIN_PATH} -name "*.md" | wc -l`, { encoding: 'utf-8' }).trim() + ' pages' : 'unknown'));
    },
  );
});
