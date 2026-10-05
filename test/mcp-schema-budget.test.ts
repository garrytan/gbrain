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
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type Operation } from '../src/core/operations.ts';
import { filterOpsForSurface, STARTER_OPS } from '../src/mcp/surface.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { stdioVisibleTools } from '../src/mcp/server.ts';
import { GBRAIN_MCP_INSTRUCTIONS } from '../src/mcp/instructions.ts';
import { cl100kAvailable, estimateTokens } from '../src/core/chunkers/token-estimate.ts';

const SERVED_STARTER_MAX_CHARS = 25_150;
const SERVED_STARTER_MAX_TOKENS = 5_700;
/** The whole tools/list JSON, annotations included (25,735 measured at v0.60.46.0; traverse_graph's `hops` is full-surface-only, 25,941 measured; 26,402 once mute_notice, the dismissal for the coaching notices starter sessions receive, joined starter; 26,671 with #6007's put_page wait_ms param and write guidance, which carry the put_pages hint and the receipt poll rule starter agents need; 26,679 with delta's opaque `cursor` param, paid for by trimming delta's own descriptions, model-visible 24,985; get_page omit_facts and the put_page restore note on top). */
const SERVED_STARTER_MAX_JSON_CHARS = 26_850;
/** 4,042 at the cost wave + 586 for the operator contract's error protocol, notice prefix and memory loop (F1); no schema guidance moved here. */
const INSTRUCTIONS_MAX_CHARS = 4_868; // #6007: +240 for the issue-required write guidance (put_pages, wait_ms)
const DESCRIPTION_HARD_CAP = 1_200;
const PARAM_DESCRIPTION_HARD_CAP = 200;

/** Per-tool budget: JSON.stringify of the served tool definition. get_backlinks / traverse_graph carry the temporal status + as_of params (live relationships by default). */
const TOOL_BUDGETS: Record<string, number> = {
  add_timeline_entry: 680, cancel_job: 270, cancel_write_request: 350, capture: 1250, context_pack: 760,
  delete_skill: 810, delta: 830, edit_page: 1090, entity: 470, find_anomalies: 520, forget: 560, get_agent_job: 270,
  get_backlinks: 770, get_ingest_log: 280, get_page: 970, get_recent_salience: 660, get_skill: 910,
  get_skill_asset: 790, get_write_request: 360, join_brain: 560, leave_brain: 540, list_brain_skillpack: 230,
  list_link_sources: 220, list_pages: 1060, list_skills: 670, list_write_requests: 450, put_page: 1510,
  mute_notice: 460, put_skill: 1420, query: 3100, recall: 1540, remember: 1330, request_tools: 560, resolve_slugs: 410, search: 1670,
  submit_agent: 750, sync_brain_skills: 770, synthesize: 550, traverse_graph: 810, whoami: 230,
};

/** DX-14: phrases each tool's description must keep. */
const MINIMUM_GUIDANCE: Record<string, string[]> = {
  search: ['no LLM expansion', 'top 20', 'NOT proof of coverage', '`query`', 'list_pages', 'return_unit', 'fields: "full"'],
  query: ['expansion', 'Still top-K', 'return_unit', 'list_pages', '`search` is cheaper', 'LLM call', 'fields: "full"'],
  put_page: ['REPLACES the whole page', 'get_page include_content:true', 'expected_revision', 'request_id', 'edit_page'],
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
  test('publish_skills on (the fresh-init default): 35 tools within 25,150 characters', async () => {
    const ops = await served(true);
    expect(ops.map(o => o.name)).toContain('get_skill');
    expect(ops.length).toBe(35);
    expect(size(ops)).toBeLessThanOrEqual(SERVED_STARTER_MAX_CHARS);
    expect(json(ops)).toBeLessThanOrEqual(SERVED_STARTER_MAX_JSON_CHARS);
  });

  test('publish_skills off: within 25,150 characters', async () => {
    const ops = await served(false);
    expect(ops.map(o => o.name)).not.toContain('get_skill');
    expect(size(ops)).toBeLessThanOrEqual(SERVED_STARTER_MAX_CHARS);
  });

  test('cl100k token ceiling', async () => {
    if (!cl100kAvailable()) return;
    expect(estimateTokens(JSON.stringify(modelVisible(await served(true))))).toBeLessThanOrEqual(SERVED_STARTER_MAX_TOKENS);
  });

  test('initialize instructions stay at or below their recorded size', () => {
    expect(GBRAIN_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
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

  test('every required input of a starter tool is declared in its schema', () => {
    for (const def of buildToolDefs(operations.filter(o => STARTER_OPS.has(o.name)))) {
      for (const key of def.inputSchema.required) expect(def.inputSchema.properties, `${def.name}.${key}`).toHaveProperty(key);
    }
  });
});
