/**
 * gbrain features — Scan brain usage and recommend unused features.
 *
 * Usage:
 *   gbrain features [--json] [--auto-fix] [--help]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { VERSION } from '../version.ts';

// --- Types ---

type FeaturePriority = 1 | 2;

interface FeatureRecommendation {
  id: string;
  priority: FeaturePriority;
  title: string;
  pitch: string;
  command: string;
  auto_fixable: boolean;
}

interface FeatureOffersFile {
  lastVersion: string;
  lastScan: string;
  declined: Record<string, { at: string; version: string }>;
  accepted: Record<string, { at: string; version: string }>;
}

interface FeatureScanResult {
  version: string;
  scan_ts: string;
  brain_score: number;
  recommendations: FeatureRecommendation[];
}

// --- Embedded recipe metadata (binary-safe, no disk reads) ---

const RECIPE_META = [
  { id: 'email-to-brain', name: 'Email to Brain', secrets: ['GMAIL_APP_PASSWORD'] },
  { id: 'calendar-to-brain', name: 'Calendar Sync', secrets: ['GOOGLE_CALENDAR_API_KEY'] },
  { id: 'x-to-brain', name: 'X/Twitter to Brain', secrets: ['X_BEARER_TOKEN'] },
  { id: 'twilio-voice-brain', name: 'Voice to Brain', secrets: ['TWILIO_AUTH_TOKEN'] },
  { id: 'meeting-sync', name: 'Meeting Sync', secrets: ['CIRCLEBACK_API_KEY'] },
  { id: 'credential-gateway', name: 'Credential Gateway', secrets: ['OAUTH_CLIENT_SECRET'] },
  { id: 'ngrok-tunnel', name: 'Ngrok Tunnel', secrets: ['NGROK_AUTHTOKEN'] },
] as const;

// --- Persistence ---

function offersPath(): string {
  return join(process.env.HOME || '', '.gbrain', 'feature-offers.json');
}

function loadOffers(): FeatureOffersFile {
  try {
    const raw = readFileSync(offersPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { lastVersion: '', lastScan: '', declined: {}, accepted: {} };
  }
}

function saveOffers(offers: FeatureOffersFile) {
  try {
    const dir = join(process.env.HOME || '', '.gbrain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(offersPath(), JSON.stringify(offers, null, 2));
  } catch { /* best-effort */ }
}

function shouldPitch(rec: FeatureRecommendation, offers: FeatureOffersFile, currentVersion: string): boolean {
  if (rec.priority === 1) return true; // always pitch data quality
  const majorMinor = currentVersion.split('.').slice(0, 2).join('.');
  const declined = offers.declined[rec.id];
  if (declined && declined.version.startsWith(majorMinor)) return false;
  return true;
}

// --- Scanners ---

async function scanFeatures(engine: BrainEngine): Promise<FeatureScanResult> {
  const stats = await engine.getStats();
  const health = await engine.getHealth();
  const recommendations: FeatureRecommendation[] = [];

  // P1: Missing embeddings
  if (health.missing_embeddings > 0) {
    recommendations.push({
      id: 'missing-embeddings', priority: 1,
      title: 'Fix Missing Embeddings',
      pitch: `${health.missing_embeddings} chunks invisible to semantic search. One command fixes it.`,
      command: 'gbrain embed --stale',
      auto_fixable: true,
    });
  }

  // P1: Dead links
  if (health.dead_links > 0) {
    recommendations.push({
      id: 'dead-links', priority: 1,
      title: 'Fix Dead Links',
      pitch: `${health.dead_links} links pointing to non-existent pages.`,
      command: 'gbrain check-backlinks fix',
      auto_fixable: false,
    });
  }

  // P2: skip if brain too new
  if (stats.page_count >= 3) {
    // Zero links
    if (stats.link_count === 0 && stats.page_count > 5) {
      recommendations.push({
        id: 'zero-links', priority: 2,
        title: 'Build Link Graph',
        pitch: `${stats.page_count} pages but 0 links. Your brain is a flat file cabinet, not a knowledge graph.`,
        command: 'gbrain extract links',
        auto_fixable: true,
      });
    }

    // Zero timeline
    if (stats.timeline_entry_count === 0 && stats.page_count > 5) {
      recommendations.push({
        id: 'zero-timeline', priority: 2,
        title: 'Extract Timeline',
        pitch: `No structured timeline entries. Your brain can't answer "when did X happen?"`,
        command: 'gbrain extract timeline',
        auto_fixable: true,
      });
    }

    // Low embed coverage
    if (health.embed_coverage < 0.9 && health.embed_coverage > 0) {
      const pct = (health.embed_coverage * 100).toFixed(0);
      recommendations.push({
        id: 'low-coverage', priority: 2,
        title: 'Improve Embedding Coverage',
        pitch: `${pct}% embed coverage. ${health.missing_embeddings} chunks invisible to semantic search.`,
        command: 'gbrain embed --stale',
        auto_fixable: true,
      });
    }

    // Unconfigured integrations
    const unconfigured = RECIPE_META.filter(r =>
      !r.secrets.every(s => process.env[s])
    );
    if (unconfigured.length > 0) {
      recommendations.push({
        id: 'no-integrations', priority: 2,
        title: 'Set Up Integrations',
        pitch: `${unconfigured.length} integration recipes available but not configured: ${unconfigured.map(r => r.name).join(', ')}.`,
        command: `gbrain integrations list`,
        auto_fixable: false,
      });
    }

    // No sync configured
    try {
      const syncRepo = await engine.getConfig('sync.repo_path');
      if (!syncRepo) {
        recommendations.push({
          id: 'no-sync', priority: 2,
          title: 'Configure Sync',
          pitch: `Brain not syncing from git. Changes in your repo don't reach your brain.`,
          command: 'gbrain sync --repo <path>',
          auto_fixable: false,
        });
      }
    } catch { /* skip */ }
  }

  return {
    version: VERSION,
    scan_ts: new Date().toISOString(),
    brain_score: (health as any).brain_score ?? 0,
    recommendations,
  };
}

// --- Auto-fix ---

async function executeAutoFix(rec: FeatureRecommendation, engine: BrainEngine): Promise<{ success: boolean; output: string }> {
  try {
    switch (rec.id) {
      case 'missing-embeddings':
      case 'low-coverage': {
        const { runEmbed } = await import('./embed.ts');
        await runEmbed(engine, ['--stale']);
        return { success: true, output: 'Stale embeddings refreshed' };
      }
      case 'zero-links': {
        const { runExtract } = await import('./extract.ts');
        await runExtract(engine, ['links']);
        return { success: true, output: 'Links extracted' };
      }
      case 'zero-timeline': {
        const { runExtract } = await import('./extract.ts');
        await runExtract(engine, ['timeline']);
        return { success: true, output: 'Timeline entries extracted' };
      }
      default:
        return { success: false, output: 'No auto-fix available' };
    }
  } catch (e) {
    return { success: false, output: e instanceof Error ? e.message : String(e) };
  }
}

// --- Main command ---

export async function runFeatures(engine: BrainEngine, args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain features [--json] [--auto-fix]\n\nScan brain usage and recommend unused features.\n\n  --json       Output as JSON (for agents)\n  --auto-fix   Automatically fix all auto-fixable issues');
    return;
  }

  const jsonMode = args.includes('--json');
  const autoFix = args.includes('--auto-fix');

  const scan = await scanFeatures(engine);
  const offers = loadOffers();
  const pitchable = scan.recommendations.filter(r => shouldPitch(r, offers, scan.version));

  if (pitchable.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ ...scan, recommendations: [] }, null, 2));
    } else {
      console.log(`\nBrain score: ${scan.brain_score}/100. All features adopted. Nothing to recommend.`);
    }
    return;
  }

  if (jsonMode) {
    const fixResults: Record<string, { success: boolean; output: string }> = {};
    if (autoFix) {
      for (const rec of pitchable.filter(r => r.auto_fixable)) {
        fixResults[rec.id] = await executeAutoFix(rec, engine);
        offers.accepted[rec.id] = { at: new Date().toISOString().slice(0, 10), version: scan.version };
      }
    }
    console.log(JSON.stringify({ ...scan, recommendations: pitchable, auto_fix_results: autoFix ? fixResults : undefined }, null, 2));
    offers.lastVersion = scan.version;
    offers.lastScan = scan.scan_ts;
    saveOffers(offers);
    return;
  }

  // Human-readable output
  console.log(`\nBrain score: ${scan.brain_score}/100\n`);

  const p1 = pitchable.filter(r => r.priority === 1);
  const p2 = pitchable.filter(r => r.priority === 2);

  if (p1.length > 0) {
    console.log('DATA QUALITY (fix these first):');
    for (const rec of p1) {
      console.log(`  ${rec.title}: ${rec.pitch}`);
      console.log(`    Fix: ${rec.command}`);
    }
    console.log('');
  }

  if (p2.length > 0) {
    console.log('UNUSED FEATURES:');
    for (const rec of p2) {
      console.log(`  ${rec.title}: ${rec.pitch}`);
      console.log(`    Try: ${rec.command}`);
    }
    console.log('');
  }

  if (autoFix) {
    console.log('Running auto-fix...');
    for (const rec of pitchable.filter(r => r.auto_fixable)) {
      const result = await executeAutoFix(rec, engine);
      console.log(`  ${result.success ? 'OK' : 'FAIL'}: ${rec.title} — ${result.output}`);
      offers.accepted[rec.id] = { at: new Date().toISOString().slice(0, 10), version: scan.version };
    }
  } else if (process.stdin.isTTY) {
    console.log(`Run 'gbrain features --auto-fix' to fix all auto-fixable issues.`);
  }

  offers.lastVersion = scan.version;
  offers.lastScan = scan.scan_ts;
  saveOffers(offers);
}

/** Lightweight features teaser for doctor output */
export async function featuresTeaserForDoctor(engine: BrainEngine): Promise<string | null> {
  try {
    const health = await engine.getHealth();
    const parts: string[] = [];
    if (health.missing_embeddings > 0) parts.push(`${health.missing_embeddings} missing embeddings`);
    if (health.dead_links > 0) parts.push(`${health.dead_links} dead links`);
    if (parts.length === 0) return null;
    return `Tip: ${parts.join(', ')}. Run 'gbrain features' to fix.`;
  } catch {
    return null;
  }
}
