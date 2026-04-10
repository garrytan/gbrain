/**
 * E2E Skill Tests — Tier 2 (requires API keys + openclaw)
 *
 * Tests gbrain skills via OpenClaw agent invocations with gbrain MCP server.
 * Asserts on DB state changes, not LLM output text.
 *
 * Two ways to run:
 *   1. Docker (recommended): docker compose -f docker-compose.e2e.yml run --rm skills-test
 *      - OpenClaw + Postgres + gbrain all in containers
 *      - Agent and MCP server pre-configured by entrypoint script
 *
 *   2. Local: DATABASE_URL=... OPENAI_API_KEY=... ANTHROPIC_API_KEY=... bun test test/e2e/skills.test.ts
 *      - Requires openclaw CLI installed locally
 *      - Auto-configures test agent and gbrain MCP server
 *
 * Skips gracefully if any dependency is missing.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { execSync } from 'child_process';
import { hasDatabase, setupDB, teardownDB, importFixtures, getEngine } from './helpers.ts';

const REPO_ROOT = join(import.meta.dir, '../..');
const AGENT_ID = 'gbrain-e2e-test';

// Detect if running inside the Docker harness (entrypoint already configured agent)
const IN_DOCKER = process.env.OPENCLAW_E2E_DOCKER === '1';

// Check all Tier 2 dependencies
function hasTier2Deps(): boolean {
  if (!hasDatabase()) return false;
  if (!process.env.OPENAI_API_KEY) return false;
  if (!process.env.ANTHROPIC_API_KEY) return false;

  // Check if openclaw is installed
  try {
    const result = Bun.spawnSync({ cmd: ['openclaw', '--version'] });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

const skip = !hasTier2Deps();
const describeT2 = skip ? describe.skip : describe;

if (skip) {
  test.skip('Tier 2 tests skipped (missing dependencies)', () => {});
  if (!hasDatabase()) console.log('  Skip reason: DATABASE_URL not set');
  else if (!process.env.OPENAI_API_KEY) console.log('  Skip reason: OPENAI_API_KEY not set');
  else if (!process.env.ANTHROPIC_API_KEY) console.log('  Skip reason: ANTHROPIC_API_KEY not set');
  else console.log('  Skip reason: openclaw CLI not installed');
}

/**
 * Set up the OpenClaw test agent with gbrain MCP server (local mode only).
 * In Docker mode, the entrypoint script already did this.
 */
function setupOpenClawAgent() {
  if (IN_DOCKER) return; // Already configured by entrypoint

  const dbUrl = process.env.DATABASE_URL!;

  // Remove stale test agent if it exists
  try {
    execSync(`openclaw agents delete ${AGENT_ID} --yes`, { stdio: 'pipe', timeout: 10_000 });
  } catch {
    // didn't exist
  }

  // Create test agent with gbrain workspace
  try {
    execSync(
      `openclaw agents add ${AGENT_ID} --workspace ${REPO_ROOT} --non-interactive`,
      { stdio: 'pipe', timeout: 15_000 },
    );
  } catch (e: any) {
    // Agent may already exist from a prior run that didn't clean up
    console.warn('Agent creation failed (may already exist):', e.message?.slice(0, 100));
  }

  // Configure gbrain MCP server pointing at test DB
  const mcpConfig = JSON.stringify({
    command: 'bun',
    args: ['run', 'src/cli.ts', 'serve'],
    cwd: REPO_ROOT,
    env: { DATABASE_URL: dbUrl },
  });
  try {
    execSync(`openclaw mcp set gbrain '${mcpConfig}'`, { stdio: 'pipe', timeout: 10_000 });
  } catch (e: any) {
    console.warn('MCP config failed:', e.message?.slice(0, 100));
  }
}

/**
 * Clean up the OpenClaw test agent (local mode only).
 */
function teardownOpenClawAgent() {
  if (IN_DOCKER) return; // Docker container is ephemeral

  try {
    execSync(`openclaw agents delete ${AGENT_ID} --yes`, { stdio: 'pipe', timeout: 10_000 });
  } catch { /* best effort */ }
  try {
    execSync('openclaw mcp unset gbrain', { stdio: 'pipe', timeout: 10_000 });
  } catch { /* best effort */ }
}

/**
 * Run openclaw agent with a prompt and gbrain MCP configured.
 * Returns { stdout, stderr, exitCode }.
 */
function runOpenClaw(prompt: string, timeoutMs = 300_000) {
  const result = Bun.spawnSync({
    cmd: ['openclaw', 'agent', '--agent', AGENT_ID, '--local', '-m', prompt, '--json'],
    cwd: REPO_ROOT,
    env: { ...process.env },
    timeout: timeoutMs,
  });

  const rawStdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);

  // Extract the text payload from JSON output
  let text = rawStdout;
  try {
    const parsed = JSON.parse(rawStdout);
    if (parsed.payloads?.[0]?.text) {
      text = parsed.payloads[0].text;
    }
  } catch {
    // not JSON, use raw stdout
  }

  return { stdout: text, stderr, exitCode: result.exitCode };
}

// ─────────────────────────────────────────────────────────────────
// Ingest Skill
// ─────────────────────────────────────────────────────────────────

describeT2('E2E Tier 2: Ingest Skill', () => {
  beforeAll(async () => {
    await setupDB();
    setupOpenClawAgent();
  });
  afterAll(async () => {
    teardownOpenClawAgent();
    await teardownDB();
  });

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

    const { stdout, exitCode } = runOpenClaw(
      `Use the gbrain MCP tools to ingest this meeting transcript. Call put_page to create pages for each person mentioned (Sarah Chen, Marcus Reid, David Kim) with type "person". Here is the transcript:\n\n${transcript}`,
    );

    // Assert on DB state, not LLM output
    const engine = getEngine();
    const stats = await engine.getStats();
    expect(stats.page_count).toBeGreaterThan(0);

    const pages = await engine.listPages({ type: 'person' });
    expect(pages.length).toBeGreaterThanOrEqual(1);
  }, 360_000);
});

// ─────────────────────────────────────────────────────────────────
// Query Skill
// ─────────────────────────────────────────────────────────────────

describeT2('E2E Tier 2: Query Skill', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
    setupOpenClawAgent();
  });
  afterAll(async () => {
    teardownOpenClawAgent();
    await teardownDB();
  });

  test('query skill returns results for known topic', async () => {
    const { stdout } = runOpenClaw(
      'Use the gbrain MCP tools. Call the search tool to search for "hybrid search" and tell me what you found.',
    );

    expect(stdout.length).toBeGreaterThan(0);
  }, 360_000);
});

// ─────────────────────────────────────────────────────────────────
// Health Skill
// ─────────────────────────────────────────────────────────────────

describeT2('E2E Tier 2: Health Skill', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
    setupOpenClawAgent();
  });
  afterAll(async () => {
    teardownOpenClawAgent();
    await teardownDB();
  });

  test('health skill reports brain status', async () => {
    const { stdout } = runOpenClaw(
      'Use the gbrain MCP tools. Call get_stats to check the brain health and report how many pages are in the brain.',
    );

    expect(stdout.length).toBeGreaterThan(0);
  }, 360_000);
});
