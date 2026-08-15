/**
 * judge.mjs — gateway-routed three-model judge harness.
 *
 * For each fixture row (a question + expected behavior axes), this harness:
 *   1. Generates the persona's response (via the persona prompt + a chat model)
 *   2. Sends the response to THREE judge models (Claude + GPT + Gemini)
 *   3. Each judge scores 1-10 per axis with a one-line reason
 *   4. Aggregates: pass criterion = every axis mean >= 7 AND no model scored any axis < 5
 *      AND >= 2/3 models returned parseable JSON
 *
 * Modeled on `evals/functional-area-resolver/harness.mjs` in the gbrain repo
 * (same gateway-routed pattern, same 2/3-quorum logic). Reused verbatim
 * conceptually; reimplemented to drop the gbrain SDK dependency so this file
 * runs in a host repo without gbrain installed.
 *
 * Provider routing:
 *   - Claude: ANTHROPIC_API_KEY
 *   - GPT:    OPENAI_API_KEY
 *   - Gemini: GOOGLE_API_KEY (Generative Language API)
 *
 * If a key is missing for any provider, that judge is skipped — quorum may
 * drop to 2/2 or 1/1. Below 1 successful judge, the run reports inconclusive.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const GEMINI_URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_PERSONA_MODEL = 'claude-sonnet-4-6';
const DEFAULT_JUDGES = {
  claude: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-1.5-pro-latest',
};

// ── Persona response generation ──────────────────────────────────────

/**
 * Generate the persona's response to a fixture turn-history + user-utterance.
 * Uses Claude by default (since Mars/Venus are designed against Anthropic's
 * voice models conceptually, even though the live runtime uses OpenAI Realtime).
 */
export async function generatePersonaResponse({ personaPrompt, turnHistory, userUtterance, model = DEFAULT_PERSONA_MODEL }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY required for persona response generation'), { code: 'missing_api_key' });
  }
  const messages = [];
  for (const turn of turnHistory || []) {
    messages.push({ role: turn.role || 'user', content: turn.content });
  }
  messages.push({ role: 'user', content: userUtterance });

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      system: personaPrompt,
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Claude API ${res.status}: ${text.slice(0, 200)}`), {
      status: res.status,
      code: 'persona_http_error',
    });
  }
  const body = await res.json();
  return body.content?.[0]?.text || '';
}

// ── Three judge calls ────────────────────────────────────────────────

const JUDGE_PROMPT_TEMPLATE = (fixture, response) => `You are judging whether a voice agent's response to a user utterance meets behavioral expectations.

FIXTURE:
  user_utterance: "${fixture.user_utterance}"
  expected_behaviors: ${JSON.stringify(fixture.axes)}
  ${fixture.context ? `context: "${fixture.context}"` : ''}

VOICE AGENT RESPONSE:
"${response}"

Score each axis from 1-10 (10 = fully meets expectation, 5 = partial, 1 = fails completely).
Respond with EXACTLY one JSON object, no other text:

{"scores": {"axis_name_1": N, "axis_name_2": N, ...}, "reason": "<one short sentence overall>"}

Use the axis names from expected_behaviors exactly. Score each one. Do not include any other fields.`;

async function judgeViaClaude(fixture, response, model) {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, reason: 'no anthropic key' };
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{ role: 'user', content: JUDGE_PROMPT_TEMPLATE(fixture, response) }],
      }),
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const body = await res.json();
    return { ok: true, raw: body.content?.[0]?.text || '' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function judgeViaOpenai(fixture, response, model) {
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'no openai key' };
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: JUDGE_PROMPT_TEMPLATE(fixture, response) }],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const body = await res.json();
    return { ok: true, raw: body.choices?.[0]?.message?.content || '' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function judgeViaGemini(fixture, response, model) {
  if (!process.env.GOOGLE_API_KEY) return { ok: false, reason: 'no google key' };
  try {
    const url = `${GEMINI_URL_BASE}/${encodeURIComponent(model)}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: JUDGE_PROMPT_TEMPLATE(fixture, response) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const body = await res.json();
    return { ok: true, raw: body.candidates?.[0]?.content?.parts?.[0]?.text || '' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── JSON repair (modeled on src/core/cross-modal-eval/json-repair.ts) ─

function parseJudgeJson(raw) {
  if (!raw) return null;
  // 4-strategy fallback chain.
  // 1. Direct.
  try { return JSON.parse(raw); } catch { /* fall through */ }
  // 2. Strip code fences.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch { /* fall through */ }
  }
  // 3. Trailing-comma + single-quote repair.
  const repaired = raw
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/'/g, '"');
  try { return JSON.parse(repaired); } catch { /* fall through */ }
  // 4. Regex extraction of {"scores": {...}, "reason": "..."} substring.
  const scoresMatch = raw.match(/\{[\s\S]*"scores"[\s\S]*\}/);
  if (scoresMatch) {
    try { return JSON.parse(scoresMatch[0]); } catch { /* give up */ }
  }
  return null;
}

// ── Aggregation per the v0.27.x pattern ──────────────────────────────

export function aggregateVerdicts(judgeResults) {
  const parsed = judgeResults
    .filter((r) => r.ok)
    .map((r) => ({ ...r, parsed: parseJudgeJson(r.raw) }))
    .filter((r) => r.parsed && r.parsed.scores);

  const successes = parsed.length;
  const totalAttempts = judgeResults.length;

  if (successes < Math.ceil(totalAttempts * 2 / 3)) {
    return { verdict: 'inconclusive', reason: `${successes}/${totalAttempts} judges returned parseable JSON`, scores: null };
  }

  // Collect every axis seen across all judges.
  const axes = new Set();
  for (const r of parsed) {
    for (const k of Object.keys(r.parsed.scores)) axes.add(k);
  }

  const perAxis = {};
  let pass = true;
  const failingAxes = [];
  for (const axis of axes) {
    const values = parsed
      .map((r) => r.parsed.scores[axis])
      .filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (values.length === 0) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values);
    perAxis[axis] = { mean, min, n: values.length };
    if (mean < 7 || min < 5) {
      pass = false;
      failingAxes.push(axis);
    }
  }

  return {
    verdict: pass ? 'pass' : 'fail',
    reason: pass ? 'all axes >= 7 mean, no model <5' : `failing axes: ${failingAxes.join(', ')}`,
    scores: perAxis,
    judges_succeeded: successes,
    judges_attempted: totalAttempts,
  };
}

// ── Top-level runner ─────────────────────────────────────────────────

/**
 * Run a fixture through persona generation + 3-model judging.
 * Returns the full receipt envelope.
 */
export async function runFixture({ fixture, personaPrompt, personaModel, judges }) {
  const t0 = Date.now();
  const judgeModels = { ...DEFAULT_JUDGES, ...(judges || {}) };

  // 1. Generate the persona response.
  let personaResponse;
  let personaError = null;
  try {
    personaResponse = await generatePersonaResponse({
      personaPrompt,
      turnHistory: fixture.turn_history,
      userUtterance: fixture.user_utterance,
      model: personaModel || DEFAULT_PERSONA_MODEL,
    });
  } catch (err) {
    personaError = err.message;
    personaResponse = '';
  }

  // 2. Run all 3 judges in parallel.
  const judgeResults = await Promise.all([
    judgeViaClaude(fixture, personaResponse, judgeModels.claude).then((r) => ({ ...r, judge: 'claude', model: judgeModels.claude })),
    judgeViaOpenai(fixture, personaResponse, judgeModels.openai).then((r) => ({ ...r, judge: 'openai', model: judgeModels.openai })),
    judgeViaGemini(fixture, personaResponse, judgeModels.gemini).then((r) => ({ ...r, judge: 'gemini', model: judgeModels.gemini })),
  ]);

  // 3. Aggregate.
  const aggregate = aggregateVerdicts(judgeResults);

  return {
    schema_version: 1,
    fixture_id: fixture.id || null,
    fixture: { ...fixture },
    persona_model: personaModel || DEFAULT_PERSONA_MODEL,
    persona_response: personaResponse,
    persona_error: personaError,
    judge_models: judgeModels,
    judge_raw: judgeResults.map((r) => ({ judge: r.judge, model: r.model, ok: r.ok, raw: r.raw || null, reason: r.reason || null })),
    aggregate,
    latency_ms: Date.now() - t0,
    ts: new Date().toISOString(),
  };
}

/**
 * Run a list of fixtures and write receipts to disk.
 */
export async function runFixtureSet({ fixtures, personaPrompt, personaModel, judges, outDir, limit, label }) {
  const slice = limit ? fixtures.slice(0, limit) : fixtures;
  const results = [];
  for (let i = 0; i < slice.length; i++) {
    const fixture = slice[i];
    process.stderr.write(`[eval:${label}] fixture ${i + 1}/${slice.length}: ${fixture.user_utterance.slice(0, 60)}...\n`);
    const receipt = await runFixture({ fixture, personaPrompt, personaModel, judges });
    results.push(receipt);
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      const outPath = resolve(outDir, `${label}-${(fixture.id || i).toString().padStart(3, '0')}.json`);
      writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n');
    }
  }
  // Summary
  const passes = results.filter((r) => r.aggregate.verdict === 'pass').length;
  const fails = results.filter((r) => r.aggregate.verdict === 'fail').length;
  const inc = results.filter((r) => r.aggregate.verdict === 'inconclusive').length;
  const summary = {
    schema_version: 1,
    label,
    total: results.length,
    pass: passes,
    fail: fails,
    inconclusive: inc,
    overall_verdict: fails > 0 ? 'fail' : inc > results.length / 2 ? 'inconclusive' : 'pass',
    ts: new Date().toISOString(),
  };
  if (outDir) {
    writeFileSync(resolve(outDir, `${label}-summary.json`), JSON.stringify(summary, null, 2) + '\n');
  }
  return { results, summary };
}

// ── JSONL fixture loader ─────────────────────────────────────────────

export function loadFixturesJsonl(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, idx) => {
    try { return JSON.parse(line); }
    catch (err) {
      throw new Error(`fixture file ${path}: line ${idx + 1} not valid JSON: ${err.message}`);
    }
  });
}

// ── CLI arg parsing helper ───────────────────────────────────────────

export function parseEvalCliArgs(argv) {
  const out = { limit: null, model: null, baseline: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (argv[i] === '--model') out.model = argv[++i];
    else if (argv[i] === '--baseline') out.baseline = true;
  }
  return out;
}
