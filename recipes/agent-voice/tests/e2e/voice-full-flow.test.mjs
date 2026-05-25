/**
 * voice-full-flow.test.mjs — openclaw-driven install + voice roundtrip.
 *
 * The user's headline ask: prove that openclaw can install agent-voice from
 * scratch into a fresh host repo, start the voice server, and answer a real
 * voice question.
 *
 * Pipeline:
 *   1. Create scratch dir → /tmp/agent-voice-fullflow-<uuid>/
 *   2. Seed as fake host repo (.git init, AGENTS.md stub)
 *   3. Spawn openclaw with BRIEF.md that says:
 *      "Run `gbrain integrations install agent-voice --target $PWD`.
 *       Then start the voice server: `bun run start` (or `npm start`).
 *       Wait for /health to respond."
 *   4. Wait ≤5min for openclaw exit OR /health response.
 *   5. Assert filesystem (server.mjs exists, .gbrain-source.json shape, no PII leak)
 *   6. Drive the roundtrip via shared lib/browser-audio.mjs.
 *   7. Three-tier assertions (CONNECTION hard, NON-SILENT hard, SEMANTIC soft).
 *   8. Collect friction artifacts.
 *
 * Cost: ~$1-2/run. Pre-ship + nightly friction-discovery (NOT a ship gate).
 *
 * Env-gated: set AGENT_VOICE_FULL_E2E=1 + OPENAI_API_KEY + ANTHROPIC_API_KEY + OPENCLAW_BIN.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowserRoundtrip } from './lib/browser-audio.mjs';
import { transcribeAndJudge } from './lib/whisper-judge.mjs';
import { classifyFailure, verdictFor } from '../../code/lib/upstream-classifier.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_AUDIO = join(__dirname, 'audio-fixtures', 'utterance-add.wav');

const SHOULD_RUN =
  process.env.AGENT_VOICE_FULL_E2E === '1' &&
  !!process.env.OPENAI_API_KEY &&
  !!process.env.ANTHROPIC_API_KEY &&
  !!process.env.OPENCLAW_BIN;

const PORT = parseInt(process.env.AGENT_VOICE_TEST_PORT || '8766', 10);
const SERVER_URL = `http://localhost:${PORT}`;

let scratchDir;
let serverProcess;
let openclawProcess;

function findGbrainBin() {
  // Try the local checkout's CLI first; fall back to global gbrain.
  const local = resolve(__dirname, '..', '..', '..', '..', 'src', 'cli.ts');
  if (existsSync(local)) return { bin: 'bun', args: ['run', local] };
  const which = spawnSync('which', ['gbrain'], { encoding: 'utf-8' });
  if (which.status === 0 && which.stdout.trim()) return { bin: which.stdout.trim(), args: [] };
  return null;
}

async function waitForHealth(url, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;

  scratchDir = mkdtempSync(join(tmpdir(), 'agent-voice-fullflow-'));
  // Seed as fake host repo.
  spawnSync('git', ['init', '-q'], { cwd: scratchDir });
  writeFileSync(join(scratchDir, 'AGENTS.md'), '# stub\n');

  const gbrainBin = findGbrainBin();
  if (!gbrainBin) throw new Error('gbrain CLI not found (checked local checkout + $PATH)');

  // Write BRIEF.md the openclaw runner will pick up.
  const brief = [
    '# Brief: Install agent-voice and start the voice server',
    '',
    'You are installing the agent-voice reference into a fresh host agent repo.',
    'The target repo is your $PWD (already a git repo with an AGENTS.md stub).',
    '',
    '## Steps',
    '',
    '1. Run: `' + (typeof gbrainBin === 'object' ? `${gbrainBin.bin} ${gbrainBin.args.join(' ')}` : gbrainBin) + ' integrations install agent-voice --target ' + scratchDir + '`',
    '2. After it completes, run the test command:',
    '   `cd ' + join(scratchDir, 'services/voice-agent') + ' && bun install && bun run test`',
    '3. Start the voice server on port ' + PORT + ':',
    '   `PORT=' + PORT + ' bun run start &`',
    '4. Wait for ' + SERVER_URL + '/health to return {ok: true}.',
    '5. Print "READY" and exit.',
    '',
    'If anything is confusing, run `gbrain friction log` with severity=error.',
  ].join('\n');
  writeFileSync(join(scratchDir, 'BRIEF.md'), brief);

  console.log(`[full-flow] scratch dir: ${scratchDir}`);

  // Step 3: spawn openclaw.
  openclawProcess = spawn(process.env.OPENCLAW_BIN, ['agent', '--local', '--message', `Read ${join(scratchDir, 'BRIEF.md')} and execute it.`], {
    cwd: scratchDir,
    env: {
      ...process.env,
      OPENCLAW_WORKSPACE: scratchDir,
      PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  openclawProcess.stdout.on('data', (b) => process.stderr.write(`[openclaw] ${b}`));
  openclawProcess.stderr.on('data', (b) => process.stderr.write(`[openclaw-err] ${b}`));

  // Step 4: wait for /health OR openclaw exit.
  const healthUp = await Promise.race([
    waitForHealth(SERVER_URL, 5 * 60_000),
    new Promise((r) => openclawProcess.once('exit', () => r(false))),
  ]);

  if (!healthUp) {
    // openclaw failed to bring server up. The test will still try, but record this.
    console.warn('[full-flow] openclaw did not bring server up — test will likely fail');
  }
}, 6 * 60_000);

afterAll(async () => {
  if (openclawProcess && !openclawProcess.killed) {
    openclawProcess.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
    if (!openclawProcess.killed) openclawProcess.kill('SIGKILL');
  }
  // Best-effort kill any child server openclaw spawned (port-scoped).
  try { spawnSync('pkill', ['-f', `PORT=${PORT}`]); } catch { /* ignore */ }
  // Keep scratch dir for inspection on failure; rmSync only on clean exit.
  if (scratchDir && process.env.AGENT_VOICE_KEEP_SCRATCH !== '1') {
    try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
  } else if (scratchDir) {
    console.log(`[full-flow] scratch dir preserved: ${scratchDir}`);
  }
});

describe.skipIf(!SHOULD_RUN)('voice-full-flow E2E (openclaw + roundtrip)', () => {
  it('openclaw installs agent-voice and starts the server', () => {
    expect(existsSync(join(scratchDir, 'services/voice-agent/code/server.mjs')), 'server.mjs missing post-install').toBe(true);
    expect(existsSync(join(scratchDir, 'services/voice-agent/.gbrain-source.json')), '.gbrain-source.json missing').toBe(true);

    const manifest = JSON.parse(readFileSync(join(scratchDir, 'services/voice-agent/.gbrain-source.json'), 'utf8'));
    expect(manifest.recipe).toBe('agent-voice');
    expect(manifest.install_kind).toBe('copy-into-host-repo');
    expect(manifest.upstream_repo).toBeUndefined(); // D11-A
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files.length).toBeGreaterThan(20);

    // Resolver rows appended.
    const agentsMd = readFileSync(join(scratchDir, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('voice-persona-mars');
    expect(agentsMd).toContain('voice-persona-venus');

    // Persona files exist.
    expect(existsSync(join(scratchDir, 'services/voice-agent/code/lib/personas/mars.mjs'))).toBe(true);
    expect(existsSync(join(scratchDir, 'services/voice-agent/code/lib/personas/venus.mjs'))).toBe(true);

    // No PII leak — re-run the guard against the copied tree.
    // (We can't easily invoke the gbrain-side guard here; the guard ran during install via gbrain CI.)
    // Spot-check: any term from $AGENT_VOICE_PII_BLOCKLIST should not appear in any copied file.
    // Literal banned names deliberately NOT in this source file per CLAUDE.md.
    if (process.env.AGENT_VOICE_PII_BLOCKLIST) {
      const pattern = process.env.AGENT_VOICE_PII_BLOCKLIST; // pipe-separated regex source
      const grep = spawnSync('grep', ['-riE', '--include=*.mjs', '--include=*.md', pattern, join(scratchDir, 'services/voice-agent')], { encoding: 'utf-8' });
      expect(grep.stdout, `blocklist term leaked in copied files:\n${grep.stdout}`).toBe('');
    }
  });

  it('drives a WebRTC roundtrip and asserts audio quality', async () => {
    const result = await runBrowserRoundtrip({
      serverUrl: SERVER_URL,
      audioFixturePath: FIXTURE_AUDIO,
      persona: 'venus',
      timeoutMs: 90000,
    });

    console.log('[full-flow] roundtrip result:', JSON.stringify({
      setupDone: result.setupDone,
      audioSendCount: result.audioSendCount,
      audioPlayCount: result.audioPlayCount,
      blobSize: result.responseBlobSize,
      error: result.error,
      timings: result.timings,
    }, null, 2));

    // Upstream classifier — soft-fail on OpenAI degradation.
    if (result.error) {
      const kind = classifyFailure({ message: result.error, audioSendCount: result.audioSendCount, audioPlayCount: result.audioPlayCount });
      const verdict = verdictFor(kind);
      if (verdict === 'soft_fail') {
        console.warn(`[full-flow] SOFT-FAIL (${kind}): ${result.error}`);
        return;
      }
    }

    expect(result.audioSendCount, 'PLUMBING: no audio sent — mic → WebRTC broken').toBeGreaterThan(0);
    expect(result.audioPlayCount, 'PLUMBING: no audio received — server → WebRTC broken').toBeGreaterThan(0);

    // Non-silent.
    expect(result.responseBlobSize, 'response audio too small').toBeGreaterThanOrEqual(5 * 1024);

    // Semantic — soft.
    const judgement = await transcribeAndJudge(
      result.responseBlob,
      'What is two plus two?',
      { mimeType: 'audio/webm', expectedAnswer: '4 or four' },
    );
    console.log('[full-flow] semantic judgement:', judgement);

    // Friction artifacts.
    const frictionDir = join(process.env.HOME, '.gbrain', 'friction');
    if (existsSync(frictionDir)) {
      const recent = readdirSync(frictionDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, mtime: statSync(join(frictionDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (recent) {
        console.log(`[full-flow] friction log: ${join(frictionDir, recent.f)}`);
      }
    }
  }, 5 * 60_000);
});

if (!SHOULD_RUN) {
  console.log('[full-flow] SKIPPED — set AGENT_VOICE_FULL_E2E=1, OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENCLAW_BIN to run');
}
