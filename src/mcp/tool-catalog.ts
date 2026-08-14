/**
 * tool-catalog.ts — renderer for the generated docs/TOOL_CATALOG.md (E6).
 *
 * Config-INDEPENDENT by design: no engine, no config reads, no gate
 * resolution — the catalog is the operations array plus static surface
 * metadata (STARTER_OPS membership, publish-gate keys), rendered through
 * `buildToolDefs`'s non-strict shape so the doc names/describes exactly what
 * a default tools/list emits. Deterministic: no timestamps, stable sort
 * everywhere — the committed doc must byte-match a fresh render
 * (scripts/check-tool-catalog-fresh.sh, wired into `bun run verify`).
 *
 * Non-localOnly ops ONLY: localOnly ops never appear on a network catalog,
 * so documenting them here would recreate the listed-but-uncallable class
 * the honest-catalog wave exists to kill.
 *
 * Area names are NON-CONTRACTUAL (Operation.area, amendment 22) — renaming
 * or regrouping is never a breaking change; the per-op rows are the stable
 * content.
 */

import { operations, type Operation } from '../core/operations.ts';
import { STARTER_OPS } from './surface.ts';
import { buildToolDefs } from './tool-defs.ts';

/** First sentence of a description (up to the first '.', '!' or '?' + space). */
export function firstSentence(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const m = oneLine.match(/^(.*?[.!?])\s/);
  return (m ? m[1] : oneLine).trim();
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

export function renderToolCatalogMarkdown(): string {
  const ops = operations.filter((op) => !op.localOnly);
  const defs = new Map(buildToolDefs(ops).map((d) => [d.name, d]));

  const byArea = new Map<string, Operation[]>();
  for (const op of ops) {
    const area = op.area ?? 'other';
    const list = byArea.get(area) ?? [];
    list.push(op);
    byArea.set(area, list);
  }
  const areas = [...byArea.keys()].sort();

  const lines: string[] = [];
  lines.push('# MCP tool catalog');
  lines.push('');
  lines.push('<!-- GENERATED FILE — do not edit by hand. -->');
  lines.push('<!-- Regenerate: bun run scripts/generate-tool-catalog.ts -->');
  lines.push('<!-- Freshness-guarded by scripts/check-tool-catalog-fresh.sh (bun run verify). -->');
  lines.push('');
  lines.push(
    `Every non-localOnly operation on the MCP surface: ${ops.length} tools across ` +
      `${areas.length} areas. **Starter** marks membership in the ~${STARTER_OPS.size}-op ` +
      '`starter` surface (`src/mcp/surface.ts`); **Gate** names the config key that must be ' +
      'true before remote callers see/call the op (`gbrain config set <key> true`). ' +
      'What a given token actually sees is further filtered per request by scope, ' +
      'bound-client fence, publish gates, and the per-client surface — see ' +
      '`docs/operations/mcp-surface-runbook.md`. Area names are non-contractual groupings.',
  );
  lines.push('');

  for (const area of areas) {
    const areaOps = byArea.get(area)!.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
    lines.push(`## ${area}`);
    lines.push('');
    lines.push('| Tool | Description | Scope | Starter | Gate |');
    lines.push('|---|---|---|---|---|');
    for (const op of areaOps) {
      const def = defs.get(op.name);
      const desc = escapeCell(firstSentence(def?.description ?? op.description));
      const starter = STARTER_OPS.has(op.name) ? 'yes' : '';
      const gate = op.publishGateKey ? `\`${op.publishGateKey}\`` : '';
      lines.push(`| \`${op.name}\` | ${desc} | ${op.scope ?? 'read'} | ${starter} | ${gate} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
