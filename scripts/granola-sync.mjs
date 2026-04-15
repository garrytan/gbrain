#!/usr/bin/env node
/**
 * granola-sync.mjs — Sync Granola meetings into kbrain
 *
 * Pulls recent meetings from Granola via granola-cli, converts to
 * kbrain-format markdown, and writes to the brain repo's meetings/ dir.
 * Autopilot picks them up from there.
 *
 * Usage:
 *   node scripts/granola-sync.mjs                    # last 7 days
 *   node scripts/granola-sync.mjs --days 30          # last 30 days
 *   node scripts/granola-sync.mjs --limit 5          # last 5 meetings
 *   node scripts/granola-sync.mjs --brain-dir ~/Documents/kbrain
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// --- Config ---
const DEFAULT_BRAIN_DIR = process.env.KBRAIN_DIR || join(process.env.HOME, 'Documents/kbrain');
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 50;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { brainDir: DEFAULT_BRAIN_DIR, days: DEFAULT_DAYS, limit: DEFAULT_LIMIT, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--brain-dir' && args[i + 1]) opts.brainDir = args[++i];
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[++i], 10);
    if (args[i] === '--limit' && args[i + 1]) opts.limit = parseInt(args[++i], 10);
    if (args[i] === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8', timeout: 60_000 }).trim();
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function listMeetings(limit) {
  const raw = run(`npx granola-cli meeting list --limit ${limit} --output json 2>/dev/null`);
  return JSON.parse(raw);
}

function exportMeetingContent(id) {
  // Export returns notes_markdown, notes_raw, transcript — NOT metadata
  const raw = run(`npx granola-cli meeting export ${id} --format json 2>/dev/null`);
  return JSON.parse(raw);
}

function getEnhancedNotes(id) {
  try {
    return run(`npx granola-cli meeting enhanced ${id} -o markdown 2>/dev/null`);
  } catch {
    return null;
  }
}

function getTranscript(id) {
  try {
    return run(`npx granola-cli meeting transcript ${id} --timestamps 2>/dev/null`);
  } catch {
    return null;
  }
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toISOString().split('T')[0];
}

function extractAttendees(meeting) {
  const attendees = [];
  const seen = new Set();

  function addPerson(p) {
    if (!p || !p.name) return;
    if (seen.has(p.email || p.name)) return;
    seen.add(p.email || p.name);
    attendees.push({
      name: p.name,
      email: p.email || null,
      company: p.details?.company?.name || p.details?.person?.employment?.name || null,
    });
  }

  // Granola list data has people.creator + people.attendees
  if (meeting.people && typeof meeting.people === 'object') {
    if (meeting.people.creator) addPerson(meeting.people.creator);
    if (Array.isArray(meeting.people.attendees)) {
      for (const a of meeting.people.attendees) addPerson(a);
    }
  }

  // Calendar event attendees as fallback
  if (attendees.length === 0 && meeting.google_calendar_event?.attendees) {
    for (const a of meeting.google_calendar_event.attendees) {
      addPerson({ name: a.displayName || a.email, email: a.email });
    }
  }

  return attendees;
}

function autoTag(title) {
  const t = title.toLowerCase();
  if (t.includes('standup') || t.includes('sync')) return ['sync'];
  if (t.includes('1:1') || t.includes('1on1') || t.includes('<>')) return ['1on1'];
  if (t.includes('office hours') || t.includes(' oh ')) return ['oh'];
  if (t.includes('board')) return ['board'];
  if (t.includes('demo')) return ['demo'];
  if (t.includes('interview')) return ['interview'];
  return ['meeting'];
}

function getMeetingDate(meeting) {
  // Prefer calendar event start time, then created_at
  const calStart = meeting.google_calendar_event?.start?.dateTime;
  if (calStart) return calStart;
  return meeting.created_at || new Date().toISOString();
}

function buildMarkdown(meeting, enhanced, transcript) {
  const title = meeting.title || 'Untitled Meeting';
  const date = formatDate(getMeetingDate(meeting));
  const attendees = extractAttendees(meeting);
  const tags = autoTag(title);
  const sourceId = meeting.id;
  const granolaUrl = `https://notes.granola.ai/t/${sourceId}`;

  // YAML frontmatter
  let fm = `---\n`;
  fm += `title: "${title.replace(/"/g, '\\"')}"\n`;
  fm += `type: meeting\n`;
  fm += `date: ${date}\n`;
  fm += `created: ${date}\n`;
  fm += `source: granola\n`;
  fm += `source_id: ${sourceId}\n`;
  if (attendees.length > 0) {
    fm += `attendees:\n`;
    for (const a of attendees) {
      fm += `  - name: "${a.name}"`;
      if (a.email) fm += `\n    email: ${a.email}`;
      if (a.company) fm += `\n    company: "${a.company}"`;
      fm += `\n`;
    }
  }
  fm += `tags: [${tags.join(', ')}]\n`;
  fm += `---\n\n`;

  // Body
  let body = `# ${title}\n\n`;

  if (attendees.length > 0) {
    body += `## Attendees\n`;
    for (const a of attendees) {
      body += `- ${a.name}`;
      if (a.company) body += ` (${a.company})`;
      body += `\n`;
    }
    body += `\n`;
  }

  if (enhanced) {
    body += enhanced + '\n\n';
  }

  if (transcript) {
    body += `---\n\n## Transcript\n\n${transcript}\n\n`;
  }

  body += `---\n[Source: Granola](${granolaUrl})\n`;

  return fm + body;
}

// --- Main ---
async function main() {
  const opts = parseArgs();
  const meetingsDir = join(opts.brainDir, 'meetings');
  mkdirSync(meetingsDir, { recursive: true });

  // Check granola-cli auth
  try {
    run('npx granola-cli auth status 2>/dev/null');
  } catch {
    console.log('Granola not authenticated. Running auth login...');
    run('npx granola-cli auth login');
  }

  console.log(`Syncing last ${opts.days} days of Granola meetings to ${meetingsDir}`);

  // List meetings
  let meetings;
  try {
    meetings = listMeetings(opts.limit);
  } catch (e) {
    console.error('Failed to list meetings:', e.message);
    process.exit(1);
  }

  if (!Array.isArray(meetings) || meetings.length === 0) {
    console.log('No meetings found.');
    return;
  }

  // Filter by date
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - opts.days);

  let synced = 0;
  let skipped = 0;

  for (const m of meetings) {
    const id = m.id;
    const title = m.title || 'Untitled';
    const dateStr = formatDate(getMeetingDate(m));

    // Check if already synced (idempotency by source_id)
    const slug = slugify(title);
    const filename = `${dateStr}-${slug}.md`;
    const filepath = join(meetingsDir, filename);

    if (existsSync(filepath)) {
      const existing = readFileSync(filepath, 'utf-8');
      if (existing.includes(id)) {
        skipped++;
        continue;
      }
    }

    console.log(`  Syncing: ${title} (${dateStr})`);

    if (opts.dryRun) {
      synced++;
      continue;
    }

    try {
      // Use list metadata for meeting info (title, date, attendees, calendar)
      // Use export/enhanced/transcript for content
      const enhanced = getEnhancedNotes(id);
      const transcript = getTranscript(id);

      const md = buildMarkdown(m, enhanced, transcript);
      writeFileSync(filepath, md, 'utf-8');
      synced++;
    } catch (e) {
      console.error(`  Failed to sync "${title}": ${e.message}`);
    }
  }

  console.log(`\nDone. Synced: ${synced}, Skipped (already exists): ${skipped}`);
  if (synced > 0 && !opts.dryRun) {
    console.log(`\nFiles written to: ${meetingsDir}`);
    console.log(`Autopilot will index them on next run, or manually: gbrain sync --repo ${opts.brainDir}`);
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
