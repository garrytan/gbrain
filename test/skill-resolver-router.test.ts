/**
 * The model picker (src/core/skills/resolver/router.ts) inside a turn.
 *
 * 1. Protects: the picker runs only when the caller passes router and
 *    skills.resolver.router is on; its picks fill the block (match_strength
 *    picked) under the session rules; its "no skill" empties the block; every
 *    failure falls back to the word matcher with a stable code; the spend
 *    ledger charges before the call and refuses past the daily cap; the
 *    prompt carries picker.json's descriptions and never a project skill's.
 * 2. Fails when: a library caller without router can start a call, a
 *    fallback changes the word matcher's answer, or the cap stops holding.
 * 3. Scratch GBRAIN_HOME with no brain and no database; the chat call is the
 *    gateway's test transport, so nothing leaves the machine.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setPickerTransportForTests, PickerHttpError, type PickerRequest } from '../src/core/skills/resolver/router-http.ts';
import { buildSkillIndex, resolveSkills } from '../src/core/skills/resolver/index.ts';
import { parsePickerReply, PICKER_DESCRIPTION_CHARS, readRouterSpend, routerTimeoutMs } from '../src/core/skills/resolver/router.ts';
import { routerSettings } from '../src/core/skills/resolver/config.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';

const scratch: string[] = [];
const tmp = (p = 'skrouter-') => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d; };
afterEach(() => { __setPickerTransportForTests(null); });
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

const LONG = 'Write weekly status reports for a team from the open tasks, the merged work and the meeting notes of the week, '.repeat(4) + 'TAILMARKER';
const SKILLS = [
  { id: 'gbrain:briefing', name: 'briefing', description: 'Prepare a daily briefing from calendar meetings and open notes' },
  { id: 'gbrain:reports', name: 'reports', description: LONG },
  { id: 'gbrain:people', name: 'people', description: 'Look up what the brain knows about a person' },
];

async function home(router: Record<string, unknown> | null): Promise<string> {
  const h = tmp();
  const f = join(tmp('skrouter-src-'), 'catalog.json');
  writeFileSync(f, JSON.stringify(SKILLS));
  await buildSkillIndex({ catalog: 'c', fromJson: f }, { home: h });
  if (router) writeFileSync(join(h, 'config.json'), JSON.stringify({ skills: { resolver: router } }));
  return h;
}

const calls: PickerRequest[] = [];
function reply(text: string, delayMs = 0) {
  calls.length = 0;
  __setPickerTransportForTests(async (req) => {
    calls.push(req);
    if (delayMs) await new Promise((r, j) => { const t = setTimeout(r, delayMs); req.signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
    return { text, refused: false, usage: { input: 3000, cacheRead: 0, cacheWrite: 0, output: 20 } };
  });
}
const turn = (h: string, message: string, extra: Record<string, unknown> = {}, router = true) => resolveSkills({ message, harness: 'claude-code', ...extra }, { home: h, catalogs: ['c'], router });
const strip = (o: object) => JSON.stringify({ ...o, meta: undefined, router: undefined });

describe('parsePickerReply', () => {
  test('a plugin id named without its namespace maps to the one id it can mean', () => {
    const known = new Set(['acme:notes', 'acme:review', 'other:review', 'plain']);
    expect(parsePickerReply('{"needed": true, "skills": ["notes", "review", "plain"]}', known)).toEqual({ needed: true, ids: ['acme:notes', 'plain'] });
    expect(parsePickerReply('{"needed": true, "skills": ["review"]}', known)).toEqual({ code: 'no_known_ids' });
  });
  const known = new Set(['a', 'b', 'c', 'd']);
  test('keeps known ids in order, at most three, once each', () => {
    expect(parsePickerReply('noise {"needed": true, "skills": ["b", "x", "b", "a", "c", "d"]} tail', known)).toEqual({ needed: true, ids: ['b', 'a', 'c'] });
  });
  test('needed false is an answer with no ids', () => {
    expect(parsePickerReply('{"needed": false, "skills": ["a"]}', known)).toEqual({ needed: false, ids: [] });
  });
  test('only unknown ids, or a reply that is not the JSON asked for, is a fallback', () => {
    expect(parsePickerReply('{"needed": true, "skills": ["zz"]}', known)).toEqual({ code: 'no_known_ids' });
    expect(parsePickerReply('I think a', known)).toEqual({ code: 'parse_failed' });
    expect(parsePickerReply('{"needed": "yes", "skills": []}', known)).toEqual({ code: 'parse_failed' });
  });
});

describe('the picker in a turn', () => {
  test('with the setting off the output carries no router field and matches a call without router', async () => {
    const h = await home(null);
    reply('{"needed": true, "skills": ["gbrain:people"]}');
    const a = (await turn(h, 'write the weekly status reports')).output;
    const b = (await turn(h, 'write the weekly status reports', {}, false)).output;
    expect(a.router).toBeUndefined();
    expect(JSON.stringify({ ...a, meta: undefined })).toBe(JSON.stringify({ ...b, meta: undefined }));
    expect(calls.length).toBe(0);
  });

  test('a caller that does not pass router never starts a call, whatever the config says', async () => {
    const h = await home({ router: true });
    reply('{"needed": true, "skills": ["gbrain:people"]}');
    const out = (await turn(h, 'write the weekly status reports', {}, false)).output;
    expect(calls.length).toBe(0);
    expect(out.router).toBeUndefined();
    expect(out.suggestions[0]?.id).toBe('gbrain:reports');
  });

  test('its pick fills the block even when no catalog word matches, and the prompt carries picker.json descriptions', async () => {
    const h = await home({ router: true });
    reply('{"needed": true, "skills": ["gbrain:people"]}');
    const out = (await turn(h, 'zzqx vvrt')).output;
    expect(out.suggestions.map(s => [s.id, s.match_strength])).toEqual([['gbrain:people', 'picked']]);
    expect(out.block).toContain('gbrain:people');
    expect(out.router).toMatchObject({ mode: 'picker', answered_by: 'picker', model: 'anthropic:claude-haiku-5-5', fallback: null });
    expect(out.router!.est_usd).toBeGreaterThan(0);
    expect(calls[0]!.system).toContain(LONG.split(/\s+/).join(' ').slice(0, PICKER_DESCRIPTION_CHARS));
    expect(calls[0]!.system).not.toContain('TAILMARKER');
    expect(calls[0]!.system).not.toContain('zzqx');
    expect(calls[0]!.message).toBe('zzqx vvrt');
    expect(calls[0]!.model).toBe('anthropic:claude-haiku-5-5');
  });

  test('its "no skill" empties the block even when words match', async () => {
    const h = await home({ router: true });
    reply('{"needed": false, "skills": ["gbrain:reports"]}');
    const out = (await turn(h, 'write the weekly status reports')).output;
    expect(out).toMatchObject({ no_skill: true, no_skill_reason: 'no_match', block_reason: 'no_match', block: '', suggestions: [] });
    expect(out.router?.answered_by).toBe('picker');
  });

  test('a skill named in the turn still shows when the picker says no skill', async () => {
    const h = await home({ router: true });
    reply('{"needed": false, "skills": []}');
    const out = (await turn(h, 'use gbrain:briefing for this')).output;
    expect(out.suggestions.map(s => [s.id, s.match_strength])).toEqual([['gbrain:briefing', 'named']]);
  });

  test('the session rules hold for picked skills: a repeat pick is deduped', async () => {
    const h = await home({ router: true });
    reply('{"needed": true, "skills": ["gbrain:people"]}');
    const first = await turn(h, 'zzqx', { session_id: 's1' });
    await first.commit();
    const second = (await turn(h, 'zzqx again', { session_id: 's1' })).output;
    expect(second.suggestions).toEqual([]);
    expect(second.block_reason).toBe('deduped');
    expect(second.deduped).toEqual(['gbrain:people']);
  });

  test('a provider error falls back to the word matcher\'s exact answer', async () => {
    const h = await home({ router: true });
    __setPickerTransportForTests(async () => { throw new Error('upstream 500'); });
    const out = (await turn(h, 'write the weekly status reports')).output;
    const words = (await turn(h, 'write the weekly status reports', {}, false)).output;
    expect(out.router).toMatchObject({ answered_by: 'words', fallback: { code: 'provider_error' } });
    expect(strip(out)).toBe(strip(words));
  });

  test('a slow picker is cut off at router_timeout_ms and the words answer', async () => {
    const h = await home({ router: true, router_timeout_ms: 200 });
    reply('{"needed": true, "skills": ["gbrain:people"]}', 2000);
    const t0 = performance.now();
    const out = (await turn(h, 'write the weekly status reports')).output;
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(out.router).toMatchObject({ answered_by: 'words', fallback: { code: 'timeout' } });
    expect(out.suggestions[0]?.id).toBe('gbrain:reports');
  });

  test('a turn cut off after its call went out reports the reservation the ledger keeps', async () => {
    const h = await home({ router: true, router_timeout_ms: 200 });
    reply('{"needed": true, "skills": ["gbrain:people"]}', 2000);
    const out = (await turn(h, 'write the weekly status reports')).output;
    expect(out.router?.fallback).toEqual({ code: 'timeout' });
    expect(out.router!.est_usd).toBeGreaterThan(0);
    expect((await readRouterSpend(h)).charged_usd).toBeCloseTo(out.router!.est_usd, 6);
  });

  test('Claude Code waits at most 2000 ms for the picker, whatever router_timeout_ms says', () => {
    const s = routerSettings({ router: true, router_timeout_ms: 2500 });
    expect(routerTimeoutMs('claude-code', s)).toBe(2000);
    expect(routerTimeoutMs('codex', s)).toBe(2500);
    expect(routerTimeoutMs('claude-code', routerSettings({ router: true }))).toBe(1500);
  });

  test('above 150 skills, a message sharing no word with any skill makes no call', async () => {
    const h = tmp();
    const f = join(tmp('skrouter-src-'), 'catalog.json');
    writeFileSync(f, JSON.stringify(Array.from({ length: 151 }, (_, i) => ({ id: `gbrain:skill-${i}`, name: `skill-${i}`, description: `Prepare report number ${i} for the team` }))));
    await buildSkillIndex({ catalog: 'c', fromJson: f }, { home: h });
    writeFileSync(join(h, 'config.json'), JSON.stringify({ skills: { resolver: { router: true } } }));
    reply('{"needed": true, "skills": ["gbrain:skill-1"]}');
    const out = (await turn(h, 'zzqx')).output;
    expect(calls.length).toBe(0);
    expect(out.router).toMatchObject({ answered_by: 'words', fallback: null, est_usd: 0 });
    expect(out.no_skill).toBe(true);
  });

  test('a reply naming no catalog skill falls back with no_known_ids', async () => {
    const h = await home({ router: true });
    reply('{"needed": true, "skills": ["not-a-skill"]}');
    expect((await turn(h, 'write the weekly status reports')).output.router?.fallback).toEqual({ code: 'no_known_ids' });
  });

  test('a bad router value does not refuse the turn: config_invalid, no call, the words answer', async () => {
    const h = await home({ router: true, router_timeout_ms: 5 });
    reply('{"needed": true, "skills": ["gbrain:people"]}');
    const out = (await turn(h, 'write the weekly status reports')).output;
    expect(out.router?.fallback).toEqual({ code: 'config_invalid' });
    expect(calls.length).toBe(0);
    expect(out.suggestions[0]?.id).toBe('gbrain:reports');
  });

  test('an unpriced model cannot run under the cap: no_pricing, no call', async () => {
    const h = await home({ router: true, router_model: 'openai:unpriced-model' });
    reply('{"needed": true, "skills": ["gbrain:people"]}');
    expect((await turn(h, 'zzqx')).output.router?.fallback).toEqual({ code: 'no_pricing' });
    expect(calls.length).toBe(0);
  });
});

describe('a compat: model on an OpenAI-compatible endpoint', () => {
  const seen: { path: string; auth: string | null; body: any }[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const path = new URL(req.url).pathname;
    seen.push({ path, auth: req.headers.get('authorization'), body: await req.json() });
    if (path.startsWith('/denied/') || path.startsWith('/gdeny/')) return new Response('{"error": "forbidden"}', { status: 403 });
    if (path.startsWith('/hop/')) return new Response(null, { status: 307, headers: { location: '/v1/chat/completions' } });
    if (path.startsWith('/a/')) return Response.json({ content: [{ type: 'text', text: '{"needed": true, "skills": ["gbrain:people"]}' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 10 } });
    if (path.startsWith('/o/')) return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"needed": true, "skills": ["gbrain:people"]}' }] }], usage: { input_tokens: 1000, output_tokens: 10 } });
    if (path.startsWith('/g/')) return Response.json({ candidates: [{ content: { parts: [{ text: '{"needed": true, "skills": ["gbrain:people"]}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 10, thoughtsTokenCount: 150 } });
    const answer = '"choices": [{"message": {"content": "{\\"needed\\": true, \\"skills\\": [\\"gbrain:people\\"]}"}, "finish_reason": "stop"}]';
    if (path.startsWith('/huge/')) return new Response('{' + answer + ', "usage": {"prompt_tokens": 1e400, "completion_tokens": 10}}', { headers: { 'content-type': 'application/json' } });
    if (path.startsWith('/partial/')) return new Response('{' + answer + ', "usage": {"completion_tokens": 10}}', { headers: { 'content-type': 'application/json' } });
    if (path.startsWith('/cached/')) return new Response('{' + answer + ', "usage": {"prompt_tokens": 1000, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 900}}}', { headers: { 'content-type': 'application/json' } });
    return Response.json({ choices: [{ message: { content: '{"needed": true, "skills": ["gbrain:people"]}' }, finish_reason: 'stop' }], ...(path.startsWith('/nousage/') ? {} : { usage: { prompt_tokens: 1000, completion_tokens: 10 } }) });
  } });
  afterAll(() => server.stop(true));
  const compat = (extra: Record<string, unknown>) => ({ router: true, router_model: 'compat:acme/picker-1', router_base_url: `http://127.0.0.1:${server.port}/v1`, ...extra });
  const env = { ...process.env, ACME_PICKER_KEY: 'k-test' };

  test('plugs in by base URL, model id and key name, priced from config', async () => {
    seen.length = 0;
    const h = await home(compat({ router_api_key_env: 'ACME_PICKER_KEY', router_usd_per_mtok: [1, 2] }));
    const r = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: h, catalogs: ['c'], router: true, env });
    expect(r.output.router).toMatchObject({ answered_by: 'picker', model: 'compat:acme/picker-1', fallback: null, est_usd: 0.00102 });
    expect(r.output.suggestions.map(x => x.id)).toEqual(['gbrain:people']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/v1/chat/completions');
    expect(seen[0]!.auth).toBe('Bearer k-test');
    expect(seen[0]!.body.model).toBe('acme/picker-1');
    expect(seen[0]!.body.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    expect((await readRouterSpend(h)).charged_usd).toBe(0.00102);
  });

  test('with no key name it sends no key; a named key that is unset is missing_key', async () => {
    seen.length = 0;
    const open = await home(compat({ router_usd_per_mtok: [0, 0] }));
    const r = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: open, catalogs: ['c'], router: true, env });
    expect(r.output.router?.answered_by).toBe('picker');
    expect(seen[0]!.auth).toBeNull();
    const h = await home(compat({ router_api_key_env: 'ACME_UNSET_KEY', router_usd_per_mtok: [0, 0] }));
    const m = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: h, catalogs: ['c'], router: true, env });
    expect(m.output.router?.fallback).toEqual({ code: 'missing_key' });
    expect(seen).toHaveLength(1);
  });

  test('no price is no_pricing and no base URL is config_invalid, with no call', async () => {
    seen.length = 0;
    const unpriced = await home(compat({}));
    expect((await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: unpriced, catalogs: ['c'], router: true, env })).output.router?.fallback).toEqual({ code: 'no_pricing' });
    const nourl = await home({ router: true, router_model: 'compat:acme/picker-1', router_usd_per_mtok: [0, 0] });
    expect((await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: nourl, catalogs: ['c'], router: true, env })).output.router?.fallback).toEqual({ code: 'config_invalid' });
    const remote = await home(compat({ router_base_url: 'http://models.example.com/v1', router_usd_per_mtok: [0, 0] }));
    expect((await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: remote, catalogs: ['c'], router: true, env })).output.router?.fallback).toEqual({ code: 'config_invalid' });
    expect(seen).toHaveLength(0);
  });

  test('a redirect is refused, so the prompt reaches no second URL', async () => {
    seen.length = 0;
    const h = await home(compat({ router_base_url: `http://127.0.0.1:${server.port}/hop/v1`, router_usd_per_mtok: [1, 2] }));
    const r = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: h, catalogs: ['c'], router: true, env });
    expect(r.output.router?.fallback).toEqual({ code: 'provider_error' });
    expect(seen.map(x => x.path)).toEqual(['/hop/v1/chat/completions']);
  });

  test('a reply with no token counts keeps the whole reservation on the ledger', async () => {
    const h = await home(compat({ router_base_url: `http://127.0.0.1:${server.port}/nousage/v1`, router_usd_per_mtok: [1, 2] }));
    const r = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: h, catalogs: ['c'], router: true, env });
    expect(r.output.router?.answered_by).toBe('picker');
    const spend = (await readRouterSpend(h)).charged_usd;
    expect(spend).toBeGreaterThan(0.00102);
    expect(spend).toBeCloseTo(r.output.router!.est_usd, 6);
  });

  test('partial or non-finite token counts keep the whole reservation, and the ledger stays a number', async () => {
    for (const route of ['partial', 'huge']) {
      const h = await home(compat({ router_base_url: `http://127.0.0.1:${server.port}/${route}/v1`, router_usd_per_mtok: [1, 2] }));
      const r = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: h, catalogs: ['c'], router: true, env });
      expect(r.output.router?.answered_by).toBe('picker');
      const doc = JSON.parse(readFileSync(join(h, 'skill-index', 'router-spend.json'), 'utf8'));
      expect(typeof doc.charged_usd).toBe('number');
      expect(doc.charged_usd).toBeGreaterThan(0.00102);
      expect(doc.charged_usd).toBeCloseTo(r.output.router!.est_usd, 6);
    }
  });

  test('cached tokens on a compat endpoint are charged at its one input rate', async () => {
    const h = await home(compat({ router_base_url: `http://127.0.0.1:${server.port}/cached/v1`, router_usd_per_mtok: [1, 2] }));
    const r = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: h, catalogs: ['c'], router: true, env });
    expect(r.output.router?.est_usd).toBe(0.00102);
    expect((await readRouterSpend(h)).charged_usd).toBe(0.00102);
  });

  test('router_usd_per_mtok takes two or three prices, never four', async () => {
    expect(routerSettings({ router: true, router_model: 'compat:acme/picker-1', router_usd_per_mtok: [1, 2, 0.1, 3] }).invalid).toStartWith('skills.resolver.router_usd_per_mtok must be');
    expect(routerSettings({ router: true, router_model: 'compat:acme/picker-1', router_usd_per_mtok: [1, 2, 0.1] }).usdPerMtok).toEqual([1, 2, 0.1]);
  });

  test('a third router_usd_per_mtok value prices cached input', async () => {
    const h = await home(compat({ router_base_url: `http://127.0.0.1:${server.port}/cached/v1`, router_usd_per_mtok: [1, 2, 0.1] }));
    const r = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: h, catalogs: ['c'], router: true, env });
    expect(r.output.router?.est_usd).toBe(0.00021);
    expect((await readRouterSpend(h)).charged_usd).toBe(0.00021);
  });

  test('Opus and Fable 5.x think at low effort with room to answer; Sonnet 5.5 and Haiku keep thinking off', async () => {
    const aenv = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}/a`, ANTHROPIC_API_KEY: 'k-test' };
    for (const [model, want, effort, maxTokens] of [['claude-opus-5-5', 'adaptive', 'low', 1024], ['claude-fable-5-1', 'adaptive', 'low', 1024], ['claude-fable-5-2', 'adaptive', 'low', 1024], ['claude-sonnet-5-5', 'between_tools', 'low', 200], ['claude-sonnet-5', 'disabled', undefined, 200], ['claude-haiku-5-5', 'disabled', undefined, 200]] as const) {
      seen.length = 0;
      const h = await home({ router: true, router_model: `anthropic:${model}` });
      const r = await resolveSkills({ message: 'who is alice', harness: 'codex' }, { home: h, catalogs: ['c'], router: true, env: aenv });
      expect([model, r.output.router?.answered_by]).toEqual([model, 'picker']);
      const body = seen.find(s => s.path === '/a/v1/messages')!.body;
      expect([model, body.thinking]).toEqual([model, { type: want }]);
      expect([model, body.output_config]).toEqual([model, effort ? { effort } : undefined]);
      expect([model, body.max_tokens]).toEqual([model, maxTokens]);
    }
  });

  test('GPT-6.x Sol and Astra are priced and reason at low effort with room to answer; models that accept none keep it', async () => {
    const oenv = { ...process.env, OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/o`, OPENAI_API_KEY: 'k-test' };
    for (const [model, effort, maxTokens] of [['gpt-6.2-sol', 'low', 1024], ['gpt-6.1-sol', 'low', 1024], ['gpt-6.2-astra', 'low', 1024], ['gpt-6-astra', 'low', 1024], ['gpt-6-luna', 'none', 200]] as const) {
      seen.length = 0;
      const h = await home({ router: true, router_model: `openai:${model}` });
      const r = await resolveSkills({ message: 'who is alice', harness: 'codex' }, { home: h, catalogs: ['c'], router: true, env: oenv });
      expect([model, r.output.router?.answered_by]).toEqual([model, 'picker']);
      const body = seen.find(s => s.path === '/o/v1/responses')!.body;
      expect([model, body.reasoning, body.max_output_tokens]).toEqual([model, { effort }, maxTokens]);
    }
  });

  test('Gemini thinking tokens are charged as output', async () => {
    const h = await home({ router: true, router_model: 'google:gemini-3.5-flash-lite' });
    const genv = { ...process.env, GOOGLE_GENERATIVE_AI_BASE_URL: `http://127.0.0.1:${server.port}/g`, GEMINI_API_KEY: 'k-test' };
    const r = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: h, catalogs: ['c'], router: true, env: genv });
    const price = canonicalLookup('google:gemini-3.5-flash-lite')!;
    expect(r.output.router?.answered_by).toBe('picker');
    expect(r.output.router!.est_usd).toBeCloseTo((1000 * price.input + 160 * price.output) / 1e6, 6);
  });

  test('a 4xx from Anthropic, OpenAI or Google itself is refunded', async () => {
    const h = await home({ router: true, router_model: 'google:gemini-3.5-flash-lite' });
    const direct = { ...env, GOOGLE_GENERATIVE_AI_BASE_URL: undefined };
    __setPickerTransportForTests(async () => { throw new PickerHttpError(403); });
    const g = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: h, catalogs: ['c'], router: true, env: direct });
    expect(g.output.router).toMatchObject({ fallback: { code: 'provider_error' }, est_usd: 0 });
    expect((await readRouterSpend(h)).charged_usd).toBe(0);
  });

  test('a 4xx through a base-URL proxy or a compat endpoint keeps the reservation', async () => {
    const h = await home({ router: true, router_model: 'google:gemini-3.5-flash-lite' });
    const genv = { ...process.env, GOOGLE_GENERATIVE_AI_BASE_URL: `http://127.0.0.1:${server.port}/gdeny`, GEMINI_API_KEY: 'k-test' };
    const g = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: h, catalogs: ['c'], router: true, env: genv });
    expect(g.output.router?.fallback).toEqual({ code: 'provider_error' });
    expect(g.output.router!.est_usd).toBeGreaterThan(0);
    expect((await readRouterSpend(h)).charged_usd).toBeCloseTo(g.output.router!.est_usd, 6);
    const c = await home(compat({ router_base_url: `http://127.0.0.1:${server.port}/denied/v1`, router_usd_per_mtok: [1, 2] }));
    const r = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: c, catalogs: ['c'], router: true, env });
    expect(r.output.router?.fallback).toEqual({ code: 'provider_error' });
    expect(r.output.router!.est_usd).toBeGreaterThan(0);
    expect((await readRouterSpend(c)).charged_usd).toBeCloseTo(r.output.router!.est_usd, 6);
  });

  test('a cap of 0 stops a free model too, before any call', async () => {
    seen.length = 0;
    const h = await home(compat({ router_usd_per_mtok: [0, 0], router_max_usd_per_day: 0 }));
    const r = await resolveSkills({ message: 'who is alice', harness: 'claude-code' }, { home: h, catalogs: ['c'], router: true, env });
    expect(r.output.router?.fallback).toMatchObject({ code: 'daily_cap' });
    expect(seen).toHaveLength(0);
  });
});

describe('the daily spend cap', () => {
  test('each call is charged to the day\'s ledger, settled to its real cost', async () => {
    const h = await home({ router: true });
    reply('{"needed": true, "skills": ["gbrain:people"]}');
    const out = (await turn(h, 'zzqx')).output;
    const spend = await readRouterSpend(h);
    expect(spend.charged_usd).toBeCloseTo(out.router!.est_usd, 6);
    expect(spend.charged_usd).toBeGreaterThan(0);
  });

  test('a cap of 0 refuses every call before it is made', async () => {
    const h = await home({ router: true, router_max_usd_per_day: 0 });
    reply('{"needed": true, "skills": ["gbrain:people"]}');
    const out = (await turn(h, 'write the weekly status reports')).output;
    expect(out.router).toMatchObject({ answered_by: 'words', fallback: { code: 'daily_cap' } });
    expect(calls.length).toBe(0);
    expect((await readRouterSpend(h)).charged_usd).toBe(0);
  });

  test('a call whose largest cost would pass the cap is refused; spend from another day does not count', async () => {
    const h = await home({ router: true, router_max_usd_per_day: 0.001 });
    writeFileSync(join(h, 'skill-index', 'router-spend.json'), JSON.stringify({ v: 1, day: new Date().toISOString().slice(0, 10), charged_usd: 0.000999 }));
    reply('{"needed": true, "skills": ["gbrain:people"]}');
    expect((await turn(h, 'zzqx')).output.router?.fallback).toEqual({ code: 'daily_cap' });
    writeFileSync(join(h, 'skill-index', 'router-spend.json'), JSON.stringify({ v: 1, day: '2000-01-01', charged_usd: 5 }));
    expect((await turn(h, 'zzqx')).output.router?.fallback).toBeNull();
  });

  test('the reservation covers the most a call can cost: a token per character, all of it written to the cache', async () => {
    const h = await home({ router: true });
    let reserved = -1;
    __setPickerTransportForTests(async (req) => {
      reserved = (await readRouterSpend(h)).charged_usd;
      return { text: '{"needed": true, "skills": ["gbrain:people"]}', refused: false, usage: { input: 0, cacheRead: 0, cacheWrite: req.system.length + req.message.length, output: req.maxTokens } };
    });
    await turn(h, '会议纪要'.repeat(200));
    const settled = (await readRouterSpend(h)).charged_usd;
    expect(settled).toBeGreaterThan(0);
    expect(reserved).toBeGreaterThanOrEqual(settled);
  });

  test('a ledger already on the next day is never rewritten to an earlier one', async () => {
    const h = await home({ router: true });
    const file = join(h, 'skill-index', 'router-spend.json');
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    writeFileSync(file, JSON.stringify({ v: 1, day: tomorrow, charged_usd: 0.01 }));
    reply('{"needed": true, "skills": ["gbrain:people"]}');
    expect((await turn(h, 'zzqx')).output.router?.fallback).toBeNull();
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.day).toBe(tomorrow);
    expect(doc.charged_usd).toBeGreaterThan(0.01);
  });

  test('a far-future or malformed ledger day does not hold the cap past today', async () => {
    for (const day of ['2999-01-01', 'zzzz-bad']) {
      const h = await home({ router: true });
      writeFileSync(join(h, 'skill-index', 'router-spend.json'), JSON.stringify({ v: 1, day, charged_usd: 999 }));
      reply('{"needed": true, "skills": ["gbrain:people"]}');
      expect((await turn(h, 'zzqx')).output.router?.fallback).toBeNull();
      expect((await readRouterSpend(h)).day).toBe(new Date().toISOString().slice(0, 10));
    }
  });

  test("negative token counts cannot erase the day's spend", async () => {
    const h = await home({ router: true });
    __setPickerTransportForTests(async () => ({ text: '{"needed": true, "skills": ["gbrain:people"]}', refused: false, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: -99 } }));
    await turn(h, 'zzqx');
    const first = (await readRouterSpend(h)).charged_usd;
    await turn(h, 'zzqx');
    expect(first).toBeGreaterThan(0);
    expect((await readRouterSpend(h)).charged_usd).toBeGreaterThan(first);
  });
});
