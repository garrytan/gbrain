#!/usr/bin/env node
/**
 * persona-routing-eval.mjs — which persona handles a given utterance?
 *
 * Each fixture has an `expected_persona`. The harness generates BOTH Mars's
 * and Venus's responses to the same utterance, then asks the judge which
 * persona handled it better. Pass criterion: judges agree on expected_persona
 * for at least 7/10 fixtures.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARS } from '../../code/lib/personas/mars.mjs';
import { VENUS } from '../../code/lib/personas/venus.mjs';
import { loadFixturesJsonl, parseEvalCliArgs, generatePersonaResponse } from './judge.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = parseEvalCliArgs(process.argv.slice(2));
const outDir = resolve(__dirname, args.baseline ? 'baseline-runs' : 'baseline-runs/dev');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const fixtures = loadFixturesJsonl(resolve(__dirname, 'fixtures/persona-routing.jsonl'));
console.error(`[persona-routing-eval] running ${fixtures.length} fixtures (limit=${args.limit || 'none'})`);

const slice = args.limit ? fixtures.slice(0, args.limit) : fixtures;
const results = [];

for (let i = 0; i < slice.length; i++) {
  const fixture = slice[i];
  process.stderr.write(`[persona-routing-eval] ${i + 1}/${slice.length}: ${fixture.user_utterance.slice(0, 60)}\n`);

  let marsResponse = '';
  let venusResponse = '';
  let marsErr = null;
  let venusErr = null;
  try {
    marsResponse = await generatePersonaResponse({
      personaPrompt: MARS.prompt,
      userUtterance: fixture.user_utterance,
      model: args.model || 'claude-sonnet-4-6',
    });
  } catch (err) { marsErr = err.message; }
  try {
    venusResponse = await generatePersonaResponse({
      personaPrompt: VENUS.prompt,
      userUtterance: fixture.user_utterance,
      model: args.model || 'claude-sonnet-4-6',
    });
  } catch (err) { venusErr = err.message; }

  // Single Claude judge — picks which persona handled the utterance better.
  const judgePrompt = `Two voice personas were asked the same question.

USER: "${fixture.user_utterance}"
${fixture.context ? `CONTEXT: ${fixture.context}\n` : ''}
MARS responded: "${marsResponse || '[error]'}"
VENUS responded: "${venusResponse || '[error]'}"

Which persona handled this better? Respond with EXACTLY one JSON object:
{"chose": "mars" | "venus", "reason": "<one sentence>"}`;

  let chose = null;
  let reason = '';
  if (process.env.ANTHROPIC_API_KEY && (marsResponse || venusResponse)) {
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 256,
          messages: [{ role: 'user', content: judgePrompt }],
        }),
      });
      if (res.ok) {
        const body = await res.json();
        const raw = body.content?.[0]?.text || '';
        const match = raw.match(/\{[\s\S]*?\}/);
        if (match) {
          try {
            const parsed = JSON.parse(match[0]);
            chose = parsed.chose;
            reason = parsed.reason || '';
          } catch { /* leave nulls */ }
        }
      }
    } catch (err) {
      reason = `judge threw: ${err.message}`;
    }
  } else {
    reason = 'no ANTHROPIC_API_KEY OR both persona responses errored';
  }

  results.push({
    fixture_id: fixture.id,
    user_utterance: fixture.user_utterance,
    expected_persona: fixture.expected_persona,
    chose,
    reason,
    correct: chose === fixture.expected_persona,
    mars_response: marsResponse,
    mars_error: marsErr,
    venus_response: venusResponse,
    venus_error: venusErr,
  });
}

const correct = results.filter((r) => r.correct).length;
const total = results.length;
const ratio = total === 0 ? 0 : correct / total;
const summary = {
  schema_version: 1,
  label: 'persona-routing',
  total,
  correct,
  ratio,
  overall_verdict: ratio >= 0.7 ? 'pass' : ratio === 0 ? 'inconclusive' : 'fail',
  ts: new Date().toISOString(),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'persona-routing-summary.json'), JSON.stringify({ summary, results }, null, 2) + '\n');

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.overall_verdict === 'pass' ? 0 : 1);
