#!/usr/bin/env python3
"""Debug-only instrumentation for the #6278 stall reproduction. Never commit its output.

Applies, to the gbrain checkout given as argv[1] (default: the current one), a
SIGUSR2 dump of every preparation in flight: which `prepareManagedSyncMutation`
step each request is in, for how long, plus the consumer's `status()`
(phase observation with first_conn_ms / conn_wait_ms, preparations). The
repro script sends the signal with `--stall-signal SIGUSR2` once a stall is
detected, and the dump lands in `pass-<n>.stderr` as `[stall-debug] ...` lines.

It edits three files in place (idempotent: a second run is a no-op) and adds
`src/core/persistence/stall-debug.ts`. Undo with `git checkout -- src` in that checkout.
Anchors that do not exist in that checkout are reported and skipped.
"""
import os
import re
import sys

repo = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
P = lambda *parts: os.path.join(repo, 'src', 'core', 'persistence', *parts)

MODULE = '''/** Debug-only (#6278 Phase 0): SIGUSR2 dumps every preparation in flight with its current step and age. Installed by scripts/bench/stall-debug-instrument.py. */
const inflight = new Map<string, { step: string; since: number; started: number; steps: string[] }>();
const extras = new Map<string, () => unknown>();
let installed = false;
function install(): void {
  if (installed) return;
  installed = true;
  process.on('SIGUSR2', () => {
    const now = Date.now();
    const rows = [...inflight.entries()].map(([id, s]) => ({ id, step: s.step, step_age_ms: now - s.since, total_age_ms: now - s.started, steps: s.steps.slice(-20) }));
    const extra: Record<string, unknown> = {};
    for (const [name, fn] of extras) { try { extra[name] = fn(); } catch (error) { extra[name] = String(error); } }
    process.stderr.write(`[stall-debug] ${JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, inflight: rows, ...extra, memory: process.memoryUsage() })}\\n`);
  });
}
export function stallMark(id: string, step: string): void {
  install();
  const now = Date.now();
  const s = inflight.get(id);
  if (s) { s.step = step; s.since = now; s.steps.push(`${step}@${now - s.started}`); }
  else inflight.set(id, { step, since: now, started: now, steps: [`${step}@0`] });
}
export function stallDone(id: string): void { inflight.delete(id); }
export function stallRegister(name: string, fn: () => unknown): void { install(); extras.set(name, fn); }
'''

def edit(path, fn):
    with open(path) as f: text = f.read()
    new = fn(text)
    if new != text:
        with open(path, 'w') as f: f.write(new)
    return new != text

def ensure_import(text, line):
    if line in text: return text
    m = re.search(r"^import .*?;\n(?!import)", text, re.S | re.M)
    at = m.end() if m else 0
    return text[:at] + line + '\n' + text[at:]

report = []

# 1. the module
mod = P('stall-debug.ts')
if not os.path.exists(mod):
    with open(mod, 'w') as f: f.write(MODULE)
    report.append('added stall-debug.ts')

# 2. service.ts: wrap preparePersistedMutation; register the consumer status
def service(text):
    if 'preparePersistedMutationInner' in text: return text
    text = ensure_import(text, "import { stallDone, stallMark, stallRegister } from './stall-debug.ts';")
    text = text.replace('export async function preparePersistedMutation(e: BrainEngine, row: WriteRequest, cfg: GBrainConfig, signal?: AbortSignal) {',
        'export async function preparePersistedMutation(e: BrainEngine, row: WriteRequest, cfg: GBrainConfig, signal?: AbortSignal) {\n'
        "  stallMark(row.request_id, `dispatch:${row.operation}:${row.intent?.kind ?? ''}`);\n"
        '  try { return await preparePersistedMutationInner(e, row, cfg, signal); } finally { stallDone(row.request_id); }\n'
        '}\n'
        'async function preparePersistedMutationInner(e: BrainEngine, row: WriteRequest, cfg: GBrainConfig, signal?: AbortSignal) {', 1)
    m = re.search(r"(  const consumer = new PersistenceConsumer\(engine, config, preparePersistedMutation,.*?\);\n)", text, re.S)
    if m:
        text = text[:m.end()] + "  stallRegister('consumer', () => consumer.status());\n" + text[m.end():]
    else: report.append('service.ts: consumer registration anchor missing')
    return text
report.append(f"service.ts edited={edit(P('service.ts'), service)}")

# 3. sync-prepare.ts: a mark before each major await of prepareManagedSyncMutation
ANCHORS = [
    ('  await assertManagedSyncActive(engine);', 'sync_active'),
    ('  await validateSyncAuthority(engine, p.syncAuthority, row.slug);', 'authority'),
    ('  const binding = await getWorktreeBinding(engine, row.source_id);', 'binding'),
    ("  const [configuredSource] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [row.source_id]);", 'source_path'),
    ("  if (p.kind !== 'managed_sync_checkpoint') await assertKnowledgePublicationAllowed(engine, row,", 'knowledge_guard'),
    ("    originContext = { root, gitRoot: realpathSync(syncGit(root, ['rev-parse', '--show-toplevel']).trim()), target: p.target, slugMode: p.slugMode };", 'git_rev_parse'),
    ("    await assertSyncPageOrigin(engine, row.source_id, p.sourcePath, originPageId, p.kind === 'managed_sync_delete', originScope);", 'page_origin'),
    ('  const snapshot = await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true });', 'snapshot'),
    ('  const activePack = p.processingOptions?.noSchemaPack ? undefined', 'active_pack'),
    ('  const { screen, parsedInput, newerWorkingTree } = await settledSyncScreen(engine,', 'screen'),
    ('  const result = await importFromContent(engine, renamed?.slug ?? row.slug, importContent, { ...importOptions,', 'import_prepare'),
    ('  const project = await prepareCanonicalProjections(engine, ready.parsedPage, row.slug, row.source_id, base,', 'projections'),
    ('  const preparedImport: PreparedMutation = {', 'prepared'),
]
def sync_prepare(text):
    if "from './stall-debug.ts'" in text: return text
    text = ensure_import(text, "import { stallMark } from './stall-debug.ts';")
    for anchor, step in ANCHORS:
        lines = text.split('\n')
        hits = [i for i, l in enumerate(lines) if l.startswith(anchor)]
        if len(hits) != 1: report.append(f'sync-prepare.ts: anchor {step} matched {len(hits)}x, skipped'); continue
        indent = re.match(r'\s*', lines[hits[0]]).group(0)
        lines.insert(hits[0], f"{indent}stallMark(row.request_id, '{step}');")
        text = '\n'.join(lines)
    return text
report.append(f"sync-prepare.ts edited={edit(P('sync-prepare.ts'), sync_prepare)}")

# 4. prepared-maintenance.ts and page-prepare.ts: entry marks only (the dispatch wrapper already covers start/end)
def maintenance(text):
    if "from './stall-debug.ts'" in text: return text
    text = ensure_import(text, "import { stallMark } from './stall-debug.ts';")
    lines = text.split('\n')
    hits = [i for i, l in enumerate(lines) if l.startswith('export async function prepareMaintenanceMutation(')]
    if len(hits) == 1: lines.insert(hits[0] + 1, "  stallMark(row.request_id, `maintenance:${String(row.intent?.kind ?? '')}`);")
    else: report.append('prepared-maintenance.ts: entry anchor missing')
    return '\n'.join(lines)
if os.path.exists(P('prepared-maintenance.ts')): report.append(f"prepared-maintenance.ts edited={edit(P('prepared-maintenance.ts'), maintenance)}")

print('\n'.join(report))
