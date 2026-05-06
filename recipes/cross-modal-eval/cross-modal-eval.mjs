#!/usr/bin/env node
// Cross-Modal Eval — multi-model quality gate
// Usage: node lib/cross-modal-eval.mjs --task "..." --output path/to/file.md [--dimensions "d1,d2,d3"]

import { readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';

// --- Config ---
const DEFAULT_DIMENSIONS = [
  'GOAL_ACHIEVEMENT — Does the output actually accomplish what the task asked for?',
  'DEPTH — Is the output substantive, or surface-level / thin?',
  'SOURCING — Are claims backed by evidence, links, or citations?',
  'SPECIFICITY — Are there concrete details, data, quotes, examples?',
  'USEFULNESS — Would the intended audience find this valuable?'
];

// --- Load env ---
function loadEnv() {
  const env = {};
  try {
    readFileSync('/data/.env', 'utf-8').split('\n').forEach(line => {
      const [k, ...v] = line.split('=');
      if (k && v.length) env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
    });
  } catch {}
  return env;
}

// --- Build prompt ---
function buildPrompt(task, dimensions, output) {
  const dimList = dimensions.map((d, i) => `${i + 1}. ${d}`).join('\n');
  return `You are a strict quality evaluator. Given a TASK and an OUTPUT, evaluate whether the output achieves the task goals.

TASK:
${task}

Score the OUTPUT 1-10 on each dimension:
${dimList}

Then list exactly 10 specific, actionable improvements — concrete changes with examples, prioritized by impact.

Respond in JSON only (no markdown fences):
{
  "scores": {
    "dim_1_name": { "score": N, "feedback": "..." },
    ...
  },
  "overall": N,
  "improvements": ["1. ...", "2. ...", ... "10. ..."]
}

OUTPUT:
${output}`;
}

// --- Call OpenAI ---
async function callOpenAI(prompt, env) {
  const key = env.EVAL_MODEL_A_KEY || env.OPENAI_API_KEY;
  const model = env.EVAL_MODEL_A || 'gpt-5.5';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 4000
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices[0].message.content;
}

// --- Call Anthropic ---
async function callAnthropic(prompt, env) {
  const key = env.EVAL_MODEL_B_KEY || env.ANTHROPIC_API_KEY;
  const model = env.EVAL_MODEL_B || 'claude-opus-4-7';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).content[0].text;
}

// --- Call Together AI ---
async function callTogether(prompt, env) {
  const key = env.EVAL_MODEL_C_KEY || env.TOGETHER_API_KEY;
  const model = env.EVAL_MODEL_C || 'deepseek-ai/DeepSeek-V4-Pro';
  const res = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000
    })
  });
  if (!res.ok) throw new Error(`Together ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices[0].message.content;
}

// --- Parse JSON from model response ---
function parseModelJSON(raw) {
  // Strip markdown fences if present
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  
  // Try direct parse first
  try { return JSON.parse(cleaned); } catch {}
  
  // Try to extract JSON object
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
    
    // Fix common JSON issues from LLMs:
    let fixed = match[0]
      // Fix trailing commas before } or ]
      .replace(/,\s*([}\]])/g, '$1')
      // Fix unescaped newlines inside strings
      .replace(/(["'])([^"']*?)\n([^"']*?)\1/g, (m, q, a, b) => `${q}${a}\\n${b}${q}`)
      // Fix single quotes used as string delimiters
      .replace(/(?<=[:{,\[]\s*)'([^']*?)'(?=\s*[,}\]:])/g, '"$1"');
    
    try { return JSON.parse(fixed); } catch {}
    
    // Nuclear option: extract scores and improvements separately with regex
    const scores = {};
    const scorePattern = /["']?(\w+)["']?\s*:\s*\{[^}]*?["']?score["']?\s*:\s*(\d+)/g;
    let sm;
    while ((sm = scorePattern.exec(match[0])) !== null) {
      scores[sm[1]] = { score: parseInt(sm[2]), feedback: '' };
    }
    
    const improvements = [];
    const impPattern = /"(\d+\.\s[^"]{10,})"/g;
    let im;
    while ((im = impPattern.exec(match[0])) !== null) {
      improvements.push(im[1]);
    }
    
    if (Object.keys(scores).length > 0) {
      const overallMatch = match[0].match(/["']?overall["']?\s*:\s*(\d+)/);
      return {
        scores,
        overall: overallMatch ? parseInt(overallMatch[1]) : 0,
        improvements: improvements.length > 0 ? improvements : ['(could not parse improvements from malformed JSON)'],
        _repaired: true
      };
    }
  }
  
  throw new Error('Could not parse JSON from model response');
}

// --- Aggregate ---
function aggregate(results) {
  const dimScores = {};
  const allImprovements = [];
  
  for (const [modelName, raw] of Object.entries(results)) {
    if (typeof raw === 'string' && raw.startsWith('ERROR:')) continue;
    try {
      const parsed = parseModelJSON(raw);
      for (const [dim, val] of Object.entries(parsed.scores || {})) {
        if (!dimScores[dim]) dimScores[dim] = [];
        dimScores[dim].push(val.score || val);
      }
      if (parsed.improvements) allImprovements.push(...parsed.improvements);
    } catch (e) {
      console.error(`  Failed to parse ${modelName}: ${e.message}`);
    }
  }
  
  const dimAverages = {};
  let totalAvg = 0;
  let dimCount = 0;
  for (const [dim, scores] of Object.entries(dimScores)) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    dimAverages[dim] = Math.round(avg * 10) / 10;
    totalAvg += avg;
    dimCount++;
  }
  
  const overallAvg = dimCount ? Math.round((totalAvg / dimCount) * 10) / 10 : 0;
  const pass = Object.values(dimAverages).every(avg => avg >= 7);
  
  // Deduplicate improvements by similarity (simple: first 40 chars)
  const seen = new Set();
  const uniqueImprovements = allImprovements.filter(imp => {
    const key = imp.slice(0, 40).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
  
  return { dimAverages, overallAvg, pass, topImprovements: uniqueImprovements };
}

// --- Main ---
const args = process.argv.slice(2);
const taskIdx = args.indexOf('--task');
const outputIdx = args.indexOf('--output');
const dimIdx = args.indexOf('--dimensions');

if (taskIdx === -1 || outputIdx === -1) {
  console.error('Usage: node lib/cross-modal-eval.mjs --task "..." --output path/to/file.md [--dimensions "d1,d2,..."]');
  process.exit(1);
}

const task = args[taskIdx + 1];
const outputPath = args[outputIdx + 1];
const customDims = dimIdx !== -1 ? args[dimIdx + 1].split(',').map(d => d.trim()) : null;
const dimensions = customDims || DEFAULT_DIMENSIONS;
const output = readFileSync(outputPath, 'utf-8');
const name = basename(outputPath, '.md');
const env = loadEnv();
const prompt = buildPrompt(task, dimensions, output);

console.log(`\n=== Cross-Modal Eval: ${name} ===`);
console.log(`Task: ${task.slice(0, 80)}...`);
console.log(`Output: ${outputPath} (${output.length} chars)`);
console.log(`Dimensions: ${dimensions.length}`);

const results = {};

// Model A: OpenAI
try {
  process.stdout.write('  [A] OpenAI... ');
  results.openai = await callOpenAI(prompt, env);
  console.log('done');
} catch (e) { console.log(`error: ${e.message}`); results.openai = `ERROR: ${e.message}`; }

// Model B: Anthropic
try {
  process.stdout.write('  [B] Anthropic... ');
  results.anthropic = await callAnthropic(prompt, env);
  console.log('done');
} catch (e) { console.log(`error: ${e.message}`); results.anthropic = `ERROR: ${e.message}`; }

// Model C: Together
try {
  process.stdout.write('  [C] Together... ');
  results.together = await callTogether(prompt, env);
  console.log('done');
} catch (e) { console.log(`error: ${e.message}`); results.together = `ERROR: ${e.message}`; }

// Aggregate
const agg = aggregate(results);
console.log(`\n  Dimension Averages:`);
for (const [dim, avg] of Object.entries(agg.dimAverages)) {
  console.log(`    ${dim}: ${avg} ${avg >= 7 ? '✓' : '✗'}`);
}
console.log(`  Overall: ${agg.overallAvg} — ${agg.pass ? 'PASS' : 'FAIL'}`);
console.log(`\n  Top Improvements:`);
agg.topImprovements.forEach((imp, i) => console.log(`    ${i + 1}. ${imp.slice(0, 120)}`));

// Write receipt
const receipt = {
  task,
  outputPath,
  timestamp: new Date().toISOString(),
  models: results,
  aggregated: agg
};
const receiptPath = `/tmp/cross-modal-eval-${name}-${Date.now()}.json`;
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
console.log(`\n  Receipt: ${receiptPath}`);

// Exit code reflects pass/fail
process.exit(agg.pass ? 0 : 1);
