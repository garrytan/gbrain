/**
 * Bench harness: Minions vs OpenClaw subagent dispatch.
 *
 * Both sides run the SAME LLM call (anthropic/claude-haiku-4-5) with
 * the SAME trivial prompt. What we measure is the queue+dispatch
 * overhead each system adds ON TOP of that identical LLM work.
 *
 * OpenClaw entry point: `openclaw agent --local` (embedded agent,
 * no gateway). This is how users invoke OC from scripts. Each call
 * is a full process spawn that boots the agent runtime, auth, plugins,
 * then calls the LLM.
 *
 * Minions entry point: `queue.add` -> worker picks it up -> handler
 * calls Anthropic SDK directly. Worker stays warm across jobs.
 *
 * Caveat: we do NOT test OpenClaw's gateway multi-agent fan-out —
 * that requires a custom WS client and LLM-backed parent agent,
 * ~5× more complexity. `--local` measures the dispatch cost users
 * actually script against today.
 */

import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export const BENCH_MODEL = 'claude-haiku-4-5';
export const BENCH_PROMPT = 'Reply with just: OK. No other text.';

export interface CallResult {
  ok: boolean;
  wallMs: number;
  reply?: string;
  error?: string;
}

/**
 * One OpenClaw dispatch via `openclaw agent --local`.
 * Reports wall-clock from spawn to exit.
 */
export async function openclawDispatch(
  prompt = BENCH_PROMPT,
  timeoutSec = 60,
): Promise<CallResult> {
  const t0 = performance.now();
  return await new Promise((resolve) => {
    const proc = spawn(
      'openclaw',
      ['agent', '--agent', 'main', '--local', '--message', prompt, '--timeout', String(timeoutSec)],
      { env: process.env },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    const killer = setTimeout(() => {
      proc.kill('SIGKILL');
    }, (timeoutSec + 10) * 1000);
    proc.on('close', (code) => {
      clearTimeout(killer);
      const wallMs = Math.round(performance.now() - t0);
      const reply = stdout
        .split('\n')
        .filter((l) => !l.startsWith('[agents]') && !l.startsWith('['))
        .join('\n')
        .trim();
      if (code === 0 && reply.length > 0) {
        resolve({ ok: true, wallMs, reply });
      } else {
        resolve({
          ok: false,
          wallMs,
          error: stderr.slice(-500) || `exit=${code}`,
        });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(killer);
      resolve({
        ok: false,
        wallMs: Math.round(performance.now() - t0),
        error: String(err),
      });
    });
  });
}

/**
 * Direct Anthropic SDK call — what a Minions handler does.
 * Same model, same prompt as openclawDispatch. No queue overhead.
 */
export async function minionsHandler(
  prompt = BENCH_PROMPT,
): Promise<CallResult> {
  const t0 = performance.now();
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: BENCH_MODEL,
      max_tokens: 64,
      messages: [{ role: 'user', content: prompt }],
    });
    const reply =
      resp.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('')
        .trim() || '';
    return {
      ok: true,
      wallMs: Math.round(performance.now() - t0),
      reply,
    };
  } catch (err) {
    return {
      ok: false,
      wallMs: Math.round(performance.now() - t0),
      error: String(err),
    };
  }
}

export interface BenchStats {
  n: number;
  successes: number;
  failures: number;
  totalWallMs: number;
  meanMs: number;
  p50: number;
  p95: number;
  p99: number;
  minMs: number;
  maxMs: number;
}

export function statsFromResults(results: CallResult[]): BenchStats {
  const successes = results.filter((r) => r.ok);
  const times = successes.map((r) => r.wallMs).sort((a, b) => a - b);
  const q = (p: number) => {
    if (times.length === 0) return 0;
    const idx = Math.min(times.length - 1, Math.floor(times.length * p));
    return times[idx];
  };
  const mean =
    times.length === 0
      ? 0
      : Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  return {
    n: results.length,
    successes: successes.length,
    failures: results.length - successes.length,
    totalWallMs: results.reduce((a, r) => a + r.wallMs, 0),
    meanMs: mean,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    minMs: times[0] ?? 0,
    maxMs: times[times.length - 1] ?? 0,
  };
}

export function formatStats(label: string, s: BenchStats): string {
  return `${label.padEnd(24)} n=${s.n} ok=${s.successes} fail=${s.failures} mean=${s.meanMs}ms p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms min=${s.minMs}ms max=${s.maxMs}ms`;
}
