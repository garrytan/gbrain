/**
 * core_memory: always-loaded core memory health (docs/guides/core-memory.md).
 * Warns when core is over its brain-wide budget (owner git edits may push it
 * there), when a stored core/pressure setting is out of range (the readers
 * fall back to the default), when the delivery sensitivity policy withholds a
 * core page, when remote edits wait for review, when a compiled file carries
 * an old or no-longer-wanted core revision, and when core pages exist but no
 * session-start delivered them in the last week.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix } from '../check-fix.ts';
import {
  CORE_CONFIG_KEYS, CORE_DOCS, coreUsage, loadCoreBlock, pendingCoreNotices, readCoreSettings, validateCoreConfigValue,
} from '../../../core/core-memory.ts';
import { PRESSURE_CONFIG_KEYS, validatePressureConfigValue } from '../../../core/context/pressure.ts';
import { readHeartbeatTail } from '../../../core/context/hook-heartbeat.ts';
import { compiledCoreRevision, readCompiledCoreRecords } from '../../../core/context/compiled-core.ts';
import { existsSync, readFileSync } from 'node:fs';

const DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function coreMemoryCheck(engine: BrainEngine): Promise<Omit<Check, 'name'>> {
  const settings = await readCoreSettings(engine);
  const usage = await coreUsage(engine);
  const problems: string[] = [];
  const badConfig: string[] = [];
  for (const key of [...Object.values(CORE_CONFIG_KEYS), ...Object.values(PRESSURE_CONFIG_KEYS)]) {
    const value = await engine.getConfig(key).catch(() => null);
    if (value == null) continue;
    const problem = validateCoreConfigValue(key, value) ?? validatePressureConfigValue(key, value);
    if (problem) badConfig.push(`${key}=${value} is ignored (${problem})`);
  }
  // Compiled files carrying core (compile-context --include-core, codex-global): stale or leftover copies.
  const compiled: string[] = [];
  for (const rec of readCompiledCoreRecords()) {
    if (!existsSync(rec.path)) continue;
    const onDisk = compiledCoreRevision(readFileSync(rec.path, 'utf8'));
    if (!onDisk) continue;
    const current = (await loadCoreBlock(engine, { sessionSourceId: rec.source_id, excludePrivate: true, notices: [], settings })).revision;
    if (!settings.enabled || usage.pages.length === 0) compiled.push(`${rec.path} still carries core memory that is now ${settings.enabled ? 'empty' : 'disabled'}; remove it with ${rec.command} --remove-core`);
    else if (onDisk !== current) compiled.push(`${rec.path} carries an older core revision; refresh it with ${rec.command}`);
  }
  if (usage.pages.length === 0) {
    const issues = [...badConfig, ...compiled];
    return {
      status: issues.length ? 'warn' : 'ok',
      message: issues.length ? `No core pages. ${issues.join('; ')}.`
        : settings.enabled ? 'No core pages. Start one with gbrain core init, then fill it in with the user.'
          : 'Core memory is off (opt-in). If the user wants a profile loaded in every session: gbrain config set memory.core.enabled true, then gbrain core init.',
      details: { pages: 0, chars_used: 0, chars_limit: settings.maxChars, enabled: settings.enabled, bad_config: badConfig, compiled, docs: CORE_DOCS },
    };
  }
  const block = await loadCoreBlock(engine, { excludePrivate: true, settings });
  const withheld = block.omitted.filter(o => o.reason === 'withheld');
  const notices = await pendingCoreNotices(engine);
  const over = usage.chars - settings.maxChars;
  const largest = [...usage.pages].sort((a, b) => b.chars - a.chars)[0]!;
  if (over > 0) problems.push(`core is ${usage.chars} chars, over the ${settings.maxChars}-char budget by ${over}, so sessions get a truncated block; shorten the largest page (${largest.source_id}:${largest.slug}, ${largest.chars} chars) or raise memory.core.max_chars`);
  if (!settings.enabled) problems.push(`${usage.pages.length} page(s) are marked core but core memory is off, so no session loads them; turn it on with gbrain config set memory.core.enabled true, or unmark them with gbrain core remove`);
  problems.push(...badConfig, ...compiled);
  if (withheld.length) problems.push(`${withheld.length} core page(s) withheld from delivery for sensitive content: ${withheld.map(w => `${w.source_id}:${w.slug}`).join(', ')}`);
  if (notices.length) problems.push(`${notices.length} remote edit(s) to core pages await the user's review (gbrain core diff, then gbrain core ack)`);
  let delivered: boolean | null = null;
  if (settings.enabled) {
    try {
      const cutoff = Date.now() - DELIVERY_WINDOW_MS;
      const tail = await readHeartbeatTail(2000);
      delivered = tail.some(e => e.event === 'session-start' && typeof e.core_chars === 'number' && Date.parse(e.ts) >= cutoff);
      // Only hook-wired installs write heartbeats; with none at all, delivery is unknown rather than missing.
      if (!tail.some(e => e.event === 'session-start' && Date.parse(e.ts) >= cutoff)) delivered = null;
    } catch { delivered = null; }
    if (delivered === false) problems.push('session-start hooks ran this week but none delivered core; restart the gbrain MCP server so the hook gets the core-aware serve');
  }
  const details = {
    enabled: settings.enabled, pages: usage.pages.length, chars_used: usage.chars, chars_limit: settings.maxChars, remote_edit: settings.remoteEdit,
    revision: block.revision, withheld, pending_notices: notices.length, delivered_last_7d: delivered, bad_config: badConfig, compiled, docs: CORE_DOCS,
  };
  if (!problems.length) {
    return { status: 'ok', message: `Core memory ${settings.enabled ? 'on' : 'off'}: ${usage.pages.length} page(s), ${usage.chars}/${settings.maxChars} chars.`, details };
  }
  return {
    status: 'warn', details,
    message: `Core memory: ${problems.join('; ')}.`,
    fix: agentFix(['gbrain', 'core', 'status', '--json'], 'Shows core usage, withheld pages and pending remote edits, read-only.', 'core_memory'),
  };
}

async function runCoreMemory(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('core_memory');
  try {
    checks.push({ name: 'core_memory', ...await coreMemoryCheck(engine) });
  } catch (err) {
    checks.push({ name: 'core_memory', status: 'warn', message: `Core memory could not be checked: ${err instanceof Error ? err.message : String(err)}. Health is unknown.` });
  }
  return checks;
}

export const coreMemoryEntry: DoctorEntry = { name: 'core_memory', emits: ['core_memory'], run: runCoreMemory };
