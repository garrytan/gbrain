#!/usr/bin/env bun
/**
 * Generated regions of the agent operator protocol (contract v1, Lane G1).
 *
 *   bun run build:agent-protocol          rewrite the regions
 *   bun run build:agent-protocol --check  exit 1 when a committed region is stale
 *
 * 1. docs/protocol/AGENT_OPERATOR_v1.md "Transcripts": rendered from the
 *    frozen wire goldens in test/fixtures/agent-contract/v1/. Goldens never
 *    store `next`; it is recomputed here with deriveNext (the same decision
 *    table gbrain renders with) and checked against each transcript's
 *    expected value, so a contract change cannot silently rewrite the story.
 * 2. AGENTS.md "Agent operator protocol" quick contract: copied verbatim from
 *    the protocol page's quick-contract region.
 *
 * Adding a transcript (Lane H journey goldens): append a TRANSCRIPTS entry
 * naming its golden file, transport, expected `next` and narration. Journey
 * goldens (`journey/*.json`) are recorded by test/agent-journey.serial.test.ts
 * from real runs; their placeholders render as fixed example values.
 * Drift test: test/agent-protocol-doc.test.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveNext, type Action, type RenderContext, type Transport } from '../src/core/agent-output.ts';
import { renderConsentRefusal, type ConfirmationPayload } from '../src/core/consent.ts';

const ROOT = join(import.meta.dir, '..');
const GOLDENS = join(ROOT, 'test', 'fixtures', 'agent-contract', 'v1');
export const PROTOCOL_PATH = join(ROOT, 'docs', 'protocol', 'AGENT_OPERATOR_v1.md');
export const AGENTS_PATH = join(ROOT, 'AGENTS.md');
/** Transcripts show the source-checkout base; the wire pins the installed version. */
const DOCS_BASE = 'https://github.com/garrytan/gbrain/blob/master';

const TRANSCRIPT_REGION = 'agent-protocol:transcripts';
const QUICK_BEGIN = /<!-- BEGIN quick-contract[^>]*-->\n/;
const QUICK_END = '<!-- END quick-contract -->';

type Json = Record<string, unknown>;

interface Transcript {
  title: string;
  golden: string;
  transport: Transport;
  expectNext: string;
  setting: string;
  call: string;
  /** Prose for what the agent does, given the rendered value. */
  after: (doc: Json) => string;
  /** The value checked against expectNext when it is not a fix's `next` (an `ask` notice means ask_user). */
  nextOf?: (doc: Json) => string;
}

function contextFor(transport: Transport): RenderContext {
  // A fix that kept its `mcp` was callable when rendered; nothing is preapproved in the goldens.
  return { transport, isCallable: () => true, preapproved: () => false };
}

/** Insert `next` right after `actor`, the position renderAction emits it in. */
function withNext(fix: Json, ctx: RenderContext): Json {
  const next = deriveNext(fix as unknown as Action, ctx);
  const out: Json = {};
  for (const [k, v] of Object.entries(fix)) {
    out[k] = k === 'then' && v && typeof v === 'object' ? withNext(v as Json, ctx) : v;
    if (k === 'actor') out.next = next;
  }
  return out;
}

/** Recompute every `fix.next` in a golden value, including JSON carried in text blocks. */
function hydrate(value: unknown, ctx: RenderContext, noticeNexts: string[] = []): unknown {
  if (Array.isArray(value)) return value.map(v => hydrate(v, ctx, noticeNexts));
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      out[k] = k === 'fix' && v && typeof v === 'object' ? withNext(v as Json, ctx) : hydrate(v, ctx, noticeNexts);
    }
    return out;
  }
  if (typeof value !== 'string') return value;
  const text = value.split('{{DOCS_BASE}}').join(DOCS_BASE).replace(/\{\{([A-Z_]+)\}\}/g, (m, name: string) => JOURNEY_VALUES[name] ?? m);
  if (text.startsWith('{')) {
    try { return JSON.stringify(hydrate(JSON.parse(text), ctx), null, 2); } catch { /* prose */ }
  }
  return text.includes('next: {{next}}') ? text.replace('next: {{next}}', `next: ${noticeNexts.shift() ?? 'report'}`) : text;
}

/**
 * Journey goldens (test/fixtures/agent-contract/v1/journey/, Lane H) are real
 * runs with machine values replaced by placeholders; transcripts show fixed
 * example values instead.
 */
const JOURNEY_VALUES: Record<string, string> = {
  HOME: '/home/alice-example', PID: '48213', UUID: '7f3c2a10-5b6e-4d1a-9c8b-2e4f6a8d0c11', TIME: '2026-10-03T16:20:00.000Z',
  PLAN_HASH: 'ph_5f1c0e9a2b7d4c3e8a6b0d1f', DURATION_S: '0.4', ROOT_IDENTITY: '(device and inode of the content root)', DOCTOR_RUN_ID: '7f3c2a10-5b6e-4d1a-9c8b-2e4f6a8d0c11',
};

function loadGolden(name: string, transport: Transport): Json {
  const raw = JSON.parse(readFileSync(join(GOLDENS, name), 'utf8')) as Json;
  const ctx = contextFor(transport);
  const meta = (raw._meta as { gbrain_notices?: { fix?: Json }[] } | undefined)?.gbrain_notices ?? [];
  const noticeNexts = meta.map(n => (n.fix ? deriveNext(n.fix as unknown as Action, ctx) : 'report'));
  return hydrate(raw, ctx, noticeNexts) as Json;
}

/** The envelope inside an MCP error result, or the document itself. */
function body(doc: Json): Json {
  const content = doc.content as { text: string }[] | undefined;
  return Array.isArray(content) ? JSON.parse(content[0].text) as Json : doc;
}

function step(fix: Json | undefined): string {
  if (!fix) return '';
  const mcp = fix.mcp as { tool: string; arguments: unknown } | undefined;
  return mcp ? `${mcp.tool} ${JSON.stringify(mcp.arguments)}` : String(fix.command ?? '');
}

const fence = (lang: string, text: string) => `\`\`\`${lang}\n${text.replace(/\n$/, '')}\n\`\`\``;

export const TRANSCRIPTS: readonly Transcript[] = [
  {
    title: 'A caller mistake over MCP: `run`',
    golden: 'error-with-fix.json',
    transport: 'stdio',
    expectNext: 'run',
    setting: 'A harness on stdio MCP (surface `full`) lists pages with a sort key that does not exist.',
    call: 'list_pages {"sort":"bogus"}',
    after: (doc) => {
      const env = body(doc);
      const fix = env.fix as Json;
      const verify = step(fix.verify as Json | undefined);
      return `The result is one content block. The agent reads \`code: ${env.code}\` and \`fix.next: ${fix.next}\`, `
        + `so it calls \`${step(fix)}\` itself, then confirms with the read-only \`${verify}\`. `
        + 'Nothing needs the user.';
    },
  },
  {
    title: 'Paid work without approval on the CLI: `ask_user`, exit 3',
    golden: 'confirmation-required.json',
    transport: 'cli',
    expectNext: 'ask_user',
    setting: 'An agent runs remediation from a non-interactive shell without `--yes` or `--max-usd`.',
    call: 'gbrain doctor --remediate --json',
    after: (doc) => {
      const fix = doc.fix as Json;
      const preview = (doc.preview as Json | null)?.command;
      return `Nothing ran and the command exited 3. The agent reads \`fix.next: ${fix.next}\`, relays \`user_message\` `
        + `("${doc.user_message}") and stops. It may offer the read-only preview \`${preview}\`. `
        + `Only after the user agrees does it run \`${fix.command}\`. Passing \`--yes\` on its own would be a consent violation `
        + 'even though gbrain cannot tell the difference.';
    },
  },
  {
    title: 'An empty recall with a notice: `tell_user_to_run`',
    golden: 'bare-array-result.json',
    transport: 'stdio',
    expectNext: 'tell_user_to_run',
    setting: 'A harness on stdio MCP searches a keyless brain and nothing matches.',
    call: 'search {"query":"…"}',
    after: (doc) => {
      const n = ((doc._meta as Json).gbrain_notices as Json[])[0];
      const fix = n.fix as Json;
      return `\`content[0]\` is still the bare array \`[]\`; the second block is the notice. The agent does not tell the user `
        + `"you have no notes on that". It relays \`user_message\` ("${n.user_message}"). \`fix.next\` is \`${fix.next}\` `
        + `because the fix is the user's to run (\`${fix.command}\`) in their terminal, so the agent offers it rather than running it.`;
    },
  },
  {
    title: 'First run on a keyless brain: one decision bundle, `ask_user` (journey)',
    golden: 'journey/init-first-run.json',
    transport: 'cli',
    expectNext: 'ask_user',
    setting: 'An agent installs gbrain for a user with no provider keys, from a non-interactive shell (H1a journey, recorded from the real CLI).',
    call: 'gbrain init --pglite --no-embedding --json',
    nextOf: (doc) => (((doc.notices as Json[]).find(n => n.code === 'first_run_decisions')?.kind) === 'ask' ? 'ask_user' : ''),
    after: (doc) => {
      const bundle = (doc.notices as Json[]).find(n => n.code === 'first_run_decisions') as Json;
      const ids = (bundle.decisions as Json[]).map(d => `\`${d.id}\` (default \`${d.default}\`)`).join(', ');
      return `stdout is one document; the brain is ready and nothing blocks using it. The \`first_run_decisions\` notice is \`kind: ask\`, `
        + `so the agent relays its \`user_message\` ("${bundle.user_message}") once and stops. The decisions are ${ids}; `
        + 'each option carries the exact argv to apply it, so a reply of "defaults" needs no command at all.';
    },
  },
  {
    title: 'A caller mistake over stdio MCP, recorded: `run` (journey)',
    golden: 'journey/caller-mistake.json',
    transport: 'stdio',
    expectNext: 'run',
    setting: 'A harness on `gbrain serve --surface verbs` passes a string where `recall` expects a number (H1a journey, recorded from a real stdio session).',
    call: 'recall {"query":"quokka-journey-marker","limit":"abc"}',
    after: (doc) => {
      const env = body(doc);
      const fix = env.fix as Json;
      return `One content block, \`code: ${env.code}\`, \`class: ${env.class}\`. Nothing ran, so \`fix.next: ${fix.next}\`: the agent calls `
        + `\`${step(fix)}\` exactly as given (its other arguments kept, the bad one corrected) and gets the recall it wanted.`;
    },
  },
  {
    title: 'A second session on a locked brain: status-only serve, `tell_user_to_run` (journey)',
    golden: 'journey/status-only-lock-held.json',
    transport: 'stdio',
    expectNext: 'tell_user_to_run',
    setting: 'A second agent session starts `gbrain serve` while another session\'s serve owns the PGLite brain. The handshake still completes, with one tool, `gbrain_status` (H1a journey, recorded).',
    call: 'gbrain_status {}',
    after: (doc) => {
      const env = body(doc);
      const options = ((env.decisions as Json[])[0].options as Json[]).map(o => `\`${o.id}\``).join(' or ');
      return `\`reason: ${env.reason}\` names the owner (\`lock_owner.pid\`). \`fix.next\` is \`${(env.fix as Json).next}\` because only the user can close `
        + `the other session: the agent relays \`user_message\` and offers ${options}. Calling \`gbrain_status\` again after the owner exits `
        + 'opens the brain in place and the full tool list arrives through `tools/list_changed`.';
    },
  },
];

function renderTranscript(t: Transcript, i: number): string {
  const doc = loadGolden(t.golden, t.transport);
  const env = body(doc);
  const fixNext = t.nextOf ? t.nextOf(doc) : String(((env.fix as Json | undefined)?.next)
    ?? ((((doc._meta as Json | undefined)?.gbrain_notices as Json[] | undefined)?.[0]?.fix as Json | undefined)?.next) ?? '');
  if (fixNext !== t.expectNext) {
    throw new Error(`transcript "${t.golden}": next is ${fixNext}, expected ${t.expectNext}. Update the narration with the contract change.`);
  }
  const parts = [
    `### ${i + 1}. ${t.title}`,
    '',
    t.setting,
    '',
    fence(t.transport === 'cli' ? 'bash' : 'text', t.call),
    '',
  ];
  if (t.transport === 'cli') {
    parts.push('stdout (`--json`):', '', fence('json', JSON.stringify(doc, null, 2)), '');
    if (doc.code === 'confirmation_required') {
      const human = renderConsentRefusal(doc as unknown as ConfirmationPayload, { json: false });
      parts.push('Without `--json`, the same refusal prints as an `[AGENT]` block:', '', fence('text', human.stdout ?? ''), '');
    }
  } else if (doc.isError || !Array.isArray(doc.content)) {
    parts.push('gbrain returns (`isError: true`, the envelope shown parsed):', '', fence('json', JSON.stringify(env, null, 2)), '');
  } else {
    const content = doc.content as { text: string }[];
    parts.push('gbrain returns these content blocks:', '');
    content.forEach((c, j) => parts.push(`\`content[${j}]\`:`, '', fence(j === 0 ? 'json' : 'text', c.text), ''));
  }
  parts.push(t.after(doc));
  return parts.join('\n');
}

function replaceRegion(text: string, region: string, inner: string): string {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `region` is a constant region name defined in this build script, never input
  const begin = new RegExp(`(<!-- BEGIN GENERATED ${region}[^>]*-->\\n)[\\s\\S]*?(<!-- END GENERATED ${region} -->)`);
  if (!begin.test(text)) throw new Error(`region ${region} not found`);
  return text.replace(begin, (_m, a: string, b: string) => `${a}${inner}${b}`);
}

export function quickContract(protocol: string): string {
  const m = QUICK_BEGIN.exec(protocol);
  const end = protocol.indexOf(QUICK_END);
  if (!m || end < 0) throw new Error('quick-contract region not found in AGENT_OPERATOR_v1.md');
  return protocol.slice(m.index + m[0].length, end);
}

/** Fresh text for both files, from the committed protocol page and goldens. */
export function renderAgentProtocolDocs(protocol: string, agents: string): { protocol: string; agents: string } {
  const transcripts = `${TRANSCRIPTS.map(renderTranscript).join('\n\n')}\n`;
  return {
    protocol: replaceRegion(protocol, TRANSCRIPT_REGION, transcripts),
    agents: replaceRegion(agents, 'agent-protocol:quick-contract', quickContract(protocol)),
  };
}

if (import.meta.main) {
  const current = { protocol: readFileSync(PROTOCOL_PATH, 'utf8'), agents: readFileSync(AGENTS_PATH, 'utf8') };
  const fresh = renderAgentProtocolDocs(current.protocol, current.agents);
  if (process.argv.includes('--check')) {
    const stale = [
      ...(fresh.protocol !== current.protocol ? ['docs/protocol/AGENT_OPERATOR_v1.md'] : []),
      ...(fresh.agents !== current.agents ? ['AGENTS.md'] : []),
    ];
    if (stale.length) {
      console.error(`${stale.join(', ')}: generated agent-protocol regions are stale. Run: bun run build:agent-protocol`);
      process.exit(1);
    }
    console.log('agent protocol docs: up to date');
  } else {
    writeFileSync(PROTOCOL_PATH, fresh.protocol);
    writeFileSync(AGENTS_PATH, fresh.agents);
    console.log('wrote docs/protocol/AGENT_OPERATOR_v1.md and AGENTS.md generated regions');
  }
}
