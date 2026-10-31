/**
 * Block-format conversation normalizer.
 *
 * Some chat exports — notably the Slack collector gbrain's own ingestion
 * uses — emit a HEADER + indented-body BLOCK per message instead of the
 * single-line `**Name** (time): body` shape the built-in patterns
 * (`builtins.ts`) recognize:
 *
 *     - **Theo** (Mon 11:18)
 *       Hey everyone — quick update on the renewal.
 *
 *       Second paragraph of the same message.
 *     - **Juan** (Mon 11:20)
 *       Reply body...
 *
 * None of the 14 line-oriented built-ins match this: a leading `- ` list
 * marker, a day-of-week + time with no trailing colon, and the message body on
 * the following indented lines. Result: `phase: 'no_match'`, zero messages,
 * and the whole comms corpus is silently un-extractable (facts stay empty →
 * `find_trajectory` returns nothing).
 *
 * This collapses each block into the canonical `**Name** (HH:MM): <body joined
 * to one line>` shape so the existing `bold-paren-time` pattern matches; the
 * per-message date fills in downstream via `fallbackDate` (the page date).
 *
 * STRICT no-op unless the block signature is present: the header regex requires
 * the paren-group to END the line (no inline `: body`), which is exactly what
 * the single-line patterns always produce — so feeding already-canonical
 * content through this function returns it unchanged.
 */

// `- **Name** (Mon 11:18)` / `- **Name** (11:18 AM)` / `- **Name** (16:36)`.
// Day-of-week optional; 12h/24h time; optional am/pm; the line ENDS at the
// close paren (no inline `: body` — that is what distinguishes a block header
// from the single-line `**Name** (time): body` patterns).
const BLOCK_HEADER =
  /^\s*-\s+\*\*(.+?)\*\*\s+\((?:[A-Za-z]{2,9}\.?\s+)?(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?\)\s*$/;

/** True when at least one line is a block-format message header. */
export function looksLikeBlockConversation(body: string): boolean {
  for (const line of body.split('\n')) {
    if (BLOCK_HEADER.test(line)) return true;
  }
  return false;
}

function to24h(hour: number, ampm?: string): number {
  if (!ampm) return hour;
  const lower = ampm.toLowerCase();
  if (lower === 'pm' && hour < 12) return hour + 12;
  if (lower === 'am' && hour === 12) return 0;
  return hour;
}

/**
 * normalizeBlockConversation one line at a time: `emit` gets each collapsed message line once the message ends (the next
 * header, or `end()`); `headers` counts the block headers seen. Lines before the first header are dropped. With
 * `maxBodyChars`, a message's body keeps only its first that many characters (pattern detection, which needs the
 * collapsed line's shape, not all of its text), copied so a kept line never holds the text it was cut from alive.
 */
export function blockNormalizer(emit: (line: string) => void, opts: { maxBodyChars?: number } = {}): { line(line: string): void; end(): void; readonly headers: number } {
  let current: { name: string; time: string } | null = null;
  let bodyParts: string[] = [];
  let bodyChars = 0;
  let headers = 0;

  const flush = () => {
    if (current) {
      const text = bodyParts.join(' ').replace(/\s+/g, ' ').trim();
      emit(`**${current.name}** (${current.time}): ${text}`);
    }
    current = null;
    bodyParts = [];
    bodyChars = 0;
  };

  return {
    get headers() { return headers; },
    line(line: string) {
      const m = BLOCK_HEADER.exec(line);
      if (m) {
        flush();
        headers++;
        const hour = to24h(parseInt(m[2], 10), m[4]);
        const time = `${String(hour).padStart(2, '0')}:${m[3]}`;
        current = { name: m[1].trim(), time };
      } else if (current) {
        // Body line of the current message. Drop blank lines; keep the rest.
        const room = (opts.maxBodyChars ?? Infinity) - bodyChars;
        const trimmed = room > 0 ? line.trim().slice(0, room) : '';
        if (trimmed) { bodyParts.push(opts.maxBodyChars === undefined ? trimmed : Buffer.from(trimmed).toString()); bodyChars += trimmed.length; }
      }
      // Lines before the first header (page title, leading blanks) are dropped —
      // they never matched a pattern anyway.
    },
    end: flush,
  };
}

/**
 * Collapse block-format messages into canonical single-line `**Name** (HH:MM):
 * body` lines. Returns `body` unchanged when no block header is present.
 */
export function normalizeBlockConversation(body: string): string {
  if (!looksLikeBlockConversation(body)) return body;
  const out: string[] = [];
  const normalizer = blockNormalizer(line => out.push(line));
  for (const line of body.split('\n')) normalizer.line(line);
  normalizer.end();
  return out.length > 0 ? out.join('\n') : body;
}
