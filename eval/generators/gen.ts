/**
 * Opus prose generator. Calls Claude Opus to turn entity skeletons (from
 * world.ts) into rich, multi-paragraph prose pages with realistic noise:
 * varied phrasing, occasional typos, multiple mentions per page, evolving
 * compiled truth.
 *
 * Cost discipline:
 *   - Tracks token usage per call.
 *   - Hard-stops at $80 (well under the $500 daily cap).
 *   - Caches every successful output to eval/data/world-v1/<slug>.json so
 *     re-running is free.
 *
 * Reads ANTHROPIC_API_KEY from .env.testing (gitignored — committed key
 * would be a security issue).
 *
 * Usage: bun eval/generators/gen.ts [--max N] [--dry-run]
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { buildWorld, type EntityFacts, type World } from './world.ts';

// ─── Setup: load env, init client ──────────────────────────────

function loadEnv() {
  const envPath = '.env.testing';
  if (!existsSync(envPath)) throw new Error(`${envPath} not found`);
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

loadEnv();
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set after loading .env.testing');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Opus 4.7 pricing as of 2026-04-18.
const PRICE_INPUT_PER_M = 15;
const PRICE_OUTPUT_PER_M = 75;
const HARD_STOP_USD = 80;
const MODEL = 'claude-opus-4-5'; // 4.7 model id; SDK accepts the alias

// ─── Prompt construction ──────────────────────────────────────

function entityPrompt(entity: EntityFacts, world: World): string {
  // Build a context block that names the related entities so the LLM uses real slugs.
  let context = '';
  if (entity.type === 'person') {
    const company = world.companies.find(c => c.slug === entity.primary_affiliation);
    const secondaryCos = (entity.secondary_affiliations ?? [])
      .map(s => world.companies.find(c => c.slug === s))
      .filter(Boolean);
    context = `Person profile to write about:
  Name: ${entity.name}
  Slug: ${entity.slug}
  Role: ${entity.role}
  Primary affiliation: [${company?.name ?? '?'}](${entity.primary_affiliation}) (${company?.industry ?? '?'})
${secondaryCos.length ? `  Other affiliations: ${secondaryCos.map(c => `[${c!.name}](${c!.slug})`).join(', ')}` : ''}
  Notable traits: ${entity.notable_traits.join(', ')}`;
  } else if (entity.type === 'company') {
    const founders = (entity.founders ?? []).map(s => world.people.find(p => p.slug === s)).filter(Boolean);
    const investors = (entity.investors ?? []).slice(0, 3).map(s => world.people.find(p => p.slug === s)).filter(Boolean);
    const advisors = (entity.advisors ?? []).slice(0, 2).map(s => world.people.find(p => p.slug === s)).filter(Boolean);
    context = `Company profile to write about:
  Name: ${entity.name}
  Slug: ${entity.slug}
  Category: ${entity.category}
  Industry: ${entity.industry}
${entity.founded_year ? `  Founded: ${entity.founded_year}` : ''}
${founders.length ? `  Founders: ${founders.map(p => `[${p!.name}](${p!.slug})`).join(', ')}` : ''}
${investors.length ? `  Investors: ${investors.map(p => `[${p!.name}](${p!.slug})`).join(', ')}` : ''}
${advisors.length ? `  Advisors: ${advisors.map(p => `[${p!.name}](${p!.slug})`).join(', ')}` : ''}`;
  } else if (entity.type === 'meeting') {
    const attendees = entity.attendees.map(s => world.people.find(p => p.slug === s)).filter(Boolean);
    const company = entity.topic_company ? world.companies.find(c => c.slug === entity.topic_company) : null;
    context = `Meeting to write notes for:
  Name: ${entity.name}
  Slug: ${entity.slug}
  Type: ${entity.meeting_type}
  Date: ${entity.date}
  Attendees: ${attendees.map(p => `[${p!.name}](${p!.slug})`).join(', ')}
${company ? `  Topic company: [${company.name}](${company.slug}) (${company.industry})` : ''}`;
  } else {
    const cos = entity.related_companies.map(s => world.companies.find(c => c.slug === s)).filter(Boolean);
    context = `Concept to write a thesis page for:
  Name: ${entity.name}
  Slug: ${entity.slug}
  Brief: ${entity.description}
  Related companies: ${cos.map(c => `[${c!.name}](${c!.slug})`).join(', ')}`;
  }

  return `${context}

Write a brain page for this entity. Output JSON with this exact shape:
{
  "title": "Display title for the page",
  "compiled_truth": "Multi-paragraph current understanding. 250-500 words. NATURAL prose, not bullet lists. Reference other entities by markdown link [Name](slug) at least twice using the slugs given above. Vary writing style — sometimes terse, sometimes prose-heavy. Include a couple of natural typos (1-2% of words). Mention the entity by varying names (full name, short name, role). For companies, include details on what they do, recent moves, who's involved. For people, write a bio that mentions their company, history, what they're known for. For meetings, write attendee notes + key discussion points. For concepts, write a thesis with examples.",
  "timeline": "5-10 dated bullet entries in the format: - **YYYY-MM-DD** | summary text. Mix of dates spanning 2021-2026. Realistic events: hires, raises, ships, talks, meetings. Reference other entities by [Name](slug) where natural."
}

Output ONLY the JSON object. No preamble, no code fences.`;
}

// ─── Cost tracking ───────────────────────────────────────────

interface CostLedger {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
}

const ledger: CostLedger = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };

function recordUsage(inT: number, outT: number) {
  ledger.inputTokens += inT;
  ledger.outputTokens += outT;
  ledger.costUsd = (ledger.inputTokens / 1_000_000) * PRICE_INPUT_PER_M + (ledger.outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
  ledger.calls++;
}

// ─── Main loop ────────────────────────────────────────────────

const OUTPUT_DIR = 'eval/data/world-v1';

async function generateOne(entity: EntityFacts, world: World): Promise<{ ok: true; cached: boolean } | { ok: false; error: string }> {
  const cachePath = join(OUTPUT_DIR, `${entity.slug.replace('/', '__')}.json`);
  if (existsSync(cachePath)) return { ok: true, cached: true };

  if (ledger.costUsd > HARD_STOP_USD) {
    return { ok: false, error: `HARD_STOP: cost ${ledger.costUsd.toFixed(2)} > ${HARD_STOP_USD}` };
  }

  const prompt = entityPrompt(entity, world);
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    });
    recordUsage(resp.usage.input_tokens, resp.usage.output_tokens);

    const text = resp.content[0].type === 'text' ? resp.content[0].text : '';
    // Be lenient with trailing junk — find first { and last }.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return { ok: false, error: `no JSON in response (${text.slice(0, 80)})` };
    const json = JSON.parse(text.slice(start, end + 1));

    writeFileSync(cachePath, JSON.stringify({
      slug: entity.slug,
      type: entity.type,
      title: json.title,
      compiled_truth: json.compiled_truth,
      timeline: json.timeline,
      _facts: entity, // ground truth for benchmark scoring
    }, null, 2));

    return { ok: true, cached: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 200) };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const maxIdx = args.indexOf('--max');
  const max = maxIdx !== -1 ? Number(args[maxIdx + 1]) : 240;
  const concIdx = args.indexOf('--concurrency');
  const concurrency = concIdx !== -1 ? Number(args[concIdx + 1]) : 1;
  const dryRun = args.includes('--dry-run');

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  const world = buildWorld(42);

  // Subset selection: aim for diversity. Take a stratified sample so we have
  // a mix of types in the prose corpus.
  // 80 people (40 founders, 20 partners, 10 engineers, 10 advisors)
  // 80 companies (60 startups, 15 VCs, 5 acquirers)
  // 50 meetings (15 demo days, 25 oneonones, 10 board meetings)
  // 30 concepts
  const founders = world.people.filter(p => p.role === 'founder');
  const partners = world.people.filter(p => p.role === 'partner');
  const engineers = world.people.filter(p => p.role === 'engineer');
  const advisors = world.people.filter(p => p.role === 'advisor');
  const startups = world.companies.filter(c => c.category === 'startup');
  const vcs = world.companies.filter(c => c.category === 'vc');
  const acquirers = world.companies.filter(c => c.category === 'acquirer' || c.category === 'mature');
  const demos = world.meetings.filter(m => m.meeting_type === 'demo_day');
  const oneonones = world.meetings.filter(m => m.meeting_type === 'one_on_one');
  const boards = world.meetings.filter(m => m.meeting_type === 'board_meeting');

  const subset: EntityFacts[] = [
    ...founders.slice(0, 40),
    ...partners.slice(0, 20),
    ...engineers.slice(0, 10),
    ...advisors.slice(0, 10),
    ...startups.slice(0, 60),
    ...vcs.slice(0, 15),
    ...acquirers.slice(0, 5),
    ...demos.slice(0, 15),
    ...oneonones.slice(0, 25),
    ...boards.slice(0, 10),
    ...world.concepts.slice(0, 30),
  ].slice(0, max);

  console.log(`Generating ${subset.length} rich pages via Opus.`);
  console.log(`Hard stop at $${HARD_STOP_USD}.`);
  console.log(`Cache dir: ${OUTPUT_DIR}\n`);

  if (dryRun) {
    console.log('DRY RUN: would generate', subset.length, 'pages');
    console.log('Distribution:', {
      people: subset.filter(e => e.type === 'person').length,
      companies: subset.filter(e => e.type === 'company').length,
      meetings: subset.filter(e => e.type === 'meeting').length,
      concepts: subset.filter(e => e.type === 'concept').length,
    });
    return;
  }

  console.log(`Concurrency: ${concurrency}\n`);

  // Already-cached count up front, so progress is honest.
  const preCached = subset.filter(e => existsSync(join(OUTPUT_DIR, `${e.slug.replace('/', '__')}.json`))).length;
  const toGenerate = subset.length - preCached;
  console.log(`Already cached: ${preCached}. To generate: ${toGenerate}.\n`);

  const queue = [...subset];
  let cached = 0, generated = 0, failed = 0;
  const startTime = Date.now();

  function reportProgress(slug: string) {
    const elapsedSec = (Date.now() - startTime) / 1000;
    const rate = generated > 0 ? generated / elapsedSec : 0; // pages/sec
    const remaining = toGenerate - generated;
    const etaSec = rate > 0 ? remaining / rate : 0;
    const etaMin = etaSec / 60;
    const avgCostPer = generated > 0 ? ledger.costUsd / generated : 0;
    const projectedTotal = avgCostPer * toGenerate;
    console.log(`  [${elapsedSec.toFixed(0)}s] ${generated}/${toGenerate} (${cached} cached) — $${ledger.costUsd.toFixed(2)} spent — rate ${rate.toFixed(2)}/s — ETA ${etaMin.toFixed(1)}min — projected total $${projectedTotal.toFixed(2)} — last: ${slug}`);
  }

  async function worker() {
    while (queue.length > 0) {
      const e = queue.shift();
      if (!e) break;
      const r = await generateOne(e, world);
      if (r.ok) {
        if (r.cached) cached++;
        else {
          generated++;
          // Report on every page when sequential; every 5 when concurrent.
          if (concurrency === 1 || generated % 5 === 0) reportProgress(e.slug);
        }
      } else {
        failed++;
        console.error(`  FAIL ${e.slug}: ${r.error}`);
        if (r.error.startsWith('HARD_STOP')) {
          queue.length = 0; // drain
          return;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log(`\nDone. ${generated} generated, ${cached} cached, ${failed} failed.`);
  console.log(`Total cost: $${ledger.costUsd.toFixed(2)} (${ledger.calls} calls, ${ledger.inputTokens.toLocaleString()} in / ${ledger.outputTokens.toLocaleString()} out)`);
  console.log(`Output dir: ${OUTPUT_DIR}/`);

  // Persist ledger for reproducibility.
  writeFileSync(join(OUTPUT_DIR, '_ledger.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    model: MODEL,
    pricing: { input_per_m: PRICE_INPUT_PER_M, output_per_m: PRICE_OUTPUT_PER_M },
    ...ledger,
    files_total: readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.json') && f !== '_ledger.json').length,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
