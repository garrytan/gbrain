/**
 * v0.31 — `gbrain recall` + `gbrain forget` CLI.
 *
 * Recall is the user-facing query surface over the hot memory `facts` table.
 * Same underlying engine queries as the MCP `recall` op, two output shapes:
 *
 *   gbrain recall <entity>                  # listFactsByEntity
 *   gbrain recall --since "8 hours ago"     # listFactsSince
 *   gbrain recall --session <id>            # listFactsBySession
 *   gbrain recall --today                   # markdown render with kind icons
 *   gbrain recall --grep <text>             # text filter (case-insensitive)
 *   gbrain recall --supersessions [--since DUR]   # audit log
 *   gbrain recall --include-expired
 *   gbrain recall --as-context              # prompt-injection-ready markdown
 *   gbrain recall --json                    # structured output
 *
 *   gbrain forget <fact-id>                  # shorthand for expireFact
 */

import type { BrainEngine, FactRow, FactKind } from '../core/engine.ts';
import { effectiveConfidence } from '../core/facts/decay.ts';
import { resolveEntitySlug } from '../core/entities/resolve.ts';

const KIND_ICON: Record<FactKind, string> = {
  event: '📅',
  preference: '🎯',
  commitment: '🤝',
  belief: '💭',
  fact: '📌',
};

interface ParsedFlags {
  entity: string | null;
  since: Date | null;
  sessionId: string | null;
  grep: string | null;
  today: boolean;
  supersessions: boolean;
  includeExpired: boolean;
  asContext: boolean;
  json: boolean;
  source: string;
  limit: number;
}

function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = {
    entity: null,
    since: null,
    sessionId: null,
    grep: null,
    today: false,
    supersessions: false,
    includeExpired: false,
    asContext: false,
    json: false,
    source: 'default',
    limit: 50,
  };
  let positional = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--since') { out.since = parseSinceParam(args[++i] ?? ''); continue; }
    if (a === '--session' || a === '--session-id') { out.sessionId = args[++i] ?? null; continue; }
    if (a === '--grep') { out.grep = (args[++i] ?? '').toLowerCase(); continue; }
    if (a === '--today') { out.today = true; continue; }
    if (a === '--supersessions') { out.supersessions = true; continue; }
    if (a === '--include-expired') { out.includeExpired = true; continue; }
    if (a === '--as-context') { out.asContext = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--source') { out.source = args[++i] ?? 'default'; continue; }
    if (a === '--limit') { out.limit = parseInt(args[++i] ?? '50', 10) || 50; continue; }
    if (a.startsWith('--')) continue; // skip unknown flags silently
    if (!positional) positional = a;
  }
  if (positional) out.entity = positional;
  if (out.today && !out.since) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    out.since = start;
  }
  return out;
}

function parseSinceParam(raw: string): Date | null {
  if (!raw) return null;
  const iso = Date.parse(raw);
  if (Number.isFinite(iso)) return new Date(iso);
  const ago = raw.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)(?:\s+ago)?$/i);
  if (ago) {
    const n = parseInt(ago[1], 10);
    const unit = ago[2].toLowerCase();
    const ms =
      unit.startsWith('s') ? n * 1000 :
      unit.startsWith('m') ? n * 60 * 1000 :
      unit.startsWith('h') ? n * 60 * 60 * 1000 :
      n * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - ms);
  }
  return null;
}

export async function runRecall(engine: BrainEngine, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const sourceId = flags.source;

  let rows: FactRow[] = [];

  if (flags.supersessions) {
    rows = await engine.listSupersessions(sourceId, {
      since: flags.since ?? undefined,
      limit: flags.limit,
    });
  } else if (flags.entity) {
    const slug = (await resolveEntitySlug(engine, sourceId, flags.entity)) ?? flags.entity;
    rows = await engine.listFactsByEntity(sourceId, slug, {
      activeOnly: !flags.includeExpired,
      limit: flags.limit,
    });
  } else if (flags.sessionId) {
    rows = await engine.listFactsBySession(sourceId, flags.sessionId, {
      activeOnly: !flags.includeExpired,
      limit: flags.limit,
    });
  } else if (flags.since) {
    rows = await engine.listFactsSince(sourceId, flags.since, {
      activeOnly: !flags.includeExpired,
      limit: flags.limit,
    });
  } else {
    // No filter: recent across the source.
    rows = await engine.listFactsSince(sourceId, new Date(0), {
      activeOnly: !flags.includeExpired,
      limit: flags.limit,
    });
  }

  if (flags.grep) {
    const g = flags.grep;
    rows = rows.filter(r => r.fact.toLowerCase().includes(g));
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      facts: rows.map(r => ({
        id: r.id,
        fact: r.fact,
        kind: r.kind,
        entity_slug: r.entity_slug,
        visibility: r.visibility,
        // v0.31.2: notability surfaced in JSON output. CLI/PR2 will gain
        // a --notability filter on top of the same data.
        notability: r.notability,
        valid_from: r.valid_from.toISOString(),
        valid_until: r.valid_until?.toISOString() ?? null,
        expired_at: r.expired_at?.toISOString() ?? null,
        superseded_by: r.superseded_by,
        consolidated_at: r.consolidated_at?.toISOString() ?? null,
        consolidated_into: r.consolidated_into,
        source: r.source,
        source_session: r.source_session,
        confidence: r.confidence,
        effective_confidence: Number(effectiveConfidence(r).toFixed(3)),
        created_at: r.created_at.toISOString(),
      })),
      total: rows.length,
    }, null, 2) + '\n');
    return;
  }

  if (flags.asContext) {
    process.stdout.write(renderAsContext(rows) + '\n');
    return;
  }

  if (flags.supersessions) {
    process.stdout.write(renderSupersessions(rows));
    return;
  }

  if (flags.today) {
    process.stdout.write(renderToday(rows));
    return;
  }

  // Default: human-readable per-row output.
  process.stdout.write(renderHumanList(rows));
}

export async function runForget(engine: BrainEngine, args: string[]): Promise<void> {
  const idArg = args.find(a => /^\d+$/.test(a));
  if (!idArg) {
    process.stderr.write('Usage: gbrain forget <fact-id> [--reason <text>]\n');
    process.exit(1);
  }
  const id = parseInt(idArg, 10);
  // Optional --reason <text> passes through to the fence's "forgotten:
  // <reason>" context cell so the markdown carries the rationale.
  let reason: string | undefined = undefined;
  const idx = args.indexOf('--reason');
  if (idx >= 0 && idx + 1 < args.length) reason = args[idx + 1];

  // v0.32.2: route through forgetFactInFence so the forget rewrites the
  // page's `## Facts` fence and survives `gbrain rebuild`. Legacy /
  // thin-client rows fall back to the legacy DB-only expire path; the
  // helper handles the fallback internally.
  const { forgetFactInFence } = await import('../core/facts/forget.ts');
  const result = await forgetFactInFence(engine, id, { reason });

  if (!result.ok && result.path === 'not_found') {
    process.stderr.write(`No fact with id=${id}\n`);
    process.exit(1);
  }
  if (!result.ok && result.path === 'already_expired') {
    process.stderr.write(`Fact id=${id} is already expired\n`);
    process.exit(1);
  }
  const suffix = result.path === 'fence' ? '' : ' (legacy DB-only — will not survive gbrain rebuild)';
  process.stdout.write(`Forgot fact id=${id}${suffix}\n`);
}

function renderToday(rows: FactRow[]): string {
  if (rows.length === 0) {
    return '# Hot memory — today\n\nNo facts captured today yet.\n';
  }
  const date = new Date().toISOString().slice(0, 10);
  const byEntity = new Map<string, FactRow[]>();
  for (const r of rows) {
    const k = r.entity_slug ?? '(no entity)';
    const arr = byEntity.get(k) ?? [];
    arr.push(r);
    byEntity.set(k, arr);
  }
  const parts: string[] = [`# Hot memory — ${date}`, ''];
  for (const [entity, group] of byEntity) {
    parts.push(`## ${entity}`);
    for (const r of group) {
      const icon = KIND_ICON[r.kind];
      const ageStr = humanAge(r.valid_from);
      const conf = effectiveConfidence(r).toFixed(2);
      parts.push(`- ${icon} ${r.fact} (${r.kind}, ${ageStr}, conf ${conf})`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

function renderSupersessions(rows: FactRow[]): string {
  if (rows.length === 0) {
    return '# Supersessions — none\n\nNo facts have been auto-superseded.\n';
  }
  const parts = ['# Supersession audit log', ''];
  for (const r of rows) {
    const expired = r.expired_at?.toISOString() ?? '?';
    parts.push(`- id=${r.id} expired=${expired} superseded_by=${r.superseded_by ?? '?'}`);
    parts.push(`  was: ${r.fact}`);
  }
  return parts.join('\n') + '\n';
}

function renderHumanList(rows: FactRow[]): string {
  if (rows.length === 0) return 'No matching facts.\n';
  const parts: string[] = [];
  for (const r of rows) {
    const icon = KIND_ICON[r.kind];
    const tag = r.entity_slug ? `[${r.entity_slug}] ` : '';
    const conf = effectiveConfidence(r).toFixed(2);
    const expired = r.expired_at ? ' (expired)' : '';
    parts.push(`${icon} id=${r.id} ${tag}${r.fact} (${r.kind}, conf ${conf})${expired}`);
  }
  return parts.join('\n') + '\n';
}

function renderAsContext(rows: FactRow[]): string {
  if (rows.length === 0) return '<!-- gbrain hot memory: empty -->\n';
  const parts = ['<!-- gbrain hot memory (auto-injected) -->', ''];
  for (const r of rows) {
    const icon = KIND_ICON[r.kind];
    const tag = r.entity_slug ? ` [${r.entity_slug}]` : '';
    const ageStr = humanAge(r.valid_from);
    parts.push(`- ${icon}${tag} ${r.fact} (${r.kind}, ${ageStr})`);
  }
  return parts.join('\n');
}

function humanAge(when: Date, now: Date = new Date()): string {
  const ms = now.getTime() - when.getTime();
  if (ms < 0) return 'in future';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
