/**
 * The #967 / #1776 fixture for the backlinks gap-list parity golden
 * (wave 14 P1.1): several source dirs, duplicate refs within one page,
 * display names that differ from the slug (`ref.name`), a missing target,
 * extension-less and wikilink credit, an `_`-prefixed and a dot-prefixed
 * entry the walker skips, and an unreadable-looking (non-.md) sibling.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeBacklinksParityFixture(root: string): void {
  for (const d of ['people', 'companies', 'meetings', 'notes/deep', '.hidden']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'people/alice.md'), '---\ntitle: "Alice Example"\n---\n\n# Alice\n\nWorks at [Acme](../companies/acme).\n');
  writeFileSync(join(root, 'people/bob.md'), '# Bob\n\nNo links.\n');
  writeFileSync(join(root, 'companies/acme.md'), '# Acme\n\nFounded by [Alice](../people/alice). Standup notes: standup.md\n');
  writeFileSync(join(root, 'companies/widget-co.md'), '# Widget Co\n\nSee [[meetings/offsite]].\n');
  writeFileSync(join(root, 'meetings/standup.md'),
    '---\ntitle: Daily standup\n---\n\nWe discussed [Alice](../people/alice) and [Alice again](people/alice).\n[[people/bob]] joined. [Acme](../companies/acme) was mentioned twice: [ACME Inc](../companies/acme).\n[Ghost](../people/ghost) does not exist.\n');
  writeFileSync(join(root, 'meetings/offsite.md'), '# Offsite\n\n[Widget Co](../companies/widget-co) hosted; [Bob](../people/bob) spoke.\n');
  writeFileSync(join(root, 'notes/deep/idea.md'), '# Idea\n\n[Bobby](../../people/bob) and [[companies/acme]].\n');
  writeFileSync(join(root, 'notes/_draft.md'), '# Draft\n\n[Alice](../people/alice)\n');
  writeFileSync(join(root, '.hidden/secret.md'), '# Secret\n\n[Alice](../people/alice)\n');
  writeFileSync(join(root, 'notes/readme.txt'), '[Alice](../people/alice)\n');
}
