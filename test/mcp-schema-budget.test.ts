/**
 * C3 (cost wave): the starter-surface tool list is re-sent to the model on
 * every turn, so its size is a cost every connected agent pays. This file
 * pins:
 *   - the served starter list (Cat 40 configuration: `gbrain serve --surface
 *     starter`, no skill grants) at 25,000 characters or less, with
 *     `mcp.publish_skills` on (fresh-init default) and off, and its cl100k
 *     token count, both measured on what a model receives (name,
 *     description, inputSchema: the Cat 40 harness and the Anthropic/OpenAI
 *     tool APIs drop MCP `annotations`), plus a separate ceiling on the whole
 *     tools/list JSON including the annotations;
 *   - the initialize instructions at their recorded size, so guidance cut
 *     from the schemas cannot move there instead;
 *   - a per-tool budget (the whole tool definition) for every starter op,
 *     under the hard caps of 1,200 characters per description and 200 per
 *     parameter description;
 *   - the minimum guidance each tool must keep (DX-14): purpose, required
 *     input, consequential defaults, the next call, the recovery move.
 * The longer pre-cut guidance lives in docs/mcp/TOOL_REFERENCE.md.
 *
 * Raising a number here needs a reason in the commit message and a check
 * that the served list still fits 25,000 characters. Measured on the cost
 * wave: 24,763 characters, 5,568 cl100k tokens (was 59,969 / 13,077), whole
 * JSON. v0.60.46.0 (agent operator wave merged): 24,100 model-visible
 * characters / 5,414 tokens; 25,735 with annotations, which the wave's
 * contract derives for every op from its required mutating/idempotent tags.
 * Per-tool budgets below cover the whole definition, annotations included;
 * the rows the merge raised are the annotation bytes (+22 to +36) plus the
 * F10 template text that brought sub-60-character descriptions up to
 * purpose + next step + scope, and query's key-dependence sentence.
 * Entity recall: entity +140 (referenced_by, backlink_count scope, the
 * previews-are-not-evidence rule) and get_backlinks +250 (type, group, limit,
 * cursor) are paid by equal budget cuts: query -150 and search -90 (shorter
 * descriptions and parameter text; every pinned phrase kept), recall -50,
 * remember -40, get_page -30, list_pages -30 (slack). Served starter list
 * after: 24,324 model-visible characters, 5,471 tokens, 25,959 JSON characters.
 * #6007 raised put_page (wait_ms param, put_pages and remote mention-link
 * disclosure), get_write_request (poll cadence and final states),
 * add_timeline_entry (when no call is needed) and the instructions (write
 * guidance); the served list still fits 25,000 model-visible characters.
 * Wave 16 (#6040 item 1): query and search both name people/companies/projects
 * by topic as `query` work (+77, the measured routing fix), paid for by
 * redundant words in unowned tool text (`(v1)` on six verb labels, `Optional;`
 * on request_id, examples that repeat the description); the served list is
 * measured at 24,768 and must keep SERVED_STARTER_MIN_HEADROOM free so the
 * next description edit does not land on the ceiling again.
 * GBRA-156 (harnesses re-fetch tools/list every turn): the served list was
 * 26,546 bytes; the starter list now leaves out params MCP callers cannot use
 * (local-only, server-set), legacy and duplicate params, admin, versioned
 * skill-catalog, image and code-search params, and tuning or recovery knobs
 * with safe defaults (a refusal that needs one names it). Dispatch accepts
 * them on every surface and request_tools {tools} returns them; MEMORY VERB
 * prefixes went too. Measured 19,489 bytes (17,737 model-visible characters,
 * 4,037 tokens); every ceiling below came down with it, keeping room for the
 * parallel search/query source_ids param.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type Operation } from '../src/core/operations.ts';
import { filterOpsForSurface, STARTER_OPS } from '../src/mcp/surface.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { stdioVisibleTools } from '../src/mcp/server.ts';
import { buildMcpInstructions, GBRAIN_MCP_INSTRUCTIONS } from '../src/mcp/instructions.ts';
import { cl100kAvailable, estimateTokens } from '../src/core/chunkers/token-estimate.ts';

const SERVED_STARTER_MAX_CHARS = 18_200;
/** Headroom the served starter list must keep under the ceiling (wave 16: 24,998 of 25,000 left 2 characters; 200 is what the wave reaches without touching text other threads own, raised to 300 once the entity card and query/search trims land). */
const SERVED_STARTER_MIN_HEADROOM = 200;
const SERVED_STARTER_MAX_TOKENS = 4_300;
/** The whole tools/list JSON, annotations included (25,735 measured at v0.60.46.0; traverse_graph's `hops` is full-surface-only, 25,941 measured; 26,402 once mute_notice, the dismissal for the coaching notices starter sessions receive, joined starter; 26,671 with #6007's put_page wait_ms param and write guidance, which carry the put_pages hint and the receipt poll rule starter agents need; 26,679 with delta's opaque `cursor` param, paid for by trimming delta's own descriptions, model-visible 24,985; 26,692 with recall's `question` param, paid for by trimming recall's own parameter text, model-visible 24,998; 24,996 after the #6446 merge, recall's grep text trimmed again). */
const SERVED_STARTER_MAX_JSON_CHARS = 19_800; // GBRA-156: 19,431 measured
/** GBRA-156: the UTF-8 bytes of the served starter tools/list result (`{"tools":[...]}`, annotations included) that harnesses re-fetch every turn. */
const SERVED_STARTER_MAX_RESULT_BYTES = 19_800; // 26,546 before GBRA-156, 19,489 after
/** 4,042 at the cost wave + 586 for the operator contract's error protocol, notice prefix and memory loop (F1); no schema guidance moved here. */
const INSTRUCTIONS_MAX_CHARS = 5_108; // #6007: +240 for the issue-required write guidance (put_pages, wait_ms); Cat 40 Hard round 4: +107 for batching lists of names (entity names, keyword OR) and sending independent calls together; d5b: +70 for the brief naming the fields compact `entity names` rows carry (the maximal rendering, record types enrolled; +39 at the default) instead of a `referenced_by` walk batch mode cannot do; F4: +63 for instruction 7's governing rule (the record whose terms are in effect on the date asked about governs; page dates are named as page dates), 74 characters longer than the "prefer the newest governing source" sentence it replaces, 11 paid by cutting "the best-ranked excerpts" to "top excerpts" in the same clause
const DESCRIPTION_HARD_CAP = 1_200;
const PARAM_DESCRIPTION_HARD_CAP = 200;

/**
 * Per-tool budget: JSON.stringify of the served tool definition. get_backlinks / traverse_graph carry the temporal status + as_of params (live relationships by default).
 * remember 1330 -> 1370: the additive `items` batch param (save up to 20 facts
 * before compaction), measured at 1,344 after its descriptions were shortened so the
 * served starter list stays under 25,000 next to #6007's put_page growth.
 * search 1670 -> 1800: keyword OR across quoted names and the pointer to entity names (Cat 40 Hard
 * round 4), paid for by trimming query, list_pages, capture, mute_notice and request_tools text.
 * entity 470 -> 550: the additive `names` param (resolve up to 50 names in one
 * call, Cat 40 Hard round 4), measured at 546 with the `name` example and part
 * of the miss sentence trimmed so the served starter list stays under 25,000.
 * add_timeline_entry 680 -> 730 (#5970, wave 15): the description names the
 * correction route (edit its bullet via edit_page with expected_revision),
 * measured at 720 after its own text was tightened; get_ingest_log,
 * list_write_requests, traverse_graph and list_link_sources lost redundant
 * words (no pinned phrase, every description still >= 60 characters) so the
 * served starter list stays at or under 25,000.
 * GBRA-156 lowered the budgets of every tool whose starter params or text it cut
 * to the measured size plus 20-30 (search and query plus about 150, the room
 * their parallel source_ids param needs).
 * search 1800 -> 1830 (wave 16, #6040 item 1): the redirect reads
 * `Concepts/landscape or people/companies/projects by topic: \`query\``, measured
 * at 1,826. Without it Haiku 4.5 routes "all the people that work on X" to
 * search (28/80 at temperature 1; 1/80 with the clause); the batching sentence
 * `Name lists: entity names.` stays, so the growth is paid by other tools.
 */
const TOOL_BUDGETS: Record<string, number> = {
  add_timeline_entry: 730, cancel_job: 270, cancel_write_request: 350, capture: 710, context_pack: 500,
  delete_skill: 810, delta: 580, edit_page: 1040, entity: 550, find_anomalies: 400, forget: 530, get_agent_job: 270,
  get_backlinks: 710, get_ingest_log: 280, get_page: 510, get_recent_salience: 450, get_skill: 490,
  get_skill_asset: 530, get_write_request: 360, join_brain: 560, leave_brain: 540, list_brain_skillpack: 230,
  list_link_sources: 220, list_pages: 850, list_skills: 400, list_write_requests: 370, put_page: 1090,
  mute_notice: 420, put_skill: 1420, query: 1700, recall: 840, remember: 940, request_tools: 530, resolve_slugs: 410, search: 1420,
  submit_agent: 420, sync_brain_skills: 770, synthesize: 510, traverse_graph: 600, whoami: 230,
};

/** DX-14: phrases each tool's description must keep. */
const MINIMUM_GUIDANCE: Record<string, string[]> = {
  search: ['no LLM expansion', 'top 20', 'NOT proof of coverage', '`query`', 'list_pages', 'return_unit', 'fields: "full"'],
  query: ['expansion', 'Still top-K', 'return_unit', 'list_pages', '`search` is cheaper', 'LLM call', 'fields: "full"'],
  // Wave 12: the request_id UUID rule is back (gbrain-evals#92: without it Opus sent a non-UUID first request_id more often).
  put_page: ['REPLACES the whole page', 'get_page include_content:true', 'expected_revision', 'Keep a request_id UUID; retry with identical arguments', 'edit_page'],
  edit_page: ['prefer this over put_page', 'expected_revision', 'exactly once', 'all or none', 'revision_conflict'],
  get_page: ['include_content:true', 'put_page', 'edit_page'],
  list_pages: ['sort=updated_desc', 'Default 50', 'truncated', 'updated_after_slug'],
  capture: ['inbox/', 'idempotent', 'put_page', 'remember'],
  remember: ['provenance', '`entity`', '`status`', 'write_pending', 'get_write_request'],
  recall: ['entity', '`query`', 'world facts only', 'synthesize'],
  entity: ['zero LLM', 'found:false', 'create_safety', 'recall'],
  forget: ['fact_id', 'Idempotent'],
  synthesize: ['[EXPENSIVE', 'recall', 'entity'],
  context_pack: ['session start', 'compaction'],
  delta: ['session_id', 'since'],
  get_write_request: ['request_id', 'write_pending'],
  list_write_requests: ['newest first'],
  cancel_write_request: ['receipt'],
  request_tools: ['{tools', '{surface}'],
  list_skills: ['NOT executable code', 'get_skill', 'usable_tools', 'unavailable_tools'],
  get_skill: ['same-named MCP tool', 'nothing to execute', 'unavailable_tools'],
  get_recent_salience: ['Use this when the user asks', 'Do NOT run a semantic search'],
  find_anomalies: ['grouped by cohort', 'Cohort kinds: tag, type'],
  submit_agent: ['agent scope', 'get_agent_job'],
  get_agent_job: ['submit_agent', 'queue_position'],
  whoami: ['source_id', 'federated_read'],
  traverse_graph: ['depth'],
};

const json = (ops: Operation[]) => JSON.stringify(buildToolDefs(ops)).length - 2 - Math.max(0, ops.length - 1);
/** What a model receives per tool: the harness bridges forward name, description and inputSchema only. */
const modelVisible = (ops: Operation[]) => buildToolDefs(ops).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const size = (ops: Operation[]) => JSON.stringify(modelVisible(ops)).length - 2 - Math.max(0, ops.length - 1);

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine?.disconnect(); });

async function served(publishSkills: boolean): Promise<Operation[]> {
  await engine.setConfig('mcp.publish_skills', String(publishSkills));
  return stdioVisibleTools(engine, filterOpsForSurface(operations, 'starter'));
}

describe('served starter tool list (Cat 40 configuration)', () => {
  test('publish_skills on (the fresh-init default): 35 tools within the character ceiling', async () => {
    const ops = await served(true);
    expect(ops.map(o => o.name)).toContain('get_skill');
    expect(ops.length).toBe(35);
    expect(size(ops)).toBeLessThanOrEqual(SERVED_STARTER_MAX_CHARS);
    expect(json(ops)).toBeLessThanOrEqual(SERVED_STARTER_MAX_JSON_CHARS);
  });

  test('publish_skills off: within the character ceiling', async () => {
    const ops = await served(false);
    expect(ops.map(o => o.name)).not.toContain('get_skill');
    expect(size(ops)).toBeLessThanOrEqual(SERVED_STARTER_MAX_CHARS);
  });

  test('the served list keeps headroom under the ceiling, publish_skills on and off (wave 16)', async () => {
    for (const publishSkills of [true, false]) {
      const ops = await served(publishSkills);
      expect(SERVED_STARTER_MAX_CHARS - size(ops), `publish_skills=${publishSkills}`).toBeGreaterThanOrEqual(SERVED_STARTER_MIN_HEADROOM);
    }
  });

  test('the tools/list result stays within its byte budget, publish_skills on and off (GBRA-156)', async () => {
    for (const publishSkills of [true, false]) {
      const bytes = Buffer.byteLength(JSON.stringify({ tools: buildToolDefs(await served(publishSkills)) }));
      expect(bytes, `publish_skills=${publishSkills}`).toBeLessThanOrEqual(SERVED_STARTER_MAX_RESULT_BYTES);
    }
  });

  test('cl100k token ceiling', async () => {
    if (!cl100kAvailable()) return;
    expect(estimateTokens(JSON.stringify(modelVisible(await served(true))))).toBeLessThanOrEqual(SERVED_STARTER_MAX_TOKENS);
  });

  test('initialize instructions stay at or below their recorded size', () => {
    expect(GBRAIN_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });

  // Per-arm renderings: all off (names-row off, no records, `newest`), names-row on / records off, F4 only
  // (`in_effect`, names-row off, no records), and the maximal one (records enrolled, names-row on, `in_effect`) at 5,108.
  test('every per-arm rendering stays at or below the recorded size; the maximal one is the recorded size', () => {
    let max = 0;
    for (const governingRule of ['newest', 'in_effect'] as const) {
      for (const namesRow of [false, true]) {
        for (const records of [false, true]) {
          const size = buildMcpInstructions({ references: { namesRow, records }, governingRule }).length;
          max = Math.max(max, size);
          expect({ governingRule, namesRow, records, fits: size <= INSTRUCTIONS_MAX_CHARS }).toEqual({ governingRule, namesRow, records, fits: true });
        }
      }
    }
    expect(buildMcpInstructions({ references: { namesRow: true, records: true }, governingRule: 'in_effect' }).length).toBe(max);
  });
});

describe('per-tool schema budgets', () => {
  const starter = operations.filter(o => STARTER_OPS.has(o.name));

  test('every starter op has a budget', () => {
    expect(starter.map(o => o.name).sort()).toEqual(Object.keys(TOOL_BUDGETS).sort());
  });

  for (const op of filterOpsForSurface(operations, 'starter')) {
    test(`${op.name} fits its budget and the hard caps`, () => {
      const [def] = buildToolDefs([op]);
      expect(JSON.stringify(def).length).toBeLessThanOrEqual(TOOL_BUDGETS[op.name]);
      expect(op.description.length).toBeLessThanOrEqual(DESCRIPTION_HARD_CAP);
      const walk = (p: { description?: string; items?: unknown; properties?: Record<string, unknown> }, path: string): void => {
        expect((p.description ?? '').length, path).toBeLessThanOrEqual(PARAM_DESCRIPTION_HARD_CAP);
        if (p.items) walk(p.items as never, `${path}[]`);
        for (const [k, v] of Object.entries(p.properties ?? {})) walk(v as never, `${path}.${k}`);
      };
      for (const [k, p] of Object.entries(op.params)) walk(p as never, `${op.name}.${k}`);
    });
  }
});

describe('minimum guidance (DX-14)', () => {
  for (const [name, phrases] of Object.entries(MINIMUM_GUIDANCE)) {
    test(name, () => {
      const op = operations.find(o => o.name === name)!;
      for (const phrase of phrases) expect(op.description, `${name}: ${phrase}`).toContain(phrase);
    });
  }

  test('remember items description names entity and the optional item fields on starter and full (#6363)', () => {
    for (const surface of ['starter', 'full'] as const) {
      const op = filterOpsForSurface(operations, surface).find(o => o.name === 'remember')!;
      const [def] = buildToolDefs([op]);
      const items = (def.inputSchema.properties as Record<string, { description?: string }>).items;
      for (const field of ['fact', 'entity', 'provenance', 'kind', 'ttl', 'visibility']) {
        expect(items.description, `${surface}: ${field}`).toContain(field);
      }
    }
  });

  test('starter search and query keep the params agents need to scope and page a call (GBRA-156)', () => {
    const listed = (name: string) => Object.keys(buildToolDefs(filterOpsForSurface(operations, 'starter').filter(o => o.name === name))[0].inputSchema.properties);
    expect(listed('search')).toEqual(expect.arrayContaining(['query', 'limit', 'offset', 'match', 'cursor', 'source_id', 'types', 'return_unit']));
    expect(listed('query')).toEqual(expect.arrayContaining(['query', 'limit', 'offset', 'source_id', 'types', 'since', 'until', 'return_unit', 'expand']));
    // where and min_trust were full-surface-only before GBRA-156 too: callable on starter, schema via request_tools {tools}.
    for (const name of ['search', 'query']) {
      expect(listed(name)).not.toContain('where');
      expect(listed(name)).not.toContain('min_trust');
      expect(Object.keys(operations.find(o => o.name === name)!.params)).toEqual(expect.arrayContaining(['where', 'min_trust']));
    }
  });

  test('every required input of a starter tool is declared in its schema', () => {
    for (const def of buildToolDefs(operations.filter(o => STARTER_OPS.has(o.name)))) {
      for (const key of def.inputSchema.required) expect(def.inputSchema.properties, `${def.name}.${key}`).toHaveProperty(key);
    }
  });
});
