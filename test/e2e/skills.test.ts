/**
 * E2E Skill Tests — Tier 2 (requires API keys + openclaw)
 *
 * Tests gbrain skills via OpenClaw agent CLI invocations. Each test requires
 * that the agent called a gbrain MCP tool: OpenClaw exits 0 and prints text
 * even when it never reached gbrain (no MCP server configured, a rejected
 * model key), so exit code and output alone prove nothing (#8002).
 *
 * Requires:
 *   - DATABASE_URL
 *   - OPENAI_API_KEY
 *   - ANTHROPIC_API_KEY
 *   - openclaw CLI installed with at least one agent configured
 *   - GBRAIN_TEST_TIER2_MCP_TAP_LOG: the JSON-RPC log of gbrain's MCP server, which
 *     scripts/ci-openclaw-mcp.sh registers with OpenClaw behind
 *     scripts/ci-mcp-tap.sh
 *
 * Skips gracefully if any dependency is missing.
 * Run: source ~/.zshrc && DATABASE_URL=... bun test test/e2e/skills.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import { hasDatabase, setupDB, teardownDB, importFixtures, getEngine } from './helpers.ts';
import { tapToolCalls } from '../../scripts/mcp-tap-calls.ts';

// Detect the default openclaw agent
function detectAgent(): string | null {
  try {
    const result = Bun.spawnSync({
      cmd: ['openclaw', 'agents', 'list'],
      timeout: 10_000,
    });
    const output = new TextDecoder().decode(result.stdout);
    // Look for "(default)" agent or fall back to first listed
    const defaultMatch = output.match(/^- (\S+) \(default\)/m);
    if (defaultMatch) return defaultMatch[1];
    const firstMatch = output.match(/^- (\S+)/m);
    if (firstMatch) return firstMatch[1];
    return null;
  } catch {
    return null;
  }
}

// Check all Tier 2 dependencies
function hasTier2Deps(): { ok: boolean; reason?: string; agent?: string } {
  if (!hasDatabase()) return { ok: false, reason: 'DATABASE_URL not set' };
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'OPENAI_API_KEY not set' };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, reason: 'ANTHROPIC_API_KEY not set' };
  if (!process.env.GBRAIN_TEST_TIER2_MCP_TAP_LOG) return { ok: false, reason: 'GBRAIN_TEST_TIER2_MCP_TAP_LOG not set (run scripts/ci-openclaw-mcp.sh)' };

  // Check if openclaw is installed
  try {
    const result = Bun.spawnSync({ cmd: ['openclaw', '--version'], timeout: 5_000 });
    if (result.exitCode !== 0) return { ok: false, reason: 'openclaw CLI not installed' };
  } catch {
    return { ok: false, reason: 'openclaw CLI not installed' };
  }

  const agent = detectAgent();
  if (!agent) return { ok: false, reason: 'no openclaw agents configured (run openclaw setup)' };

  return { ok: true, agent };
}

const deps = hasTier2Deps();
const skip = !deps.ok;
const describeT2 = skip ? describe.skip : describe;
const AGENT_ID = deps.agent || 'main';

if (skip) {
  test.skip(`Tier 2 tests skipped: ${deps.reason}`, () => {});
  console.log(`  Skip reason: ${deps.reason}`);
}

/**
 * Run openclaw agent with a prompt in local mode (embedded, no gateway).
 * Without --json: response text goes to stdout.
 * With --json: structured JSON goes to stderr, stdout is empty.
 * We use non-JSON mode and capture stdout for simplicity.
 * Returns { text, exitCode, durationMs }.
 */
function runOpenClaw(prompt: string, timeoutMs = 120_000) {
  const start = performance.now();
  const result = Bun.spawnSync({
    cmd: [
      'openclaw', 'agent',
      '--local',
      '--agent', AGENT_ID,
      '--message', prompt,
      '--timeout', String(Math.floor(timeoutMs / 1000)),
    ],
    cwd: join(import.meta.dir, '../..'),
    env: { ...process.env },
    timeout: timeoutMs + 5_000, // bun timeout slightly longer than openclaw timeout
  });
  const durationMs = Math.round(performance.now() - start);

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);

  // In non-JSON mode, stdout contains the response text
  // Filter out the "[agents] synced ..." log line
  const text = stdout
    .split('\n')
    .filter(line => !line.startsWith('[agents]'))
    .join('\n')
    .trim();

  return {
    text,
    stdout,
    stderr,
    exitCode: result.exitCode,
    durationMs,
  };
}

/** The gbrain MCP tools the agent called while `run` ran, read from the tap log. */
function gbrainToolCalls<T>(run: () => T): { result: T; calls: string[] } {
  const log = process.env.GBRAIN_TEST_TIER2_MCP_TAP_LOG!;
  const start = existsSync(log) ? statSync(log).size : 0;
  const result = run();
  const calls = existsSync(log) ? tapToolCalls(readFileSync(log).subarray(start).toString('utf8')) : [];
  return { result, calls };
}

// ─────────────────────────────────────────────────────────────────
// Ingest Skill
// ─────────────────────────────────────────────────────────────────

describeT2('E2E Tier 2: Ingest Skill', () => {
  beforeAll(async () => {
    await setupDB();
  }, 30_000);
  afterAll(teardownDB);

  test('ingest a meeting transcript creates person pages and links', async () => {
    const transcript = `
Meeting: NovaMind Board Update — April 1, 2025
Attendees: Sarah Chen (CEO), Marcus Reid (Board, Threshold), David Kim (CFO)

Sarah presented Q1 metrics: 3 enterprise design partners signed, 47% MoM revenue growth.
Marcus asked about competitive positioning vs AutoAgent and CopilotStack.
David Kim presented runway analysis: 18 months at current burn rate.
Decision: Hire VP Sales by end of Q2.
Action: Sarah to draft VP Sales job description by April 7.
    `.trim();

    const { result: { text, exitCode, durationMs }, calls } = gbrainToolCalls(() => runOpenClaw(
      `Using the gbrain MCP tools, ingest this meeting transcript into gbrain. Create or update pages for each person mentioned. Add timeline entries for today's date. Here is the transcript:\n\n${transcript}`,
      180_000,
    ));

    console.log(`  Ingest skill completed in ${durationMs}ms; gbrain tool calls: ${calls.join(', ') || 'none'}`);

    expect(calls.length, `the agent never called a gbrain MCP tool; it said: ${text.slice(0, 500)}`).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(exitCode).toBe(0);
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────
// Query Skill
// ─────────────────────────────────────────────────────────────────

describeT2('E2E Tier 2: Query Skill', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  }, 30_000);
  afterAll(teardownDB);

  test('query skill returns results for known topic', async () => {
    const { result: { text, exitCode, durationMs }, calls } = gbrainToolCalls(() => runOpenClaw(
      'Use the gbrain MCP search tool to search gbrain for "NovaMind" and tell me what you found.',
      180_000,
    ));

    console.log(`  Query skill completed in ${durationMs}ms; gbrain tool calls: ${calls.join(', ') || 'none'}`);

    expect(calls.length, `the agent never called a gbrain MCP tool; it said: ${text.slice(0, 500)}`).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(exitCode).toBe(0);
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────
// Health Skill
// ─────────────────────────────────────────────────────────────────

describeT2('E2E Tier 2: Health Skill', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  }, 30_000);
  afterAll(teardownDB);

  test('health skill reports brain status', async () => {
    const { result: { text, exitCode, durationMs }, calls } = gbrainToolCalls(() => runOpenClaw(
      'Use the gbrain MCP tools to report the brain\'s status: call whoami and list_pages, then tell me what you found.',
      180_000,
    ));

    console.log(`  Health skill completed in ${durationMs}ms; gbrain tool calls: ${calls.join(', ') || 'none'}`);

    expect(calls.length, `the agent never called a gbrain MCP tool; it said: ${text.slice(0, 500)}`).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(exitCode).toBe(0);
  }, 240_000);
});
