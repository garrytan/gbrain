/**
 * A withdrawal's companion pages pass the knowledge publication guard the request's own page passes. A forget strikes
 * the claim in the file of every page carrying it (forget-prepare.ts companions); before the fix only the request's own
 * page was screened, so a forget rewrote a file of an adopted shared skillpack that a direct page write is refused
 * (skill_bundle_required) and left the catalog describing bytes no longer on disk. Drives the real put_page, remember
 * and forget handlers on a PGLite managed brain with a really adopted pack.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { adoptSharedSkillpack } from '../src/core/shared-skills/publication.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const CLAIM = 'Keeps a rooftop beehive skillguard';
const OTHER = 'Moved the hives indoors skillguard';
const SKILL_PAGE = 'skills/alpha/notes';
const fence = (rows: string[]) => ['<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|', ...rows, '<!--- gbrain:facts:end -->'].join('\n');
/** CLAIM superseded by OTHER: no active entity-linked copy, so forgetting the unlinked copy reaches this page. */
const SUPERSEDED = [`| 1 | ~~${CLAIM}~~ | fact | 1.0 | world | medium | 2026-01-01 | 2026-02-01 | test | superseded by #2 |`,
  `| 2 | ${OTHER} | fact | 1.0 | world | medium | 2026-02-01 |  | test |  |`];
const skillNotes = `---\ntype: note\ntitle: Alpha notes\n---\n\nNotes.\n\n## Facts\n\n${fence(SUPERSEDED)}\n`;
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), wait_ms: 30_000, ...params }) as Promise<Record<string, any>>;
const setup = ({ root }: { root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n');
  writeFileSync(join(root, 'skillpack.json'), JSON.stringify({ api_version: 'gbrain-skillpack-v1', name: 'example-pack', version: '1.0.0',
    description: 'Synthetic fixture', author: 'Example Maintainer', license: 'MIT', homepage: 'https://example.com/skills',
    gbrain_min_version: '0.51.0', brain_resident: true, skills: ['skills/alpha'] }));
  durableGitRepo(root, ['.gitignore', 'skillpack.json']);
};

describe('forget companions and the shared skillpack', () => {
  test('a forget whose companion page is an adopted skillpack file is refused skill_bundle_required; the file and catalog stay', () => managedBrain(async ({ engine, ctx, root }) => {
    expect(await call(ctx, 'put_page', { slug: SKILL_PAGE, content: skillNotes })).toMatchObject({ state: 'committed' });
    await setSharedSkillPolicy(ctx, 'default', { version: 1, enabled: true, classes: ['prose'], audiences: ['readers'], requirements: [], allow_follow: true }, null);
    const adopted = await adoptSharedSkillpack(ctx, 'default', { request_id: randomUUID(), pack_id: 'example-pack', skills: [
      { pack_id: 'example-pack', name: 'alpha', expected_revision: null, files: [
        { path: 'skills/alpha/SKILL.md', content: '---\nname: alpha\ndescription: A synthetic shared skill\n---\n\nApproved instructions.\n', file_class: 'prose' },
      ] },
    ] });
    expect(adopted.receipts[0].state).toBe('committed');
    const skillFile = join(root, `${SKILL_PAGE}.md`);
    const before = readFileSync(skillFile, 'utf8');
    const catalog = () => engine.executeRaw("SELECT name,revision FROM shared_skill_heads WHERE source_id='default' ORDER BY name");
    const heads = await catalog();
    // A direct write to the page is refused by the knowledge guard.
    await expect(call(ctx, 'put_page', { slug: SKILL_PAGE, content: skillNotes.replace('Notes.', 'Edited.') }))
      .rejects.toMatchObject({ code: 'skill_bundle_required' });
    expect(await call(ctx, 'remember', { fact: CLAIM, provenance: 'test', visibility: 'world', infer_entity: false })).toMatchObject({ state: 'committed', entity_slug: null });
    const [fact] = await engine.executeRaw<{ id: number }>(
      "SELECT id FROM facts WHERE source_id='default' AND entity_slug IS NULL AND fact=$1 AND expired_at IS NULL", [CLAIM]);
    await expect(call(ctx, 'forget', { id: String(fact!.id) })).rejects.toMatchObject({ detail: 'skill_bundle_required' });
    expect(readFileSync(skillFile, 'utf8')).toBe(before);
    expect(await catalog()).toEqual(heads);
    expect(await engine.executeRaw("SELECT 1 FROM fact_withdrawals WHERE source_id='default' AND fact_hash=gbrain_fact_fingerprint($1)", [CLAIM])).toHaveLength(0);
  }, { setup }), 180_000);
});
