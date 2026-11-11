/**
 * RESOLVER-style routing tables for the resolver, from one explicit file
 * (no directory discovery). Two row shapes, as `parseResolverEntries` in
 * src/core/check-resolvable.ts reads them:
 *
 *   | trigger text | `skills/<name>/SKILL.md` |      (a table row)
 *   - **<name>**: trigger one | trigger two      (a compact list row)
 *
 * Rows inside the generated skills block and external references
 * (`GStack:`, `Check `, `Read `) are skipped. Each row maps to a skill
 * name; the catalog builder attaches it to the skill with that name (or
 * whose directory has that name). Leaf module.
 */
const SKILLS_BLOCK_BEGIN = '<!-- gbrain:skills:begin -->';
const SKILLS_BLOCK_END = '<!-- gbrain:skills:end -->';

export interface RoutingRow { trigger: string; skill: string }

export function parseRoutingTable(content: string): RoutingRow[] {
  const rows: RoutingRow[] = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let inBlock = false;
  for (const [i, line] of lines.entries()) {
    if (line.trim() === SKILLS_BLOCK_BEGIN && lines.slice(i + 1).some(l => l.trim() === SKILLS_BLOCK_END)) { inBlock = true; continue; }
    if (line.trim() === SKILLS_BLOCK_END) { inBlock = false; continue; }
    if (inBlock) continue;
    if (line.startsWith('|') && !line.includes('---')) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 2) continue;
      const [trigger, target] = cols as [string, string];
      if (trigger.toLowerCase() === 'trigger' || trigger.toLowerCase() === 'skill') continue;
      if (target.startsWith('GStack:') || target.startsWith('Check ') || target.startsWith('Read ')) continue;
      const m = target.match(/`skills\/([^`]+)\/SKILL\.md`/);
      if (m) rows.push({ trigger, skill: m[1]!.split('/').pop()! });
      continue;
    }
    const list = line.match(/^-\s+\*\*([a-z][a-z0-9-]+)\*\*\s*:\s*(.+)$/) ?? line.match(/^-\s+([a-z][a-z0-9-]+)\s*:\s*(.+)$/);
    if (!list) continue;
    const cleaned = list[2]!.trim().replace(/\s*(?:→|->)\s*`skills\/[^`]+`\s*$/, '');
    for (const t of cleaned.split('|').map(s => s.trim()).filter(s => s.length > 0 && s !== '...')) rows.push({ trigger: t, skill: list[1]! });
  }
  return rows;
}
