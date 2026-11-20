/**
 * The persistence engine view (persistence/model.ts SqlEngine) carries the two typed access reads a write's caller
 * record needs, readLiveMember and readFolderAccess, so the member lookup (access/caller.ts memberIdentityFor) and the
 * folder access read (folderAccessFor) always go to the typed member and never run their statements over a view's
 * executeRaw.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the member lookup and the folder access read reach the typed member through any view that carries it,
 *    including one with no executeRaw at all; a view that has only executeRaw runs no statement for either read (the
 *    type refuses it, and at run time the folder read fails closed and the member lookup throws).
 *  - Regression: the old fallback ran the member and folder statements over an executeRaw-only view, which a Rust
 *    brain refuses, so a write's caller record read as fail closed on Rust (no member, every folder covered).
 *  - Why existing coverage misses it: the parity cases in engine-parity/write-misc.test.ts call the functions with a
 *    whole engine, which always had the members; no case passed the executeRaw-only view persistence used to hand
 *    them.
 *  - Seam: none; the views are plain objects built here.
 */
import { describe, expect, test } from 'bun:test';
import { folderAccessFor, memberIdentityFor, type FolderAccessEngine, type LiveMemberEngine } from '../src/core/access/caller.ts';
import type { FolderAccessRows, LiveMemberRow, LiveMemberVia } from '../src/core/engine-sql/access-control.ts';
import type { SqlEngine } from '../src/core/persistence/model.ts';

const AUTH = { principal: { kind: 'oauth_client', id: 'client-example' } };

function members() {
  const reads: string[] = [];
  return {
    reads,
    readLiveMember: async (via: LiveMemberVia, param: string): Promise<LiveMemberRow | null> => {
      reads.push(`member ${via} ${param}`);
      return { id: 'alice-example', groups: ['team-a'] };
    },
    readFolderAccess: async (readers: readonly string[]): Promise<FolderAccessRows> => {
      reads.push(`folder ${[...readers].sort().join(',')}`);
      return { rules: [{ source_id: 'default', rule_id: 'r1', readable_by: ['member:alice-example'] }], coverage: [{ source_id: 'default', prefix: 'drafts/' }] };
    },
  };
}

function recordingSql() {
  const statements: string[] = [];
  return { statements, executeRaw: async <T>(sql: string): Promise<T[]> => { statements.push(sql); throw new Error('a Rust brain has no SQL'); } };
}

describe('persistence SqlEngine views carry the caller record reads', () => {
  test('a view with no executeRaw reaches the typed member lookup and folder access read', async () => {
    const view = members();
    const identity = await memberIdentityFor(view, AUTH);
    expect(identity).toContain('member:alice-example');
    expect(identity).toContain('group:team-a');
    expect(await folderAccessFor(view, identity)).toEqual({ satisfiedRuleIds: ['default:r1'], folderCoverage: [{ source_id: 'default', prefix: 'drafts/' }] });
    expect(view.reads).toEqual(['member oauth_client client-example', `folder ${[...identity].sort().join(',')}`]);
  });

  test('a SqlEngine view reads through its members and runs no statement over its executeRaw', async () => {
    const sql = recordingSql();
    const view: SqlEngine = { ...members(), executeRaw: sql.executeRaw };
    const lookup: LiveMemberEngine & FolderAccessEngine = view;
    const identity = await memberIdentityFor(lookup, AUTH);
    expect(identity).toContain('member:alice-example');
    expect((await folderAccessFor(lookup, identity)).satisfiedRuleIds).toEqual(['default:r1']);
    expect(sql.statements).toEqual([]);
  });

  test('an executeRaw-only view runs the member statement only; the folder read has no statement to run', async () => {
    const sql = recordingSql();
    const bare = { executeRaw: sql.executeRaw };
    // A member lookup accepts a narrow executeRaw caller (LiveMemberEngine) and sends its one statement over it.
    await expect(memberIdentityFor(bare, AUTH)).rejects.toThrow();
    expect(sql.statements).toHaveLength(1);
    sql.statements.length = 0;
    // @ts-expect-error an executeRaw-only view is not a folder access engine
    expect(await folderAccessFor(bare, ['member:alice-example'])).toEqual({ satisfiedRuleIds: [], folderCoverage: [{ source_id: '!unreadable', prefix: '' }] });
    expect(sql.statements).toEqual([]);
  });
});
