/**
 * Redaction policy: which pattern classes of the canonical scanner
 * (`secret-scan.ts`) apply at the three enforcement points, all default OFF
 * so a brain with no `redaction.*` config behaves byte-identically:
 *
 *   projection  — chunks, embeddings and delivered evidence are cut from a
 *                 redacted copy (`credential-projection.ts`; the private-key
 *                 mechanism, generalised). Stored text is unchanged.
 *   egress      — provider-bound text at the AI gateway is redacted before
 *                 the request leaves (`ai/provider-redaction.ts`).
 *   on_write    — stored text is redacted at ingest for writes at an
 *                 untrusted trust tier (`redaction-on-write.ts`).
 *
 * This is the enforcement seam `docs/guardrails.md` reserves for its own RFC
 * (`docs/proposals/redaction-seam-identifier-families.md`). It is separate
 * from the observe-only guardrail seam: `guardrails.ts` never imports this
 * module and this module never imports it. Providers registered there keep
 * seeing the pre-redaction text at their five hooks.
 *
 * Keys are DB-plane (`gbrain config set`), read from the config snapshot that
 * every engine-aware startup loads (`config-snapshot.ts` publishes them
 * here), so the chunkers — synchronous, called from import, re-seal and
 * sync — read the policy without a config handle. The policy is per process,
 * as the gateway configuration is; a server that mounts several brains sees
 * the policy of the brain whose config was read last.
 */

export const REDACTION_CLASSES = ['credential', 'identifier', 'contact'] as const;
export type RedactionClass = typeof REDACTION_CLASSES[number];
export type RedactionOnWriteMode = 'off' | 'facts' | 'all';

export interface RedactionPolicy {
  /** Classes projected out of chunks, embeddings and evidence (private keys always are). */
  projection: readonly RedactionClass[];
  /** Classes redacted from provider-bound text at the gateway. */
  egress: readonly RedactionClass[];
  /** Redact-on-write scope for untrusted-tier writes. */
  onWrite: RedactionOnWriteMode;
  /** Classes the on-write splice applies. */
  onWriteClasses: readonly RedactionClass[];
}

export const REDACTION_CONFIG_KEYS = Object.freeze({
  projection: 'redaction.projection_classes',
  egress: 'redaction.egress_classes',
  onWrite: 'redaction.on_write',
  onWriteClasses: 'redaction.on_write_classes',
  /** Written by the projection re-seal: the classes the current chunks were cut with. */
  sealedProjection: 'redaction.sealed_projection_classes',
});

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = Object.freeze({
  projection: Object.freeze([]) as readonly RedactionClass[],
  egress: Object.freeze([]) as readonly RedactionClass[],
  onWrite: 'off',
  onWriteClasses: Object.freeze(['credential']) as readonly RedactionClass[],
});

const ON_WRITE_MODES: ReadonlySet<string> = new Set(['off', 'facts', 'all']);

/**
 * Parse a comma-separated class list. `''`, `none` and `off` are the empty
 * list; an unknown class name makes the whole value invalid (null) so a typo
 * never silently narrows a policy.
 */
export function parseRedactionClasses(raw: string | null | undefined): RedactionClass[] | null {
  const text = (raw ?? '').trim().toLowerCase();
  if (text === '' || text === 'none' || text === 'off') return [];
  const out: RedactionClass[] = [];
  for (const part of text.split(/[,+\s]+/)) {
    if (!part) continue;
    if (!(REDACTION_CLASSES as readonly string[]).includes(part)) return null;
    if (!out.includes(part as RedactionClass)) out.push(part as RedactionClass);
  }
  return out;
}

/** The refusal `gbrain config set` prints for a bad `redaction.*` value, or null when the value is valid. */
export function redactionConfigValueRefusal(key: string, value: string): string | null {
  if (key === REDACTION_CONFIG_KEYS.onWrite) {
    return ON_WRITE_MODES.has(value.trim().toLowerCase()) ? null : `${key} must be one of off, facts, all.`;
  }
  if (key === REDACTION_CONFIG_KEYS.projection || key === REDACTION_CONFIG_KEYS.egress || key === REDACTION_CONFIG_KEYS.onWriteClasses) {
    return parseRedactionClasses(value) === null
      ? `${key} must be a comma-separated list of ${REDACTION_CLASSES.join(', ')} (or none).`
      : null;
  }
  if (key === REDACTION_CONFIG_KEYS.sealedProjection) return `${key} is written by gbrain when it re-seals chunks; it is not set by hand.`;
  if (key.startsWith('redaction.')) return `Unknown redaction key ${key}. Keys: ${Object.values(REDACTION_CONFIG_KEYS).filter(k => k !== REDACTION_CONFIG_KEYS.sealedProjection).join(', ')}.`;
  return null;
}

/** Build a policy from config rows; an unreadable value falls back to that field's default (never widens). */
export function parseRedactionPolicy(rows: Record<string, string | null | undefined> | null | undefined): RedactionPolicy {
  if (!rows) return DEFAULT_REDACTION_POLICY;
  const classes = (key: string, fallback: readonly RedactionClass[]) => {
    const value = rows[key];
    if (value === undefined || value === null) return fallback;
    return parseRedactionClasses(value) ?? fallback;
  };
  const rawMode = (rows[REDACTION_CONFIG_KEYS.onWrite] ?? '').trim().toLowerCase();
  return Object.freeze({
    projection: Object.freeze(classes(REDACTION_CONFIG_KEYS.projection, DEFAULT_REDACTION_POLICY.projection)),
    egress: Object.freeze(classes(REDACTION_CONFIG_KEYS.egress, DEFAULT_REDACTION_POLICY.egress)),
    onWrite: (ON_WRITE_MODES.has(rawMode) ? rawMode : DEFAULT_REDACTION_POLICY.onWrite) as RedactionOnWriteMode,
    onWriteClasses: Object.freeze(classes(REDACTION_CONFIG_KEYS.onWriteClasses, DEFAULT_REDACTION_POLICY.onWriteClasses)),
  });
}

let current: RedactionPolicy = DEFAULT_REDACTION_POLICY;

/** The policy in effect for this process. */
export function redactionPolicy(): RedactionPolicy {
  return current;
}

/** True when any enforcement point is switched on; lets hot paths skip the scanner cheaply. */
export function redactionPolicyActive(policy: RedactionPolicy = current): boolean {
  return policy.projection.length > 0 || policy.egress.length > 0 || policy.onWrite !== 'off';
}

/** Called by the config snapshot loader: the rows of the brain whose config was just read. */
export function publishRedactionPolicy(rows: Record<string, string | null | undefined> | null | undefined): RedactionPolicy {
  current = parseRedactionPolicy(rows);
  return current;
}

/** Test seam: install a policy directly (null restores the default). */
export function __setRedactionPolicyForTests(policy: Partial<RedactionPolicy> | null): void {
  current = policy ? Object.freeze({ ...DEFAULT_REDACTION_POLICY, ...policy }) : DEFAULT_REDACTION_POLICY;
}
