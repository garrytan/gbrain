/**
 * whisper-judge.mjs — transcribe a response Blob via Whisper, then LLM-judge.
 *
 * Used by voice-roundtrip.test.mjs and voice-full-flow.test.mjs to verify that
 * captured response audio "makes sense" — the highest-bar assertion (soft-fail
 * by default since model nondeterminism on a CI day shouldn't kill the gate).
 *
 * Two-step:
 *   1. transcribeWithWhisper(audioBytes, mimeType?) → text
 *      Uses OpenAI's whisper-1 via the standard `/audio/transcriptions` endpoint.
 *      Saves the bytes to a tmpfile (Whisper API requires multipart upload).
 *   2. judgeResponse(question, transcript, model?) → {verdict, reason}
 *      Uses chat completion to judge whether the transcript answers the question.
 *      verdict: 'pass' | 'fail' | 'inconclusive'
 *
 * Requires OPENAI_API_KEY in the env. Throws with classified errors so the
 * caller's upstream-classifier can soft-fail on 429/500/503.
 */

import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_JUDGE_MODEL = 'gpt-4o-mini';

/**
 * Transcribe response audio via Whisper.
 * @param {Buffer} audioBytes
 * @param {string} [mimeType] — default 'audio/webm'
 * @returns {Promise<string>} transcript text
 */
export async function transcribeWithWhisper(audioBytes, mimeType = 'audio/webm') {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY required for whisper transcription');
    err.code = 'missing_api_key';
    throw err;
  }
  if (!audioBytes || audioBytes.length === 0) {
    const err = new Error('audio bytes empty');
    err.code = 'empty_audio';
    throw err;
  }

  // Whisper requires a file upload via multipart/form-data.
  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('wav') ? 'wav' : 'audio';
  const tmpPath = join(tmpdir(), `agent-voice-${randomBytes(8).toString('hex')}.${ext}`);
  writeFileSync(tmpPath, audioBytes);

  try {
    const fd = new FormData();
    // Node 20+ has native Blob; for older runtimes we'd need a polyfill.
    fd.set('file', new Blob([readFileSync(tmpPath)], { type: mimeType }), `response.${ext}`);
    fd.set('model', 'whisper-1');
    fd.set('response_format', 'text');

    const res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Whisper API ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      err.code = 'whisper_http_error';
      throw err;
    }
    const transcript = (await res.text()).trim();
    return transcript;
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Judge whether the transcript answers the question.
 *
 * @param {string} question — the prompt that was asked (e.g., "what is 2+2")
 * @param {string} transcript — Whisper output
 * @param {object} [opts]
 * @param {string} [opts.model] — default 'gpt-4o-mini'
 * @param {string} [opts.expectedAnswer] — e.g., '4' or 'four'
 * @returns {Promise<{verdict:'pass'|'fail'|'inconclusive', reason:string, transcript:string}>}
 */
export async function judgeResponse(question, transcript, opts = {}) {
  const { model = DEFAULT_JUDGE_MODEL, expectedAnswer } = opts;

  if (!process.env.OPENAI_API_KEY) {
    return { verdict: 'inconclusive', reason: 'OPENAI_API_KEY not set', transcript };
  }
  if (!transcript || transcript.length === 0) {
    return { verdict: 'fail', reason: 'transcript empty', transcript };
  }

  const prompt = [
    'You are judging whether a voice assistant\'s response answers the user\'s question.',
    `Question asked: "${question}"`,
    `Voice agent response (Whisper transcript): "${transcript}"`,
    expectedAnswer ? `Expected answer contains: "${expectedAnswer}"` : 'Use your judgment for what counts as a correct answer.',
    '',
    'Respond with EXACTLY one JSON object: {"verdict":"pass"|"fail","reason":"<one short sentence>"}',
    '"pass" = the response is on-topic and addresses the question, even if not perfectly worded.',
    '"fail" = the response is off-topic, silent, or wrong.',
    'Do not include anything outside the JSON object.',
  ].join('\n');

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    return {
      verdict: 'inconclusive',
      reason: `judge model HTTP ${res.status}: ${text.slice(0, 100)}`,
      transcript,
    };
  }
  const body = await res.json();
  const raw = body.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    return { verdict: 'inconclusive', reason: `judge returned non-JSON: ${raw.slice(0, 100)}`, transcript };
  }
  const verdict = parsed.verdict === 'pass' ? 'pass' : parsed.verdict === 'fail' ? 'fail' : 'inconclusive';
  return {
    verdict,
    reason: parsed.reason || 'no reason given',
    transcript,
  };
}

/**
 * Composite: transcribe + judge. Returns the merged result.
 */
export async function transcribeAndJudge(audioBytes, question, opts = {}) {
  const t0 = Date.now();
  try {
    const transcript = await transcribeWithWhisper(audioBytes, opts.mimeType);
    const judgement = await judgeResponse(question, transcript, opts);
    return { ...judgement, transcript, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      verdict: 'inconclusive',
      reason: `whisper/judge threw: ${err.message}`,
      transcript: '',
      latencyMs: Date.now() - t0,
      error: err,
    };
  }
}
