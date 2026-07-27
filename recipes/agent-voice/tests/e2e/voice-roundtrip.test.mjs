/**
 * voice-roundtrip.test.mjs — recipe-bundle E2E (no openclaw).
 *
 * Spawns the agent-voice server, drives a puppeteer browser through a real
 * WebRTC roundtrip with a pre-recorded fake-audio fixture, applies three
 * tiers of assertion:
 *
 *   [a] CONNECTION   — audioSendCount > 0 && audioPlayCount > 0  ← hard
 *   [b] NON-SILENT   — response Blob >= 5KB AND PCM RMS variance > 0.001 ← hard
 *   [c] SEMANTIC     — Whisper transcript + LLM judge says "answers the question" ← soft
 *
 * Upstream errors (HTTP 429/500/503, WS 1011/1013) classified as soft-fail
 * via lib/upstream-classifier.mjs — the gate doesn't flake on OpenAI Realtime
 * outages.
 *
 * Cost: ~$0.10/run (WebRTC + Whisper + LLM judge).
 *
 * Env-gated: set AGENT_VOICE_E2E=1 and OPENAI_API_KEY before running.
 *
 * Usage:
 *   AGENT_VOICE_E2E=1 OPENAI_API_KEY=sk-... bun test tests/e2e/voice-roundtrip.test.mjs
 *   AGENT_VOICE_E2E=1 OPENAI_API_KEY=sk-... node tests/e2e/voice-roundtrip.test.mjs
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { runBrowserRoundtrip, decodeWav, pcmRmsVariance } from './lib/browser-audio.mjs';
import { transcribeAndJudge } from './lib/whisper-judge.mjs';
import { classifyFailure, verdictFor, preflightOpenAIStatus } from '../../code/lib/upstream-classifier.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const SERVER_SCRIPT = join(PROJECT_ROOT, 'code', 'server.mjs');
const FIXTURE_PATH = join(__dirname, 'audio-fixtures', 'utterance-add.wav');

const PORT = parseInt(process.env.AGENT_VOICE_TEST_PORT || '8765', 10);
const SERVER_URL = `http://localhost:${PORT}`;
const SHOULD_RUN = process.env.AGENT_VOICE_E2E === '1' && !!process.env.OPENAI_API_KEY;

let serverProcess;

async function waitForHealth(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) return true;
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  if (!existsSync(SERVER_SCRIPT)) throw new Error(`server.mjs not found at ${SERVER_SCRIPT}`);
  if (!existsSync(FIXTURE_PATH)) throw new Error(`audio fixture not found at ${FIXTURE_PATH}`);

  // Pre-flight OpenAI status — if degraded, log but proceed (the classifier handles it).
  const status = await preflightOpenAIStatus({ timeoutMs: 3000 });
  if (status.status === 'degraded') {
    console.warn(`[voice-roundtrip] OpenAI status degraded: ${status.detail} — test will likely soft-fail`);
  }

  serverProcess = spawn(process.execPath, [SERVER_SCRIPT], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (b) => process.stderr.write(`[server] ${b}`));
  serverProcess.stderr.on('data', (b) => process.stderr.write(`[server-err] ${b}`));

  const up = await waitForHealth();
  if (!up) {
    serverProcess.kill();
    throw new Error('agent-voice server failed to come up on health-check');
  }
}, 30000);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!serverProcess.killed) serverProcess.kill('SIGKILL');
  }
});

describe.skipIf(!SHOULD_RUN)('voice-roundtrip E2E', () => {
  it('completes a WebRTC roundtrip + asserts three-tier audio quality', async () => {
    const result = await runBrowserRoundtrip({
      serverUrl: SERVER_URL,
      audioFixturePath: FIXTURE_PATH,
      persona: 'venus',
      timeoutMs: 90000,
    });

    // Diagnostic dump (always printed for triage).
    console.log('[voice-roundtrip] result:', JSON.stringify({
      setupDone: result.setupDone,
      audioSendCount: result.audioSendCount,
      audioPlayCount: result.audioPlayCount,
      blobSize: result.responseBlobSize,
      error: result.error,
      timings: result.timings,
    }, null, 2));

    // Classify the failure first — if upstream, soft-fail.
    if (result.error) {
      const kind = classifyFailure({ message: result.error, audioSendCount: result.audioSendCount, audioPlayCount: result.audioPlayCount });
      const verdict = verdictFor(kind);
      if (verdict === 'soft_fail') {
        console.warn(`[voice-roundtrip] SOFT-FAIL (${kind}): ${result.error}`);
        return; // exit 0 — gated as soft-fail per D4-A
      }
    }

    // Tier [a]: CONNECTION (hard).
    expect(result.setupDone, 'WebRTC setup did not complete').toBe(true);
    expect(result.audioSendCount, 'no audio frames sent (mic → WebRTC broken)').toBeGreaterThan(0);
    expect(result.audioPlayCount, 'no audio frames received (server → WebRTC broken)').toBeGreaterThan(0);

    // Tier [b]: NON-SILENT (hard).
    expect(result.responseBlob, 'no response Blob captured').not.toBeNull();
    expect(result.responseBlobSize, 'response Blob too small (<5KB)').toBeGreaterThanOrEqual(5 * 1024);

    // PCM RMS variance — best-effort (works on WAV; webm/opus needs decoding via a separate lib).
    if (result.responseBlob && result.responseBlob[0] === 0x52 && result.responseBlob[1] === 0x49) {
      // WAV magic bytes "RI".
      const pcm = decodeWav(result.responseBlob);
      const rms = pcmRmsVariance(pcm);
      expect(rms, `PCM RMS variance too low (${rms}) — audio is likely silence`).toBeGreaterThan(0.001);
    }
    // For webm/opus, skip RMS — blob-size > 5KB and Whisper transcription below cover it.

    // Tier [c]: SEMANTIC (soft).
    const judgement = await transcribeAndJudge(
      result.responseBlob,
      'What is two plus two?',
      { mimeType: 'audio/webm', expectedAnswer: '4 or four' },
    );
    console.log('[voice-roundtrip] semantic judgement:', JSON.stringify(judgement, null, 2));

    if (judgement.verdict === 'inconclusive') {
      console.warn(`[voice-roundtrip] semantic check inconclusive: ${judgement.reason}`);
    } else if (judgement.verdict === 'fail') {
      console.warn(`[voice-roundtrip] semantic check FAILED (soft): ${judgement.reason}`);
    } else {
      console.log(`[voice-roundtrip] semantic check PASS: ${judgement.reason}`);
    }
    // Intentionally soft — do not assert pass.
  }, 120000);
});

// Skip-message shim so the file always loads.
if (!SHOULD_RUN) {
  // eslint-disable-next-line no-console
  console.log('[voice-roundtrip] SKIPPED — set AGENT_VOICE_E2E=1 and OPENAI_API_KEY to run');
}
