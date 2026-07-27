/**
 * v0.36.1.0 (T15 / D23) — server-rendered SVG charts for the admin SPA.
 *
 * Pure functions: data → SVG string. No DOM, no React, no chart library.
 * Admin tab fetches these endpoints and dangerouslySetInnerHTML's the
 * markup inside a TrustedSVG wrapper.
 *
 * Why server-rendered SVG (per D23):
 *   - Chart logic stays close to the data math.
 *   - Zero new client-side chart-library dep.
 *   - SVG is accessible (text labels), scalable, copy-paste-friendly to
 *     PR descriptions and docs.
 *   - Sets the precedent for future admin charts (contradictions trend,
 *     takes scorecard, etc.).
 *
 * Design tokens inlined (must match admin/src/index.css):
 *   --bg-primary: #0a0a0f
 *   --bg-secondary: #14141f
 *   --text-primary: #e0e0e0
 *   --text-secondary: #888
 *   --text-muted: #777   (TD2 bump from #555 for AA contrast)
 *   --accent: #3b82f6
 *
 * XSS posture:
 *   Output is generated server-side from typed inputs. Numeric inputs are
 *   coerced via `.toFixed(...)`. String inputs (pattern statements, abandoned
 *   thread claims) pass through `escapeXml()`. Admin SPA renders via a
 *   sandboxed <div dangerouslySetInnerHTML> wrapper that's gated by
 *   requireAdmin middleware on the endpoint.
 */

/** Min-safe XML attribute / text node escape. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TOKEN = {
  bgPrimary: '#0a0a0f',
  bgSecondary: '#14141f',
  textPrimary: '#e0e0e0',
  textSecondary: '#888',
  textMuted: '#777', // TD2 bump
  accent: '#3b82f6',
} as const;

// ─── Brier trend sparkline ──────────────────────────────────────────

export interface BrierTrendPoint {
  date: string; // ISO YYYY-MM-DD
  brier: number;
}

export interface BrierTrendOpts {
  /** 7 / 30 / 90 / 365 day series, oldest → newest. */
  series: BrierTrendPoint[];
  /** Default 600 x 180 — sized for the admin SPA's single-column flow. */
  width?: number;
  height?: number;
}

export function renderBrierTrend(opts: BrierTrendOpts): string {
  const w = opts.width ?? 600;
  const h = opts.height ?? 180;
  const padL = 40;
  const padR = 16;
  const padT = 20;
  const padB = 28;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  if (opts.series.length === 0) {
    return svgEmpty(w, h, 'No Brier-trend data yet (need 5+ resolved takes)');
  }

  // y-axis: Brier in [0, 0.4]. 0 = perfect; 0.25 = always-50% baseline.
  const yMax = 0.4;
  const xScale = (i: number): number =>
    padL + (opts.series.length === 1 ? plotW / 2 : (i / (opts.series.length - 1)) * plotW);
  const yScale = (brier: number): number => padT + plotH - (Math.min(brier, yMax) / yMax) * plotH;

  const points = opts.series
    .map((p, i) => `${xScale(i).toFixed(1)},${yScale(p.brier).toFixed(1)}`)
    .join(' ');

  // Baseline reference line at Brier=0.25 (always-50%).
  const baselineY = yScale(0.25).toFixed(1);

  const labels: string[] = [];
  // X-axis: first + last date.
  if (opts.series.length >= 2) {
    const first = opts.series[0]!;
    const last = opts.series[opts.series.length - 1]!;
    labels.push(
      `<text x="${padL}" y="${h - 8}" font-size="11" fill="${TOKEN.textMuted}">${escapeXml(first.date)}</text>`,
      `<text x="${w - padR}" y="${h - 8}" font-size="11" fill="${TOKEN.textMuted}" text-anchor="end">${escapeXml(last.date)}</text>`,
    );
  }
  // Y-axis: 0.0 / 0.2 / 0.4 labels.
  for (const y of [0, 0.2, 0.4]) {
    labels.push(
      `<text x="${padL - 6}" y="${yScale(y).toFixed(1) + 4}" font-size="11" fill="${TOKEN.textMuted}" text-anchor="end">${y.toFixed(1)}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Brier trend">
  <rect width="${w}" height="${h}" fill="${TOKEN.bgPrimary}"/>
  <text x="${padL}" y="14" font-size="12" fill="${TOKEN.textSecondary}">Brier (lower is better)</text>
  <line x1="${padL}" y1="${baselineY}" x2="${w - padR}" y2="${baselineY}" stroke="${TOKEN.textMuted}" stroke-dasharray="2,3" stroke-width="1"/>
  <polyline points="${points}" fill="none" stroke="${TOKEN.accent}" stroke-width="2"/>
  ${labels.join('\n  ')}
</svg>`;
}

// ─── Per-domain accuracy bars ───────────────────────────────────────

export interface DomainBar {
  /** Display label, e.g. "macro tech". */
  label: string;
  /** accuracy in [0,1]. */
  accuracy: number;
  /** Sample size for this domain. */
  n: number;
}

export interface DomainBarsOpts {
  bars: DomainBar[];
  width?: number;
  /** Per-bar row height. Total height = bars.length * rowH + topPad. */
  rowHeight?: number;
}

export function renderDomainBars(opts: DomainBarsOpts): string {
  const w = opts.width ?? 600;
  const rowH = opts.rowHeight ?? 28;
  const padL = 140;
  const padR = 50;
  const padT = 24;
  const h = padT + opts.bars.length * rowH + 12;

  if (opts.bars.length === 0) {
    return svgEmpty(w, 60, 'No per-domain scorecard data yet');
  }

  const plotW = w - padL - padR;
  const rows = opts.bars.map((bar, i) => {
    const y = padT + i * rowH;
    const barW = Math.max(0, Math.min(1, bar.accuracy)) * plotW;
    const accPct = `${(bar.accuracy * 100).toFixed(0)}%`;
    return `
  <text x="${padL - 8}" y="${y + 18}" font-size="12" fill="${TOKEN.textPrimary}" text-anchor="end">${escapeXml(bar.label)}</text>
  <rect x="${padL}" y="${y + 6}" width="${plotW.toFixed(1)}" height="16" fill="${TOKEN.bgSecondary}" />
  <rect x="${padL}" y="${y + 6}" width="${barW.toFixed(1)}" height="16" fill="${TOKEN.accent}" />
  <text x="${padL + plotW + 6}" y="${y + 18}" font-size="11" fill="${TOKEN.textMuted}">${accPct} · n=${bar.n}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Per-domain accuracy">
  <rect width="${w}" height="${h}" fill="${TOKEN.bgPrimary}"/>
  <text x="${padL - 8}" y="${padT - 8}" font-size="12" fill="${TOKEN.textSecondary}" text-anchor="end">Per-domain accuracy</text>${rows.join('')}
</svg>`;
}

// ─── Abandoned threads card ─────────────────────────────────────────

export interface AbandonedThread {
  takeId: number;
  pageSlug: string;
  claim: string;
  /** Months since last revisit. */
  monthsSilent: number;
  conviction: number;
  /** D30 (TD4) — revisit-now link target. Default: /admin/calibration/revisit/<takeId>. */
  revisitHref?: string;
}

export function renderAbandonedThreadsCard(threads: AbandonedThread[], width = 600): string {
  const padT = 24;
  const rowH = 44;
  const h = padT + Math.max(threads.length, 1) * rowH + 12;

  if (threads.length === 0) {
    return svgEmpty(width, 80, 'No abandoned high-conviction threads — clean slate');
  }

  const rows = threads.map((t, i) => {
    const y = padT + i * rowH;
    // Truncate claim for SVG layout — full claim shown in admin via tooltip
    // (admin SPA renders the SVG, then layers HTML tooltips). Server side
    // can't measure text width so we cap at 70 chars.
    const claim = t.claim.length > 70 ? t.claim.slice(0, 70) + '…' : t.claim;
    const meta = `conviction ${t.conviction.toFixed(2)} · ${t.monthsSilent} months silent`;
    const href = t.revisitHref ?? `/admin/calibration/revisit/${t.takeId}`;
    return `
  <text x="16" y="${y + 16}" font-size="13" fill="${TOKEN.textPrimary}">${escapeXml(claim)}</text>
  <text x="16" y="${y + 32}" font-size="11" fill="${TOKEN.textMuted}">${escapeXml(meta)}</text>
  <a href="${escapeXml(href)}"><text x="${width - 16}" y="${y + 24}" font-size="11" fill="${TOKEN.accent}" text-anchor="end">revisit now</text></a>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" role="img" aria-label="Abandoned threads">
  <rect width="${width}" height="${h}" fill="${TOKEN.bgPrimary}"/>
  <text x="16" y="${padT - 8}" font-size="12" fill="${TOKEN.textSecondary}">You committed to these and never revisited</text>${rows.join('')}
</svg>`;
}

// ─── Pattern statements card ────────────────────────────────────────

export interface PatternStatementsCardItem {
  text: string;
  /** D29 (TD3) — clickable drill-down. Default: /admin/calibration/pattern/<index>. */
  drillHref?: string;
}

export function renderPatternStatementsCard(
  statements: PatternStatementsCardItem[],
  width = 600,
): string {
  const padT = 24;
  const rowH = 36;
  const h = padT + Math.max(statements.length, 1) * rowH + 12;
  if (statements.length === 0) {
    return svgEmpty(width, 60, 'No active patterns yet');
  }
  const rows = statements.map((s, i) => {
    const y = padT + i * rowH;
    const txt = s.text.length > 90 ? s.text.slice(0, 90) + '…' : s.text;
    const href = s.drillHref ?? `/admin/calibration/pattern/${i + 1}`;
    return `
  <a href="${escapeXml(href)}"><text x="16" y="${y + 22}" font-size="14" fill="${TOKEN.textPrimary}">${escapeXml(txt)}</text></a>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" role="img" aria-label="Calibration pattern statements">
  <rect width="${width}" height="${h}" fill="${TOKEN.bgPrimary}"/>
  <text x="16" y="${padT - 8}" font-size="12" fill="${TOKEN.textSecondary}">Active patterns (click to drill down)</text>${rows.join('')}
</svg>`;
}

// ─── helpers ────────────────────────────────────────────────────────

function svgEmpty(w: number, h: number, message: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Empty chart">
  <rect width="${w}" height="${h}" fill="${TOKEN.bgPrimary}"/>
  <text x="${w / 2}" y="${h / 2}" font-size="12" fill="${TOKEN.textMuted}" text-anchor="middle">${escapeXml(message)}</text>
</svg>`;
}
