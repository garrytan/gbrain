/**
 * #6780: runtime readers name config keys `gbrain config set` refuses.
 *
 * Protects: every key gbrain reads with getConfig() is either a registered
 * knob (KNOWN_CONFIG_KEYS / KNOWN_CONFIG_KEY_PREFIXES, so `config set`
 * accepts it without --force) or recorded as internal state with a reason.
 * Regression it catches: a new reader of a new key, or a key constant moved
 * without its registration (doctor.entry_budget_ms, the orphan full-scan cap
 * and the per-page embedding spend cap all shipped unregistered).
 * Existing coverage: per-feature tests pin their own keys; nothing scans
 * readers, so an unregistered reader was invisible until a user hit it.
 * Seam: none (a source scan plus the exported key constants).
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { KNOWN_CONFIG_KEYS, KNOWN_CONFIG_KEY_PREFIXES } from '../src/core/config.ts';
import { ENTRY_BUDGET_KEY } from '../src/commands/doctor/budget.ts';
import { ORPHAN_FULL_SCAN_KEY } from '../src/commands/doctor/checks/orphan-estimate.ts';
import { PAGE_EMBED_CAP_KEY } from '../src/core/page-embedding-budget.ts';
import { ENTITY_IDENTITY_UNION_CONFIG_KEY } from '../src/core/entity-identity.ts';
import { scanConfigReads, type ConfigRead } from './helpers/config-reader-scan.ts';
import {
  ENUMERATED_TEMPLATE_PREFIXES,
  INTERNAL_CONFIG_STATE,
  UNRESOLVED_CONFIG_READS,
} from './helpers/config-reader-registry.ts';

const ROOT = join(import.meta.dir, '..');
const REMEDY = 'Register a user-facing knob in src/core/config-runtime-keys.ts (or its home list in src/core/config.ts KNOWN_CONFIG_KEYS / KNOWN_CONFIG_KEY_PREFIXES); '
  + 'record state gbrain writes itself in INTERNAL_CONFIG_STATE in test/helpers/config-reader-registry.ts with a reason.';

const isRegistered = (key: string) => KNOWN_CONFIG_KEYS.includes(key) || KNOWN_CONFIG_KEY_PREFIXES.some((p) => key.startsWith(p));
const internalKey = (key: string) => INTERNAL_CONFIG_STATE.find((s) => (s.prefix ? key.startsWith(s.key) : key === s.key));
const where = (r: ConfigRead) => `${r.file}:${r.line} getConfig(${r.expr})`;

describe('#6780 runtime config keys are registered', () => {
  test.each([
    ['doctor.entry_budget_ms', ENTRY_BUDGET_KEY],
    ['doctor.orphan_ratio.full_scan_max_pages', ORPHAN_FULL_SCAN_KEY],
    ['embed.max_usd_per_page', PAGE_EMBED_CAP_KEY],
    ['entity_identity.union', ENTITY_IDENTITY_UNION_CONFIG_KEY],
  ])('%s (the reader constant) is in KNOWN_CONFIG_KEYS', (name, constant) => {
    expect(constant).toBe(name);
    expect(KNOWN_CONFIG_KEYS).toContain(constant);
  });

  test.each([
    'facts.absorb_warn_threshold',
    'think.trajectory_enabled',
    'embedding_image_ocr_max_images',
    'embedding_image_ocr_max_usd',
    'agent.search_snippet_chars',
    'skillopt.allowed_skills',
    'skillopt.capture_enabled',
    'writer.lint_on_put_page',
  ])('%s is in KNOWN_CONFIG_KEYS', (key) => {
    expect(KNOWN_CONFIG_KEYS).toContain(key);
  });
});

describe('#6780 guard: every getConfig() key under src/ is registered or recorded', () => {
  const reads = scanConfigReads(ROOT);
  const literal = reads.filter((r) => r.target.kind === 'keys');
  const templates = reads.filter((r) => r.target.kind === 'template');
  const unresolved = reads.filter((r) => r.target.kind === 'unresolved');
  console.log(`[config-reader guard] ${reads.length} getConfig reads: ${literal.length} resolved keys, ${templates.length} templates, ${unresolved.length} unresolved`);

  test('the scan sees the reader population (not a vacuous pass)', () => {
    expect(reads.length).toBeGreaterThan(400);
    expect(literal.some((r) => r.file === 'src/core/page-embedding-budget.ts' && r.target.kind === 'keys' && r.target.keys.includes('embed.max_usd_per_page'))).toBe(true);
  });

  test('resolved keys are registered or internal state', () => {
    const bad: string[] = [];
    for (const r of literal) {
      if (r.target.kind !== 'keys') continue;
      for (const key of r.target.keys) {
        if (!isRegistered(key) && !internalKey(key)) bad.push(`${where(r)} reads "${key}", which gbrain config set refuses.`);
      }
    }
    expect(bad, `${bad.length} unregistered config reads:\n${bad.join('\n')}\n${REMEDY}`).toEqual([]);
  });

  test('template keys match a registered prefix, an enumerated prefix or an internal prefix', () => {
    const bad = templates.filter((r) => {
      if (r.target.kind !== 'template') return false;
      const prefix = r.target.prefix;
      return !KNOWN_CONFIG_KEY_PREFIXES.some((p) => prefix.startsWith(p))
        && !ENUMERATED_TEMPLATE_PREFIXES.some((e) => e.prefix === prefix)
        && !INTERNAL_CONFIG_STATE.some((s) => s.prefix && prefix.startsWith(s.key));
    }).map((r) => `${where(r)} builds keys under "${(r.target as { prefix: string }).prefix}".`);
    expect(bad, `${bad.join('\n')}\n${REMEDY}`).toEqual([]);
  });

  test('enumerated template prefixes still have registered leaves', () => {
    for (const e of ENUMERATED_TEMPLATE_PREFIXES) {
      expect(KNOWN_CONFIG_KEYS.some((k) => k.startsWith(e.prefix)), `no registered key under ${e.prefix}`).toBe(true);
    }
  });

  test('unresolved keys are allowlisted, and parameter entries are still parameters', () => {
    const remaining = [...UNRESOLVED_CONFIG_READS];
    const bad: string[] = [];
    for (const r of unresolved) {
      if (r.target.kind !== 'unresolved') continue;
      const via = r.target.via;
      const i = remaining.findIndex((u) => u.file === r.file && u.expr === r.expr && (u.why === 'parameter') === (via === 'parameter'));
      if (i === -1) {
        bad.push(`${where(r)}: the key is not statically resolvable (${via}). Pass a string literal or a const (same file or a named import), `
          + 'or add { file, expr, why } to UNRESOLVED_CONFIG_READS in test/helpers/config-reader-registry.ts.');
        continue;
      }
      remaining.splice(i, 1);
    }
    expect(bad, bad.join('\n')).toEqual([]);
    expect(remaining.map((u) => `stale UNRESOLVED_CONFIG_READS entry (no matching read): ${u.file} getConfig(${u.expr}); remove it`)).toEqual([]);
  });

  test('every internal-state entry is still read and is not also registered', () => {
    const stale: string[] = [];
    for (const s of INTERNAL_CONFIG_STATE) {
      const read = reads.some((r) => (r.target.kind === 'keys' && r.target.keys.some((k) => (s.prefix ? k.startsWith(s.key) : k === s.key)))
        || (r.target.kind === 'template' && s.prefix && r.target.prefix.startsWith(s.key)));
      if (!read) stale.push(`${s.key}: no getConfig reader left; remove it from INTERNAL_CONFIG_STATE`);
      if (!s.prefix && isRegistered(s.key)) stale.push(`${s.key}: registered as a knob and listed as internal state; keep one`);
    }
    expect(stale).toEqual([]);
  });
});
