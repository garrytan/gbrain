# Context Builder Contract

The voice personas (`mars`, `venus`) ship with static prompts. The operator's
**live brain context** (recent activity, calendar, emotional themes,
relationships) is injected at session start by a function the operator
implements.

This file documents the API contract that implementation must satisfy.

A working example lives at `../context-builder.example.mjs` — copy it,
adapt it to your brain's actual layout, and import the real one from
`server.mjs` at session-start time. The example reads a documented brain
layout (`$BRAIN_ROOT/memory/YYYY-MM-DD.md`); operators with different
layouts replace the file body but keep the function signatures.

## Function signatures

```js
/**
 * Build emotionally-salient context for Mars (solo mode).
 *
 * Returns a string ≤ 2500 chars summarizing what's going on in the
 * operator's inner life right now. Mars uses this as background — does NOT
 * recite it back. The format is informational, not a directive.
 *
 * Required: PII scrubbed (phone numbers, emails redacted via REDACT_RE).
 * Required: ≤ 2500 chars (longer is truncated at the boundary).
 *
 * @param {object} opts
 * @param {string} opts.brainRoot — absolute path to brain repo
 * @param {string} [opts.timezone] — IANA tz, e.g. "US/Pacific"
 * @returns {Promise<string>}
 */
export async function buildMarsContext(opts);

/**
 * Build logistics-salient context for Venus.
 *
 * Returns a terse summary of today's commitments, recent emails/messages
 * the operator hasn't seen, and one-liner notable items. Venus reads from
 * this to answer "what's on my calendar" / "any messages" / "what's the
 * status of X" instantly.
 *
 * Required: PII scrubbed.
 * Required: ≤ 2500 chars (longer is truncated).
 *
 * @param {object} opts
 * @param {string} opts.brainRoot
 * @param {string} [opts.timezone]
 * @returns {Promise<string>}
 */
export async function buildVenusContext(opts);
```

## Brain layout expected by the shipped example

The shipped `context-builder.example.mjs` assumes:

```
$BRAIN_ROOT/
├── memory/
│   ├── YYYY-MM-DD.md              # daily memory file (markdown)
│   └── heartbeat-state.json       # optional: {currentLocation: {timezone: "US/Pacific"}}
├── people/
│   └── <slug>.md
├── companies/
│   └── <slug>.md
├── tasks/
│   └── open.md                    # active tasks list
└── calendar/
    └── today.md                   # today's events (optional)
```

If your brain uses a different layout (e.g. `daily/YYYY-MM-DD.md` instead of
`memory/`), edit `context-builder.example.mjs` and adjust the path
constants at the top. The function signatures must remain stable.

## Signal-extraction policy

For Mars (emotional):
- Pull recent emotionally-loaded lines from the most recent ≤ 2 memory
  files. Use a generic emotion-word filter (feel, heart, lonely, joy,
  grief, anger, fear, hope, ache, miss, alive, numb, etc.) — NOT
  hardcoded family names.
- Pull "core context" from the operator's stable file (`SOUL.md` or
  equivalent) — the high-level emotional landscape the operator
  documented once. Cap at 600 chars.
- Pull recent themes the operator has been chewing on (recurring
  concepts across the last 3 memory files).

For Venus (logistical):
- Active task count + top 3 highest-priority titles.
- Calendar events for today (if `calendar/today.md` exists).
- Unread message count (if a `messages/inbox.md` or similar exists).
- One-liner from the most recent meeting transcript (if any).

## PII scrub requirements

Before returning, run the context string through a PII scrubber:

```js
const REDACT_RE = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  phone: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/g,
};
ctx = ctx.replace(REDACT_RE.email, '[email]')
         .replace(REDACT_RE.phone, '[phone]');
```

Mars and Venus are configured to never read PII aloud anyway, but
scrubbing at the context-builder layer is defense-in-depth.

## Failure modes

- If the brain layout doesn't match the example, return an empty string.
  The personas degrade gracefully (Mars asks open questions; Venus says
  "I can't see your calendar from here — what do you need?").
- Try/catch every file read. Missing files are normal, not errors.
- The context-builder runs in the host process at session start; latency
  matters. Keep total wall-time under ~200ms.

## Testing

`mars-prompt-shape.test.mjs` and `venus-prompt-shape.test.mjs` verify the
SHIPPED prompts. They do NOT exercise the operator-implemented
buildXContext functions — those are out of scope for the shipped tests.

If you want to test your local context-builder, write your own
`context-builder.local.test.mjs` against the contract above. Suggested
assertions:

- Returns a string ≤ 2500 chars.
- Contains no email-shaped or phone-shaped substrings.
- Doesn't throw on missing files.
- Doesn't throw on malformed memory files.
- Returns within ~200ms for a brain with ~10k pages.
