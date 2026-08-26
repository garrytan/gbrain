import { readFileSync } from 'node:fs';

export type OutboundScanResult =
  | { ok: true }
  | { ok: false; ruleId: string; offset: number };

// Shapes are deliberately tight. Measured against the real vault corpus
// (12,688 files): the loose `sk-[A-Za-z0-9_-]{12,}` form matched ordinary prose
// — any word ending in "sk" followed by a hyphen ("task-goal-…", "risk-user-…")
// produced 288 false hits. Bare `sk-` now requires an unbroken 32+ alnum run
// (real OpenAI keys have no interior hyphen); prefixed forms keep their marker.
const CREDENTIAL_PREFIX = /(?<![A-Za-z0-9])(?:sk-(?:ant-|or-v1-|proj-|svcacct-)[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{20,}|hf_[0-9A-Za-z_-]{20,}|github_pat_[0-9A-Za-z_]{20,}|gh[pousr]_[0-9A-Za-z]{20,}|xox[baprs]-[0-9]{10,}-[0-9A-Za-z-]{10,}|AKIA[0-9A-Z]{16})/g;
const AUTHORIZATION_HEADER = /Authorization\s*:\s*(?:Bearer|Basic)\s+(?![<$'"`])[^\s]+/gi;
// Compact, high-signal, near-zero false positives: a JWT header segment always
// starts `eyJ` and is followed by a second base64url segment. Fable's review
// flagged this as the shape gitleaks' assignment-context rules miss in prose.
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/g;
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi;
const PRIVATE_KEY_HEADER = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g;
// Opt-in only. On our own corpus this rule alone blocked 2,082 of 12,688 files
// (16.4%) — long kebab/snake slugs and document filenames clear the 4.0 bar
// easily (5,688 kebab-word + 1,982 snake-word + 8,550 mixed matches). A gate
// that blocks one file in six is not a gate; it is an outage. Entropy scanning
// belongs in the staging scan, where gitleaks tunes it and a human reviews the
// file-level verdict before ingest. Here we keep only high-signal shapes and
// the known-value denylist.
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9_-]{40,}/g;
const HIGH_ENTROPY_THRESHOLD = 4.0;
function entropyRuleEnabled(): boolean {
  return process.env.GBRAIN_OUTBOUND_ENTROPY_GATE === '1';
}

function loadKnownValues(): string[] {
  const path = process.env.GBRAIN_OUTBOUND_DENYLIST_FILE;
  if (!path) return [];
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(line => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

// Process-start snapshot: rotating the file requires a process restart.
const KNOWN_VALUES = loadKnownValues();
const OUTBOUND_GATE_ENABLED = process.env.GBRAIN_OUTBOUND_GATE !== '0';
let warnedDisabled = false;

function firstMatch(text: string, pattern: RegExp): number | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  return match ? match.index : null;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** Pure scanner: no I/O, logging, or mutation. */
export function scanOutboundText(text: string): OutboundScanResult {
  const rules: Array<[string, RegExp]> = [
    ['credential-prefix', CREDENTIAL_PREFIX],
    ['authorization-header', AUTHORIZATION_HEADER],
    ['url-userinfo', URL_USERINFO],
    ['private-key-pem', PRIVATE_KEY_HEADER],
    ['jwt-token', JWT_TOKEN],
  ];
  for (const [ruleId, pattern] of rules) {
    const offset = firstMatch(text, pattern);
    if (offset !== null) return { ok: false, ruleId, offset };
  }

  for (const value of KNOWN_VALUES) {
    const offset = text.indexOf(value);
    if (offset !== -1) return { ok: false, ruleId: 'known-value-denylist', offset };
  }

  if (!entropyRuleEnabled()) return { ok: true };

  HIGH_ENTROPY_TOKEN.lastIndex = 0;
  for (let match = HIGH_ENTROPY_TOKEN.exec(text); match; match = HIGH_ENTROPY_TOKEN.exec(text)) {
    if (shannonEntropy(match[0]) >= HIGH_ENTROPY_THRESHOLD) {
      return { ok: false, ruleId: 'high-entropy-token', offset: match.index };
    }
  }
  return { ok: true };
}

export class OutboundGateError extends Error {
  readonly ruleId: string;
  readonly textIndex: number;
  readonly offset: number;

  constructor(ruleId: string, textIndex: number, offset: number) {
    super(
      `Outbound embedding blocked by rule "${ruleId}" at texts[${textIndex}] offset ${offset}. ` +
      // Deliberately does NOT name the disable switch. An agent that hits this
      // mid-backfill will do whatever the message suggests, and "turn the gate
      // off" must never be the path of least resistance.
      'Remove the sensitive value from the source document, then re-run the staging transform.',
    );
    this.name = 'OutboundGateError';
    this.ruleId = ruleId;
    this.textIndex = textIndex;
    this.offset = offset;
  }
}

/**
 * Image inputs cannot be scanned by any text rule here — a screenshot of a
 * terminal, a QR code, or a settings pane carries credentials that no regex
 * will ever see. Until image embedding has its own threat model (local OCR /
 * DLP + an approval path), refuse it outright rather than let it slip past a
 * gate that structurally cannot inspect it.
 */
export function assertOutboundImageEmbeddingAllowed(kinds: readonly string[]): void {
  if (!OUTBOUND_GATE_ENABLED) return;
  if (process.env.GBRAIN_OUTBOUND_ALLOW_IMAGE === '1') return;
  const index = kinds.findIndex(kind => kind !== 'text');
  if (index === -1) return;
  throw new OutboundGateError('image-input-not-scannable', index, 0);
}

export function assertOutboundEmbeddingAllowed(texts: string[]): void {
  if (!OUTBOUND_GATE_ENABLED) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      process.stderr.write(
        '[ai.gateway] WARNING: outbound embedding gate disabled by GBRAIN_OUTBOUND_GATE=0.\n',
      );
    }
    return;
  }
  for (let i = 0; i < texts.length; i++) {
    const result = scanOutboundText(texts[i]);
    if (!result.ok) throw new OutboundGateError(result.ruleId, i, result.offset);
  }
}
