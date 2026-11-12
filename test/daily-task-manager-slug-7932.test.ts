/**
 * #7932 — daily-task-manager names the task page by its slug, `ops/tasks`, in
 * every page-tool call. The page tools do an exact slug lookup, so
 * `get_page("ops/tasks.md")` missed the existing `ops/tasks` page, and the
 * skill's first-run rule could then start a second list at slug
 * `ops/tasks.md` that sync, `resolveTodayTasks()` and `gbrain get ops/tasks`
 * never read. Checked in the source skill and both generated copies.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const COPIES = [
  'skills/daily-task-manager/SKILL.md',
  'plugin/skills/daily-task-manager/SKILL.md',
  'plugin-variants/gbrain-daily/skills/daily-task-manager/SKILL.md',
];

describe('#7932: daily-task-manager page-tool calls use the slug ops/tasks', () => {
  for (const rel of COPIES) {
    test(rel, () => {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      expect(text).not.toMatch(/(?:get_page|put_page)\(\s*"[^"]*\.md"/);
      expect(text).toContain('get_page("ops/tasks")');
      expect(text).toContain('put_page("ops/tasks"');
      expect(text).toContain('page: "ops/tasks"');
      expect(text).not.toMatch(/always `ops\/tasks\.md` \(with extension\) in tool calls/);
    });
  }
});
