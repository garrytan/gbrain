/**
 * mbrain report — Save a structured report to brain/reports/.
 *
 * Deterministic: zero LLM calls. Creates timestamped report pages
 * for audit trails of enrichment sweeps, maintenance runs, syncs, etc.
 *
 * Usage:
 *   mbrain report --type enrichment-sweep --title "Enrichment Sweep" --content "..."
 *   echo "report body" | mbrain report --type meeting-sync --title "Meeting Sync"
 *   mbrain report --type enrichment-sweep --dir /path/to/brain
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

export async function runReport(args: string[]) {
  const typeIdx = args.indexOf('--type');
  const titleIdx = args.indexOf('--title');
  const contentIdx = args.indexOf('--content');
  const dirIdx = args.indexOf('--dir');

  const reportType = typeIdx >= 0 ? args[typeIdx + 1] : null;
  const brainDir = dirIdx >= 0 ? args[dirIdx + 1] : '.';

  // Validate reportType to prevent path traversal
  if (reportType && !/^[a-z0-9][a-z0-9-]*$/.test(reportType)) {
    console.error('Report type must be lowercase alphanumeric with hyphens only (e.g., "enrichment-sweep")');
    process.exit(1);
  }

  if (!reportType) {
    console.error('Usage: mbrain report --type <name> --title "..." --content "..." [--dir <brain>]');
    console.error('  Or pipe content via stdin:');
    console.error('    echo "report body" | mbrain report --type meeting-sync --title "Daily Sync"');
    console.error('');
    console.error('  Common types: enrichment-sweep, meeting-sync, maintenance, backlink-check, lint');
    console.error('  Creates: brain/reports/{type}/{YYYY-MM-DD-HHMM}.md');
    process.exit(1);
  }

  // Read content from --content arg or stdin
  let content = contentIdx >= 0 ? args[contentIdx + 1] : null;
  if (!content && !process.stdin.isTTY) {
    content = readFileSync('/dev/stdin', 'utf-8');
  }

  if (!content?.trim()) {
    console.error('No content provided. Use --content "..." or pipe via stdin.');
    process.exit(1);
  }

  const title = titleIdx >= 0
    ? args[titleIdx + 1]
    : reportType.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const filepath = saveBrainReport({ brainDir, type: reportType, title, content });
  console.log(filepath);
}

export function saveBrainReport(input: {
  brainDir: string;
  type: string;
  title: string;
  content: string;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const timePretty = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const filename = `${dateStr}-${timeStr}.md`;
  const reportDir = join(input.brainDir, 'reports', input.type);
  mkdirSync(reportDir, { recursive: true });

  const page = `---
title: "${input.title} -- ${dateStr}"
type: report
report_type: ${input.type}
date: ${dateStr}
time: "${timePretty}"
---

# ${input.title} -- ${dateStr} ${timePretty}

${input.content.trim()}
`;

  const filepath = join(reportDir, filename);
  writeFileSync(filepath, page);
  return filepath;
}
