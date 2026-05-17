/**
 * context-builder.example.mjs — Working example implementation.
 *
 * Provides buildMarsContext() and buildVenusContext() against a documented
 * brain layout. Operators with a different layout edit the path constants
 * at the top, OR replace this file in place with their own implementation
 * that satisfies `context-builder.contract.md`.
 *
 * This example reads:
 *   $BRAIN_ROOT/memory/YYYY-MM-DD.md   (daily memory; emotional signal)
 *   $BRAIN_ROOT/SOUL.md                (stable emotional landscape)
 *   $BRAIN_ROOT/tasks/open.md          (active tasks for Venus)
 *   $BRAIN_ROOT/calendar/today.md      (today's events for Venus)
 *   $BRAIN_ROOT/memory/heartbeat-state.json (optional timezone)
 *
 * The implementation is intentionally generic. It does NOT name specific
 * family members, therapists, or projects. It uses a content-agnostic
 * emotion-word filter that catches what's emotionally loaded in the
 * operator's own words.
 *
 * Latency budget: ≤ 200ms wall time.
 * Output cap: 2500 chars (truncated at boundary).
 * PII scrub: emails + phones → [redacted] at the boundary.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_CHARS = 2500;

// Emotion-word filter. Content-agnostic — catches what's loaded in the
// operator's OWN words without hardcoding names of people in their life.
// Add words to this list if your brain uses domain-specific vocabulary.
const EMOTION_WORDS = [
  'feel', 'feeling', 'felt',
  'heart', 'love', 'lonely', 'alone',
  'joy', 'happy', 'happiness',
  'grief', 'sad', 'sadness', 'cry', 'crying',
  'anger', 'angry', 'rage', 'frustrated',
  'fear', 'afraid', 'scared', 'anxious', 'anxiety',
  'hope', 'hopeful', 'hopeless',
  'ache', 'aching', 'miss', 'missing', 'longing',
  'alive', 'dead', 'numb', 'numbing',
  'therapy', 'therapist',
  'family', 'father', 'mother', 'son', 'daughter',
  'relationship', 'partner',
  'tired', 'exhausted', 'burnt out', 'burned out',
  'present', 'presence', 'mindful',
  'meaning', 'meaningful', 'purpose',
  'pattern', 'insight', 'realize', 'realized',
  'memory', 'remember', 'forgot',
];

const REDACT_RE = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  phone: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/g,
};

/** Scrub emails + phones from a string. Conservative; misses long-tail PII. */
function scrub(ctx) {
  return ctx.replace(REDACT_RE.email, '[email]').replace(REDACT_RE.phone, '[phone]');
}

/** Truncate to MAX_CHARS at a word boundary. */
function cap(ctx) {
  if (ctx.length <= MAX_CHARS) return ctx;
  const slice = ctx.slice(0, MAX_CHARS);
  const lastBreak = slice.lastIndexOf('\n');
  return lastBreak > MAX_CHARS - 200 ? slice.slice(0, lastBreak) : slice;
}

/** ISO YYYY-MM-DD from a Date in the given timezone. Defaults to UTC. */
function isoDate(date, tz) {
  if (!tz) return date.toISOString().slice(0, 10);
  // Intl is slow; only when caller passes a tz.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date);
}

/** Detect timezone from optional heartbeat-state.json. */
function detectTimezone(brainRoot) {
  const hbPath = join(brainRoot, 'memory', 'heartbeat-state.json');
  if (!existsSync(hbPath)) return undefined;
  try {
    const hb = JSON.parse(readFileSync(hbPath, 'utf8'));
    return hb?.currentLocation?.timezone;
  } catch {
    return undefined;
  }
}

/**
 * Build emotionally-salient context for Mars.
 *
 * Strategy:
 *   1. Date + timezone awareness for "what time is it" questions.
 *   2. SOUL.md (capped at 600 chars) for stable emotional landscape.
 *   3. Last 2 days of memory files, emotion-word-filtered, ≤ 8 lines each.
 *   4. PII scrub + truncation cap.
 */
export async function buildMarsContext({ brainRoot, timezone } = {}) {
  if (!brainRoot) return '';
  const tz = timezone || detectTimezone(brainRoot) || 'UTC';

  let ctx = "WHAT IS GOING ON IN THE OPERATOR'S INNER LIFE RIGHT NOW.\n";
  ctx += "Use this as background. Don't recite it. Let it inform your questions and responses.\n\n";

  // 1. Date + time
  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
      timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const timeStr = now.toLocaleTimeString('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit',
    });
    ctx += `It's ${dateStr}, ${timeStr} (${tz}).\n\n`;
  } catch {
    // tz invalid — fall through with no date line
  }

  // 2. Stable emotional landscape
  try {
    const soulPath = join(brainRoot, 'SOUL.md');
    if (existsSync(soulPath)) {
      const soul = readFileSync(soulPath, 'utf8');
      // Take the first ~600 chars as the "core context."
      ctx += `CORE CONTEXT:\n${soul.slice(0, 600).trim()}\n\n`;
    }
  } catch {}

  // 3. Recent daily memory, emotion-filtered.
  try {
    const now = new Date();
    const dates = [now, new Date(now.getTime() - 86400000)].map((d) => isoDate(d, tz));
    for (const date of dates) {
      const dayPath = join(brainRoot, 'memory', `${date}.md`);
      if (!existsSync(dayPath)) continue;
      const day = readFileSync(dayPath, 'utf8');
      const emotionalLines = day.split('\n').filter((l) => {
        const lower = l.toLowerCase();
        return EMOTION_WORDS.some((w) => lower.includes(w));
      }).slice(0, 8);
      if (emotionalLines.length > 0) {
        ctx += `RECENT (${date}):\n${emotionalLines.join('\n')}\n\n`;
      }
    }
  } catch {}

  return cap(scrub(ctx));
}

/**
 * Build logistics-salient context for Venus.
 *
 * Strategy:
 *   1. Date + timezone.
 *   2. Today's calendar events (calendar/today.md if present).
 *   3. Top open tasks (tasks/open.md if present, first ~5 lines).
 *   4. PII scrub + cap.
 */
export async function buildVenusContext({ brainRoot, timezone } = {}) {
  if (!brainRoot) return '';
  const tz = timezone || detectTimezone(brainRoot) || 'UTC';

  let ctx = "TODAY AT A GLANCE for the operator.\n";
  ctx += "Use this for fast logistics answers. Don't recite it; pull from it.\n\n";

  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
      timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
    });
    const timeStr = now.toLocaleTimeString('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit',
    });
    ctx += `${dateStr}, ${timeStr} (${tz}).\n\n`;
  } catch {}

  // Calendar
  try {
    const calPath = join(brainRoot, 'calendar', 'today.md');
    if (existsSync(calPath)) {
      const cal = readFileSync(calPath, 'utf8').trim();
      if (cal) {
        ctx += `CALENDAR:\n${cal.slice(0, 800)}\n\n`;
      }
    }
  } catch {}

  // Open tasks
  try {
    const tasksPath = join(brainRoot, 'tasks', 'open.md');
    if (existsSync(tasksPath)) {
      const tasks = readFileSync(tasksPath, 'utf8');
      const lines = tasks.split('\n').filter((l) => l.trim().startsWith('-') || l.trim().startsWith('*')).slice(0, 5);
      if (lines.length > 0) {
        ctx += `TOP TASKS:\n${lines.join('\n')}\n\n`;
      }
    }
  } catch {}

  return cap(scrub(ctx));
}
