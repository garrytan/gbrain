/**
 * Vendored contract of the PR stress gate's exemption parser (lane D,
 * origin/capy/gmw-d @ 60557b495: scripts/stress/gate.ts `parseExemptionBlocks`
 * and scripts/stress/run.ts `failureSignature`, copied verbatim). The
 * nightly-watch tests feed the issue bodies the watcher writes through it, so
 * a format drift on either side fails test/scripts/nightly-issue.test.ts.
 * When both branches are on master, import scripts/stress/gate.ts instead.
 */
export interface VendoredExemption { file: string; test: string; backend: string; signature: string; owner: string; expires: string }

/** Stable failure signature: the first lines of the message with numbers, temp paths and UUIDs masked. */
export function failureSignature(message: string): string {
  return message.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4).join(' ')
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/\S+/g, '<tmp>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'N').replace(/\s+/g, ' ').slice(0, 200);
}

const MARKER = '<!-- gbrain-stress-exemption -->';

/** Every exemption block (`<!-- gbrain-stress-exemption -->` then a ```json object or array) in a text. */
export function parseExemptionBlocks(text: string): VendoredExemption[] {
  const out: VendoredExemption[] = [];
  let at = text.indexOf(MARKER);
  while (at !== -1) {
    const rest = text.slice(at + MARKER.length).trimStart();
    const m = /^```json\n([\s\S]*?)\n```/.exec(rest);
    if (m) {
      try {
        const parsed = JSON.parse(m[1]!) as unknown;
        for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
          const r = row as Record<string, unknown>;
          if (['file', 'test', 'backend', 'signature', 'owner', 'expires'].every(k => typeof r[k] === 'string' && (r[k] as string).length > 0) && /^\d{4}-\d{2}-\d{2}$/.test(r.expires as string)) {
            out.push({ file: r.file as string, test: r.test as string, backend: r.backend as string, signature: r.signature as string, owner: r.owner as string, expires: r.expires as string });
          }
        }
      } catch { /* malformed block grants nothing */ }
    }
    at = text.indexOf(MARKER, at + MARKER.length);
  }
  return out;
}
