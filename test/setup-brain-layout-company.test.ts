/**
 * GST-2731: `gbrain setup <harness> --shape company` end to end (setup-brain-layout.ts): the company source joins default
 * search only on a one-person brain, the docs folder is read only, and --team creates nothing for the company part.
 * Split from test/setup-brain-layout.test.ts (GST-4082).
 * Shared fixture: test/helpers/setup-brain-layout-box.ts. The authoring gate for the whole suite is in test/setup-brain-layout.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupBoxes, box, setup, gbrain, claudeMd, treeHash, docsDir, sourceIds } from './helpers/setup-brain-layout-box.ts';
import { COMPANY_PAGES } from '../src/commands/setup-brain-layout.ts';

afterAll(cleanupBoxes);

describe('setup --shape company', () => {
  test('a one-person brain gets a company source in default search, its pages, and the docs read only', async () => {
    const b = box();
    const docs = docsDir(b);
    const before = treeHash(docs);
    const r = await setup(b, ['claude-code', '--shape', 'company', '--docs', docs]);
    expect(r.exitCode).toBe(0);
    const layout = r.doc.brain_layout;
    expect(layout.company).toMatchObject({ source: 'company', action: 'created', federated: true });
    expect(layout.company.root.startsWith(join(b.home, '.gbrain'))).toBe(true);
    expect(layout.pages.map((p: any) => [p.slug, p.source, p.action])).toEqual(COMPANY_PAGES.map((p) => [p.slug, 'company', 'write']));
    expect(layout.docs).toMatchObject({ action: 'imported', files: 2 });
    expect(layout.check).toMatchObject({ ok: true, query: 'Onboarding playbook' });
    expect(layout.check.detail).toContain('default search');
    expect(layout.next_question).toContain('what did we decide about Onboarding playbook');
    expect(r.doc.notices.some((n: any) => n.code === 'source_not_in_default_search')).toBe(false);
    expect(treeHash(docs)).toBe(before);
    const md = readFileSync(claudeMd(b), 'utf8');
    expect(md).toContain('company/decisions');
    expect(md).not.toContain('me/facts');
    expect((await gbrain(b, ['get', 'company/facts', '--source', 'company'])).stdout).toContain('status: stub');
    const again = await setup(b, ['claude-code', '--shape', 'company']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.brain_layout.company.action).toBe('kept');
    expect(again.doc.brain_layout.pages.every((p: any) => p.action === 'keep')).toBe(true);
  }, 240_000);

  test('a brain declared shared keeps the company source out of default search and asks the user', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--shape', 'personal'])).exitCode).toBe(0);
    expect((await gbrain(b, ['config', 'set', 'brain.audience', 'shared'])).exitCode).toBe(0);
    const docs = docsDir(b);
    const r = await setup(b, ['claude-code', '--shape', 'both', '--docs', docs]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.company).toMatchObject({ action: 'created', federated: false });
    expect((await sourceIds(b)).find((s) => s.id === 'company').federated).toBe(false);
    const n = r.doc.notices.find((x: any) => x.code === 'source_not_in_default_search');
    expect(n.fix.next).toBe('ask_user');
    expect(n.fix.argv.slice(0, 4)).toEqual(['gbrain', 'sources', 'federate', 'company']);
    expect(r.doc.brain_layout.check.detail).toContain('search of the company source');
    const md = readFileSync(claudeMd(b), 'utf8');
    expect(md).toContain('me/facts');
    expect(md).toContain('company/decisions');
  }, 300_000);

  test('--team writes the personal part, creates nothing for the company part and prints the route', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--shape', 'both', '--team']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.company).toMatchObject({ action: 'team' });
    expect(r.doc.brain_layout.pages.map((p: any) => p.slug)).toEqual(['me/facts', 'me/voice', 'me/how-i-decide']);
    expect((await sourceIds(b)).some((s) => s.id === 'company')).toBe(false);
    expect(r.doc.notices.find((x: any) => x.code === 'brain_layout_team_next').user_message).toContain('gbrain access serves several');
    const md = readFileSync(claudeMd(b), 'utf8');
    expect(md).toContain('me/facts');
    expect(md).not.toContain('company/decisions');
  }, 180_000);
});
