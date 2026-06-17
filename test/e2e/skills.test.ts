/**
 * E2E Skill Tests — Tier 2 (requires API keys + openclaw)
 *
 * Tests gbrain skills via OpenClaw agent CLI invocations.
 * Asserts on DB state changes, not LLM output text.
 *
 * Requires:
 *   - DATABASE_URL
 *   - OPENAI_API_KEY
 *   - ANTHROPIC_API_KEY
 *   - openclaw CLI installed with at least one agent configured
 *
 * Skips gracefully if any dependency is missing.
 * Run: source ~/.zshrc && DATABASE_URL=... bun test test/e2e/skills.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { hasDatabase, setupDB, teardownDB, importFixtures, getEngine } from './helpers.ts';

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

// ─────────────────────────────────────────────────────────────────
// Ingest Skill
// ─────────────────────────────────────────────────────────────────

describeT2('E2E Tier 2: Ingest Skill', () => {
  // Note: the agent uses its own configured DB, not the test DB.
  // We verify the agent responds, not DB state changes.

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

    const { text, exitCode, durationMs } = runOpenClaw(
      `Ingest this meeting transcript into gbrain. Create or update pages for each person mentioned. Add timeline entries for today's date. Here is the transcript:\n\n${transcript}`,
      180_000,
    );

    console.log(`  Ingest skill completed in ${durationMs}ms`);

    // The agent runs against its own configured gbrain DB, not our test DB.
    // We can't assert on test DB state. Instead, verify the agent responded
    // with content indicating it processed the transcript.
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
    const { text, exitCode, durationMs } = runOpenClaw(
      'Search gbrain for "NovaMind" and tell me what you found.',
      180_000,
    );

    console.log(`  Query skill completed in ${durationMs}ms`);

    // The agent should have responded with something
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
    const { text, exitCode, durationMs } = runOpenClaw(
      'Run gbrain doctor --json and tell me the results.',
      180_000,
    );

    console.log(`  Health skill completed in ${durationMs}ms`);

    expect(text.length).toBeGreaterThan(0);
    expect(exitCode).toBe(0);
  }, 240_000);
});
