/**
 * Agent handoff page formats: thread, delegation (task) and agent pages.
 *
 * Every piece of handoff state is a markdown page with frontmatter, written
 * through the ordinary page write path, so the database row is an index over
 * the file and a re-import rebuilds it. This module is pure: it renders a
 * state object to page content and parses a stored page (frontmatter column +
 * body) back into the same state. `renderX(parseX(page))` reproduces the page
 * gbrain wrote, so a page survives export, git and re-import unchanged.
 *
 * Page type: handoff pages are `type: note` with a `handoff_type`
 * discriminator (thread, delegation, agent, routing), the convention gbrain's
 * own generated pages follow (`gbrain report` writes `type: note` with a
 * `report_type`). `note` is declared by every bundled schema pack, so the
 * pages never read as undeclared types and the catch-all retype leaves them
 * alone. A page whose `type` is the kind itself also reads as that kind.
 *
 * Machine fields (status, agents, leases, timestamps) live in frontmatter.
 * Prose (summary, decisions, open questions, turns, instructions, result,
 * log) lives in body sections, and entity references render as `[[slug]]` so
 * the brain's own link extraction builds the graph edges.
 */
import { stringifyDataFrontmatter } from '../data-frontmatter.ts';

export const THREAD_PREFIX = 'threads/';
export const DELEGATION_PREFIX = 'delegations/';
export const AGENT_PREFIX = 'agents/';
export const ROUTING_SLUG = 'routing';

export const HANDOFF_KINDS = ['thread', 'delegation', 'agent', 'routing'] as const;
export type HandoffKind = typeof HANDOFF_KINDS[number];
/** The page type every handoff page is written with; `handoff_type` names the kind. */
export const HANDOFF_PAGE_TYPE = 'note';

/** The handoff kind of a stored page: its `handoff_type`, or a page type that is the kind itself; else null. */
export function handoffKindOf(page: { type?: string | null; frontmatter?: Record<string, unknown> | null }): HandoffKind | null {
  const declared = page.frontmatter?.handoff_type;
  if (typeof declared === 'string') return (HANDOFF_KINDS as readonly string[]).includes(declared) ? declared as HandoffKind : null;
  return (HANDOFF_KINDS as readonly string[]).includes(page.type ?? '') ? page.type as HandoffKind : null;
}

export const THREAD_STATUSES = ['active', 'parked', 'done'] as const;
export type ThreadStatus = typeof THREAD_STATUSES[number];
export const TASK_STATUSES = ['open', 'claimed', 'done', 'failed', 'released'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];
export const TURN_KINDS = ['turn', 'checkpoint', 'summary', 'delegate', 'fan_out', 'complete', 'release', 'pick'] as const;
export type TurnKind = typeof TURN_KINDS[number];

/**
 * Frontmatter keys gbrain owns (identity columns, trust tier, the first-write
 * provenance stamps the page write path keeps); a handoff render never writes
 * them back, so they never count as handoff state.
 */
const SYSTEM_KEYS = new Set(['type', 'title', 'handoff_type', 'trust_tier', 'source_kind', 'source_uri', 'ingested_via', 'ingested_at']);

export interface ThreadTurn {
  n: number;
  agent: string;
  model: string | null;
  at: string;
  kind: TurnKind;
  text: string;
  decisions: string[];
  openQuestions: string[];
  entities: string[];
  nextStep: string | null;
}

export interface ThreadState {
  title: string;
  agent: string;
  model: string | null;
  status: ThreadStatus;
  /** Handoff chain, oldest first; consecutive repeats collapse. */
  agents: string[];
  createdAt: string;
  updatedAt: string;
  summary: string;
  nextStep: string;
  decisions: string[];
  openQuestions: string[];
  entities: string[];
  turns: ThreadTurn[];
  /** Frontmatter keys this module does not own, kept verbatim. */
  extra: Record<string, unknown>;
}

export interface TaskLogEntry { at: string; agent: string; event: string; detail: string | null }

export interface TaskState {
  title: string;
  fromAgent: string;
  toAgent: string | null;
  toModel: string | null;
  thread: string | null;
  tags: string[];
  taskType: string | null;
  priority: TaskPriority;
  due: string | null;
  autoOk: boolean;
  status: TaskStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  leaseUntil: string | null;
  attempts: number;
  completedAt: string | null;
  fanOut: string | null;
  picked: boolean | null;
  routed: string | null;
  createdAt: string;
  updatedAt: string;
  instructions: string;
  context: string[];
  result: string;
  files: string[];
  log: TaskLogEntry[];
  extra: Record<string, unknown>;
}

export interface AgentState {
  name: string;
  model: string | null;
  capabilities: string[];
  registeredAt: string;
  lastHeartbeat: string | null;
  extra: Record<string, unknown>;
}

/**
 * The stored fields a parse reads: the frontmatter column, the body (compiled
 * truth plus timeline) and, when loaded, the page tags. gbrain moves a
 * frontmatter `tags:` list into page tags, so task tags are page tags.
 */
export interface StoredPageFields {
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  tags?: string[] | null;
}

// ── shared text helpers ────────────────────────────────────────────────────

const STRUCTURED_LINE = /^- (Decision|Open question|Entities|Next step|Thread|File):/;

/**
 * A free-text line that the parser would read as structure (a heading, a
 * labelled bullet) or that starts with the escape character gets a leading
 * backslash; `unescapeLine` removes exactly one. Round-trips any text.
 */
function escapeLine(line: string): string {
  return /^(#|\\)/.test(line) || STRUCTURED_LINE.test(line) ? `\\${line}` : line;
}
function unescapeLine(line: string): string {
  return line.startsWith('\\') ? line.slice(1) : line;
}
function escapeBlock(text: string): string {
  return text.split('\n').map(escapeLine).join('\n');
}
function unescapeBlock(text: string): string {
  return text.split('\n').map(unescapeLine).join('\n');
}

/** Collapse whitespace (newlines included) so a value fits one line. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Normalize multi-line prose: unify line endings, trim trailing space and surrounding blank lines. */
export function normalizeProse(value: string): string {
  return value.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/^\n+|\n+$/g, '');
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}
function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter((v): v is string => v !== null && v.length > 0);
}
function extraKeys(fm: Record<string, unknown>, owned: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) if (!owned.has(k) && !SYSTEM_KEYS.has(k)) out[k] = v;
  return out;
}

/** Split a body into its H2 sections (`## Name` → text), ignoring escaped lines. */
function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => { if (current !== null) out.set(current, buf.join('\n').replace(/^\n+|\n+$/g, '')); };
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^## (.+)$/.exec(line);
    if (m) { flush(); current = m[1]!.trim(); buf = []; continue; }
    if (current !== null) buf.push(line);
  }
  flush();
  return out;
}

function bullets(text: string | undefined): string[] {
  if (!text) return [];
  return text.split('\n').filter(l => l.startsWith('- ')).map(l => unescapeLine(l.slice(2)).trim()).filter(Boolean);
}

const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
function wikilinks(text: string): string[] {
  return [...text.matchAll(WIKILINK)].map(m => m[1]!.trim()).filter(Boolean);
}

function section(name: string, text: string): string {
  return text ? `## ${name}\n\n${text}\n\n` : '';
}
function bulletList(items: string[], wrap: (s: string) => string = escapeLine): string {
  return items.map(i => `- ${wrap(i)}`).join('\n');
}

function withFrontmatter(body: string, fm: Record<string, unknown>): string {
  return stringifyDataFrontmatter(body.replace(/\n+$/, '\n'), fm);
}

// ── thread pages ───────────────────────────────────────────────────────────

const THREAD_OWNED = new Set(['agent', 'model', 'status', 'agents', 'created_at', 'updated_at']);
const TURN_HEADER = /^### Turn (\d+) · ([^\s·()]+)(?: \(([^()]*)\))? · (\S+)(?: · ([a-z_]+))?$/;

export function renderThread(t: ThreadState): string {
  const fm: Record<string, unknown> = {
    type: HANDOFF_PAGE_TYPE,
    handoff_type: 'thread',
    title: t.title,
    agent: t.agent,
    ...(t.model ? { model: t.model } : {}),
    status: t.status,
    agents: t.agents,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    ...t.extra,
  };
  const turns = t.turns.map(renderTurn).join('\n\n');
  const body = `# ${oneLine(t.title)}\n\n`
    + section('Summary', escapeBlock(t.summary))
    + section('Next step', escapeLine(oneLine(t.nextStep)))
    + section('Decisions', bulletList(t.decisions))
    + section('Open questions', bulletList(t.openQuestions))
    + section('Linked pages', bulletList(t.entities, s => `[[${s}]]`))
    + (turns ? `## Turns\n\n${turns}\n` : '');
  return withFrontmatter(body, fm);
}

function renderTurn(turn: ThreadTurn): string {
  const head = `### Turn ${turn.n} · ${turn.agent}${turn.model ? ` (${turn.model})` : ''} · ${turn.at}${turn.kind === 'turn' ? '' : ` · ${turn.kind}`}`;
  const lines: string[] = [];
  if (turn.text) lines.push(escapeBlock(turn.text), '');
  for (const d of turn.decisions) lines.push(`- Decision: ${oneLine(d)}`);
  for (const q of turn.openQuestions) lines.push(`- Open question: ${oneLine(q)}`);
  if (turn.entities.length) lines.push(`- Entities: ${turn.entities.map(e => `[[${e}]]`).join(', ')}`);
  if (turn.nextStep) lines.push(`- Next step: ${oneLine(turn.nextStep)}`);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? `${head}\n\n${lines.join('\n')}` : head;
}

export function parseThread(page: StoredPageFields): ThreadState {
  const fm = page.frontmatter ?? {};
  const secs = sections(page.body);
  const status = str(fm.status);
  return {
    title: page.title,
    agent: str(fm.agent) ?? '',
    model: str(fm.model),
    status: (THREAD_STATUSES as readonly string[]).includes(status ?? '') ? status as ThreadStatus : 'active',
    agents: strList(fm.agents),
    createdAt: str(fm.created_at) ?? '',
    updatedAt: str(fm.updated_at) ?? '',
    summary: unescapeBlock(secs.get('Summary') ?? ''),
    nextStep: unescapeLine(secs.get('Next step') ?? ''),
    decisions: bullets(secs.get('Decisions')),
    openQuestions: bullets(secs.get('Open questions')),
    entities: (secs.get('Linked pages') ?? '').split('\n').flatMap(l => l.startsWith('- ') ? wikilinks(l) : []),
    turns: parseTurns(secs.get('Turns') ?? ''),
    extra: extraKeys(fm, THREAD_OWNED),
  };
}

function parseTurns(text: string): ThreadTurn[] {
  const turns: ThreadTurn[] = [];
  let cur: ThreadTurn | null = null;
  let prose: string[] = [];
  const flush = () => {
    if (!cur) return;
    cur.text = unescapeBlock(prose.join('\n').replace(/^\n+|\n+$/g, ''));
    turns.push(cur);
  };
  for (const line of text.split('\n')) {
    const m = TURN_HEADER.exec(line);
    if (m) {
      flush();
      const kind = (TURN_KINDS as readonly string[]).includes(m[5] ?? '') ? m[5] as TurnKind : 'turn';
      cur = { n: Number(m[1]), agent: m[2]!, model: m[3] ?? null, at: m[4]!, kind, text: '', decisions: [], openQuestions: [], entities: [], nextStep: null };
      prose = [];
      continue;
    }
    if (!cur) continue;
    const s = /^- (Decision|Open question|Entities|Next step): (.*)$/.exec(line);
    if (s) {
      const value = s[2]!.trim();
      if (s[1] === 'Decision') cur.decisions.push(value);
      else if (s[1] === 'Open question') cur.openQuestions.push(value);
      else if (s[1] === 'Entities') cur.entities.push(...wikilinks(value));
      else cur.nextStep = value;
      continue;
    }
    prose.push(line);
  }
  flush();
  return turns;
}

// ── delegation (task) pages ────────────────────────────────────────────────

const TASK_OWNED = new Set(['from_agent', 'to_agent', 'to_model', 'thread', 'tags', 'task_type', 'priority', 'due', 'auto_ok', 'status',
  'claimed_by', 'claimed_at', 'lease_until', 'attempts', 'completed_at', 'fan_out', 'picked', 'routed', 'created_at', 'updated_at']);
const LOG_LINE = /^- (\S+) · ([^\s·]+) · ([a-z_]+)(?:: (.*))?$/;

export function renderTask(t: TaskState): string {
  const fm: Record<string, unknown> = {
    type: HANDOFF_PAGE_TYPE,
    handoff_type: 'delegation',
    title: t.title,
    from_agent: t.fromAgent,
    ...(t.toAgent ? { to_agent: t.toAgent } : {}),
    ...(t.toModel ? { to_model: t.toModel } : {}),
    ...(t.thread ? { thread: t.thread } : {}),
    ...(t.tags.length ? { tags: t.tags } : {}),
    ...(t.taskType ? { task_type: t.taskType } : {}),
    priority: t.priority,
    ...(t.due ? { due: t.due } : {}),
    auto_ok: t.autoOk,
    status: t.status,
    ...(t.claimedBy ? { claimed_by: t.claimedBy } : {}),
    ...(t.claimedAt ? { claimed_at: t.claimedAt } : {}),
    ...(t.leaseUntil ? { lease_until: t.leaseUntil } : {}),
    attempts: t.attempts,
    ...(t.completedAt ? { completed_at: t.completedAt } : {}),
    ...(t.fanOut ? { fan_out: t.fanOut } : {}),
    ...(t.picked !== null ? { picked: t.picked } : {}),
    ...(t.routed ? { routed: t.routed } : {}),
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    ...t.extra,
  };
  const context = [...(t.thread ? [`Thread: [[${t.thread}]]`] : []), ...t.context.map(c => `[[${c}]]`)];
  const log = t.log.map(e => `- ${e.at} · ${e.agent} · ${e.event}${e.detail ? `: ${oneLine(e.detail)}` : ''}`).join('\n');
  const body = `# ${oneLine(t.title)}\n\n`
    + section('Instructions', escapeBlock(t.instructions))
    + section('Context', context.map(c => `- ${c}`).join('\n'))
    + section('Result', escapeBlock(t.result))
    + section('Files', bulletList(t.files.map(oneLine)))
    + section('Log', log);
  return withFrontmatter(body, fm);
}

export function parseTask(page: StoredPageFields): TaskState {
  const fm = page.frontmatter ?? {};
  const secs = sections(page.body);
  const status = str(fm.status);
  const priority = str(fm.priority);
  const attempts = Number(fm.attempts);
  const contextLines = (secs.get('Context') ?? '').split('\n').filter(l => l.startsWith('- ') && !l.startsWith('- Thread:'));
  return {
    title: page.title,
    fromAgent: str(fm.from_agent) ?? '',
    toAgent: str(fm.to_agent),
    toModel: str(fm.to_model),
    thread: str(fm.thread),
    tags: page.tags ?? strList(fm.tags),
    taskType: str(fm.task_type),
    priority: (TASK_PRIORITIES as readonly string[]).includes(priority ?? '') ? priority as TaskPriority : 'normal',
    due: str(fm.due),
    autoOk: fm.auto_ok === true,
    status: (TASK_STATUSES as readonly string[]).includes(status ?? '') ? status as TaskStatus : 'open',
    claimedBy: str(fm.claimed_by),
    claimedAt: str(fm.claimed_at),
    leaseUntil: str(fm.lease_until),
    attempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
    completedAt: str(fm.completed_at),
    fanOut: str(fm.fan_out),
    picked: typeof fm.picked === 'boolean' ? fm.picked : null,
    routed: str(fm.routed),
    createdAt: str(fm.created_at) ?? '',
    updatedAt: str(fm.updated_at) ?? '',
    instructions: unescapeBlock(secs.get('Instructions') ?? ''),
    context: contextLines.flatMap(wikilinks),
    result: unescapeBlock(secs.get('Result') ?? ''),
    files: bullets(secs.get('Files')),
    log: (secs.get('Log') ?? '').split('\n').flatMap(l => {
      const m = LOG_LINE.exec(l);
      return m ? [{ at: m[1]!, agent: m[2]!, event: m[3]!, detail: m[4] ?? null }] : [];
    }),
    extra: extraKeys(fm, TASK_OWNED),
  };
}

// ── agent pages ────────────────────────────────────────────────────────────

const AGENT_OWNED = new Set(['model', 'capabilities', 'registered_at', 'last_heartbeat']);

export function renderAgent(a: AgentState): string {
  const fm: Record<string, unknown> = {
    type: HANDOFF_PAGE_TYPE,
    handoff_type: 'agent',
    title: a.name,
    ...(a.model ? { model: a.model } : {}),
    ...(a.capabilities.length ? { capabilities: a.capabilities } : {}),
    registered_at: a.registeredAt,
    ...(a.lastHeartbeat ? { last_heartbeat: a.lastHeartbeat } : {}),
    ...a.extra,
  };
  const body = `# ${a.name}\n\nAn agent that takes delegated work from this brain. Its inbox is the delegation pages addressed to it${a.model ? ` or to the model ${oneLine(a.model)}` : ''}.\n`;
  return withFrontmatter(body, fm);
}

export function parseAgent(name: string, page: StoredPageFields): AgentState {
  const fm = page.frontmatter ?? {};
  return {
    name,
    model: str(fm.model),
    capabilities: strList(fm.capabilities),
    registeredAt: str(fm.registered_at) ?? '',
    lastHeartbeat: str(fm.last_heartbeat),
    extra: extraKeys(fm, AGENT_OWNED),
  };
}
