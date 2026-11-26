/**
 * .gstack/pregate.json allowlists gstack's `env.kv` secrets finding on the PGLite snapshot cache-key lines of the
 * workflow files, on the generated operation-loader lines (an operation named like a secret, such as reveal_secret),
 * on five Rust type annotations or match arms that read like `key: &RelationshipKey,` (each scoped to its own file),
 * and on the Rust store landing's lines that read like keys, private-key headers, phone numbers or card numbers (29 more
 * entries, each scoped to one file and anchored at both ends), and nothing else. gstack (lib/pregate/allowlist.ts) tests an entry's pattern anchored at the
 * finding's column in the added line, as `^(?:pattern)(?![\w-])`; for `env.kv` that column is the value after
 * `key: `. This file applies the same anchoring to every cache-key line in .github/workflows (each must be covered)
 * and to secret-shaped values (none may be).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const policy = JSON.parse(readFileSync(join(ROOT, '.gstack/pregate.json'), 'utf8')) as { allowlist: Array<{ finding: string; paths?: string[]; pattern?: string; reason: string }> };
const ORIGINAL = 8; // the allowlist entries before the Rust store landing's: the phone-metadata one, two env.kv ones, five Rust ones
const entries = policy.allowlist.slice(0, ORIGINAL).filter(e => e.finding === 'env.kv');
const LOADERS = 'src/core/operation-loaders.generated.ts';
const entryFor = (path: string) => entries.find(e => e.paths?.includes(path));
const anchored = (pattern: string | undefined, value: string) => new RegExp(`^(?:${pattern})(?![\\w-])`).test(value);
const covers = (value: string) => anchored(entryFor('.github/workflows/*.yml')?.pattern, value);
const coversLoader = (value: string) => anchored(entryFor(LOADERS)?.pattern, value);

const WORKFLOWS = join(ROOT, '.github/workflows');
const cacheKeyValues = readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml')).flatMap(f =>
  readFileSync(join(WORKFLOWS, f), 'utf8').split('\n').flatMap(line => {
    const at = line.indexOf('key: pglite-snapshot');
    return at < 0 ? [] : [line.slice(at + 'key: '.length)];
  }));

describe('pregate allowlist: workflow cache keys', () => {
  test('seven env.kv entries: this one, scoped to workflow files and a pattern, the operation-loader one, and five Rust lines', () => {
    expect(entries).toHaveLength(7);
    expect(entries[0]!.paths).toEqual(['.github/workflows/*.yml']);
    expect(typeof entries[0]!.pattern).toBe('string');
    expect(entries[1]).toEqual({ finding: 'env.kv', paths: [LOADERS], pattern: '\\[load_[a-z0-9_]+, "(?:[a-z][A-Za-z]*Operations|[a-z]+(?:_[a-z]+)+)"\\],?$', reason: expect.any(String) });
  });

  test('every pglite-snapshot cache key in the workflows is covered', () => {
    expect(cacheKeyValues.length).toBeGreaterThan(0);
    for (const value of cacheKeyValues) expect({ value, covered: covers(value) }).toEqual({ value, covered: true });
  });

  test('a secret-shaped value on a key: line is still flagged', () => {
    const hex = ['9f8a7b6c5d4e', '3f2a1b0c9d8e', '7f6a5b4c3d2e1f0a'].join('');
    const pat = ['gh', 'p_', 'Zx9Qw8Lk2Mn4', 'Bv6Cx1Za3Sd5', 'Fg7Hj9Kl0Pq2Wr4'].join('');
    for (const value of [
      `pglite-snapshot-${hex}`,
      'pglite-snapshot-${{ runner.os }}-Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7Hj9Kl0Pq2Wr4',
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts') }}-Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7",
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts', '" + pat.slice(0, -2) + "\\'') }}",
      pat,
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('" + pat + "') }}",
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts', '" + pat + "') }}",
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts', './" + hex + "') }}",
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts', 'src/" + hex + ".ts') }}",
      "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src/*.ts', 'src/Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7Hj9Kl0Pq2Wr4.ts') }}",
    ]) expect({ value, covered: covers(value) }).toEqual({ value, covered: false });
  });

  test('a long ** chain in a hashFiles argument is rejected without backtracking', () => {
    const value = "pglite-snapshot-${{ runner.os }}-${{ hashFiles('src" + '/**'.repeat(26) + "X') }}";
    const started = performance.now();
    expect(covers(value)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('pregate allowlist: generated operation loaders', () => {
  // test-reads-source-ok[generated-artifact]: the allowlist must cover every line the checked-in generated loader table holds.
  const generated = readFileSync(join(ROOT, LOADERS), 'utf8').split('\n').flatMap(line => {
    const at = line.indexOf('[load_');
    return at < 0 ? [] : [line.slice(at)];
  });

  test('every loader line in the generated table is covered, a secret-named operation included', () => {
    expect(generated.length).toBeGreaterThan(0);
    for (const value of generated) expect({ value, covered: coversLoader(value) }).toEqual({ value, covered: true });
    expect(coversLoader('[load_secrets, "secretsOperations"],')).toBe(true);
  });

  test('a credential-shaped value in that file is still flagged', () => {
    const key = ['sk', 'proj', 'Zx9Qw8Lk2Mn4Bv6Cx1Za3Sd5Fg7Hj9Kl0Pq2Wr4'].join('-');
    for (const value of [
      `"${key}"`,
      `[load_secrets, "${key}"],`,
      `[load_secrets, "secretsOperations", "${key}"],`,
      `[load_secrets, "secretsOperations"], "${key}"`,
      `[${key}, "secretsOperations"],`,
      `[load_secrets, "${['AKIA', 'EXAMPLENOTREAL00'].join('')}"],`,
      `[load_secrets, "${['f8a7b6c5d4', 'e3f2a1b0c9'].join('')}"],`,
    ]) expect({ value, covered: coversLoader(value) }).toEqual({ value, covered: false });
  });
});

describe('pregate allowlist: Rust type annotations the secrets check reads as keys', () => {
  const RUST_SRC = 'rust/crates/gbrain-store/src/';
  const secret = ['sk-live-', '0123456789abcdef', '0123456789abcdef'].join('');
  // Each Rust entry covers one line shape in one file: what the check reads as the value, and values that must stay flagged.
  const SHAPES: Array<{ path: string; covered: string[]; flagged: string[] }> = [
    { path: 'link_queries/link_temporal.rs', covered: ['&RelationshipKey,'], flagged: [`"${secret}",`, '&RelationshipKeyX,', '&RelationshipKey, secret'] },
    { path: 'persistence/effect_worker.rs', covered: ['Option<&str>,'], flagged: [`"${secret}",`, 'Option<&str>, x'] },
    { path: 'occ_kv.rs', covered: ['Mutex<HashMap<Vec<u8>, u64>>,'], flagged: [`"${secret}",`, 'Mutex<HashMap<Vec<u8>, u64>>, x'] },
    { path: 'write_attribution.rs', covered: ['Option<PrivacyPolicy>,'], flagged: [`"${secret}",`, 'Option<PrivacyPolicy>, x'] },
    { path: 'cli_reads/reads.rs', covered: [':Char(c) => {'], flagged: [`"${secret}",`, ':Char(c) => { x'] },
  ];
  const rustEntries = entries.slice(2);

  test('five entries, each for one exact file under the store crate, with no glob and no shared path', () => {
    expect(rustEntries).toHaveLength(5);
    expect(rustEntries.map(e => e.paths)).toEqual(SHAPES.map(s => [RUST_SRC + s.path]));
    for (const e of rustEntries) {
      expect(e.paths![0]).not.toContain('*');
      expect(typeof e.pattern).toBe('string');
      expect(e.reason.length).toBeGreaterThan(20);
    }
  });

  // gstack tests an entry's pattern against the added line from the column where the flagged value starts, as
  // `^(?:pattern)(?![\\w-])` (lib/pregate/allowlist.ts): the text before the value is never seen, so a pattern cannot name the
  // key, and `^\\s*token: ...` would match nothing. Anchoring is therefore `^pattern$`: the value starts the match and the
  // line ends it. One case per entry: a quoted credential followed by a comment that holds the annotation is still flagged,
  // because its own finding starts at the quoted value, and the pattern does not match there.
  const TAILS: Array<{ path: string; prefix: string; annotation: string; valueAt: (line: string) => number }> = [
    { path: 'link_queries/link_temporal.rs', prefix: '    key: ', annotation: '&RelationshipKey,', valueAt: l => l.indexOf(': ') + 2 },
    { path: 'persistence/effect_worker.rs', prefix: '    token: ', annotation: 'Option<&str>,', valueAt: l => l.indexOf(': ') + 2 },
    { path: 'occ_kv.rs', prefix: '    by_key: ', annotation: 'Mutex<HashMap<Vec<u8>, u64>>,', valueAt: l => l.indexOf(': ') + 2 },
    { path: 'write_attribution.rs', prefix: '        exclude_private: ', annotation: 'Option<PrivacyPolicy>,', valueAt: l => l.indexOf(': ') + 2 },
    { path: 'cli_reads/reads.rs', prefix: '                    Token::Char(c) => ', annotation: 'Token::Char(c) => {', valueAt: l => l.indexOf(':') + 1 },
  ];
  for (const t of TAILS) {
    test(`${t.path}: a line that only ends with the annotation is not covered at its credential`, () => {
      const pattern = entryFor(RUST_SRC + t.path)!.pattern!;
      expect(pattern.startsWith('^') && pattern.endsWith('$')).toBe(true);
      const line = `${t.prefix}"${secret}", // ${t.annotation}`;
      expect(anchored(pattern, line.slice(t.valueAt(line)))).toBe(false);
      expect(new RegExp(pattern).test(line)).toBe(false);
    });
  }

  test('each entry covers its own annotation and still flags a quoted credential on the same key', () => {
    for (const shape of SHAPES) {
      const entry = entryFor(RUST_SRC + shape.path);
      for (const value of shape.covered) expect({ path: shape.path, value, covered: anchored(entry?.pattern, value) }).toEqual({ path: shape.path, value, covered: true });
      for (const value of shape.flagged) expect({ path: shape.path, value, covered: anchored(entry?.pattern, value) }).toEqual({ path: shape.path, value, covered: false });
    }
  });
});

describe('pregate allowlist: Rust store lines the secrets check reads as keys, private-key headers and phone numbers', () => {
  // One entry per (file, finding) of the Rust store landing's flagged lines. A pattern is tested from the column where the
  // flagged value starts (lib/pregate/allowlist.ts: `^(?:pattern)(?![\\w-])`), so each pattern is `^(?:tail|tail)$` over the
  // exact text from that column to the end of the line. Digit runs and key headers are split in the table below so this
  // file does not trip the check it tests.
  const LINES: Array<{ path: string; finding: string; tails: string[] }> = [
    { path: 'rust/crates/gbrain-napi/src/families/generations.rs', finding: 'env.kv', tails: [
      'Option<String>,',
    ] },
    { path: 'rust/crates/gbrain-store/src/cli_reads/doctor_derived_health.rs', finding: 'pem.private_key', tails: [
      ['-----BEGIN ', 'OPENSSH ', 'PRIVATE KEY-----"'].join(''),
      ['-----BEGIN ', 'RSA ', 'PRIVATE KEY----- y"'].join(''),
    ] },
    { path: 'rust/crates/gbrain-store/src/facts/write_path.rs', finding: 'env.kv', tails: [
      'r.source_session, "created_at": iso(r.created_at_us) })',
    ] },
    { path: 'rust/crates/gbrain-store/src/generations.rs', finding: 'env.kv', tails: [
      '&GenerationKey,',
      'Option<&str>,',
      'String::from_utf8_lossy(&k[prefix.len()..]),',
      'page:notes/a".into(),',
      'record.owner_key,',
    ] },
    { path: 'rust/crates/gbrain-store/src/generations/activations.rs', finding: 'env.kv', tails: [
      '&GenerationKey,',
      '(*item).into(),',
      'record.owner_key,',
    ] },
    { path: 'rust/crates/gbrain-store/src/generations/fence_evidence.rs', finding: 'env.kv', tails: [
      '&GenerationKey,',
    ] },
    { path: 'rust/crates/gbrain-store/src/generations/fence_restore.rs', finding: 'env.kv', tails: [
      '(*item_key).into(),',
      'String::from_utf8_lossy(&k[prefix.len()..]),',
    ] },
    { path: 'rust/crates/gbrain-store/src/generations/repair.rs', finding: 'env.kv', tails: [
      'Option<&\'a str>,',
      'String::from_utf8_lossy(&k[prefix.len()..]),',
      'format!("walk/{owner}"),',
      'record.owner_key,',
    ] },
    { path: 'rust/crates/gbrain-store/src/link_queries/link_temporal.rs', finding: 'env.kv', tails: [
      'Option<&\'a PrivacyPolicy>,',
    ] },
    { path: 'rust/crates/gbrain-store/src/pages.rs', finding: 'env.kv', tails: [
      'remote.then(|| crate::facts::PrivacyPolicy {',
    ] },
    { path: 'rust/crates/gbrain-store/src/persistence/op_checkpoint.rs', finding: 'env.kv', tails: [
      'Vec<u8>,',
    ] },
    { path: 'rust/crates/gbrain-store/src/persistence/publication.rs', finding: 'env.kv', tails: [
      'Option<String>,',
    ] },
    { path: 'rust/crates/gbrain-store/src/persistence/worktree_admission.rs', finding: 'env.kv', tails: [
      '&WorktreeAdmissionKey,',
    ] },
    { path: 'rust/crates/gbrain-store/src/shared_skill_members.rs', finding: 'env.kv', tails: [
      'b.token,',
      'b.view_token,',
    ] },
    { path: 'rust/crates/gbrain-store/src/shared_skill_publication.rs', finding: 'env.kv', tails: [
      'Vec<u8>,',
    ] },
    { path: 'rust/crates/gbrain-store/src/trust/belief_events.rs', finding: 'env.kv', tails: [
      'Option<Vec<u8>>,',
      'need(&r.subject_key, "subject_key")?,',
    ] },
    { path: 'rust/crates/gbrain-store/src/trust/belief_history.rs', finding: 'env.kv', tails: [
      'e.subject_key,',
      'later_private,',
    ] },
    { path: 'rust/crates/gbrain-store/src/trust/belief_redactions.rs', finding: 'env.kv', tails: [
      'need(&row.subject_key, "subject_key")?,',
      'r.subject_key,',
    ] },
    { path: 'rust/crates/gbrain-store/tests/cli_reads_doctor_derived_health.rs', finding: 'pem.private_key', tails: [
      ['-----BEGIN ', 'PRIVATE KEY-----\\n"],'].join(''),
      ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----\\nabc\\n-----END RSA ', 'PRIVATE KEY-----";'].join(''),
    ] },
    { path: 'rust/crates/gbrain-store/tests/cli_reads_doctor_derived_health.rs', finding: 'pii.cc', tails: [
      ['00000000', '00000000", "extracted_at": "2026-03-04T00:00:00Z" }),'].join(''),
    ] },
    { path: 'rust/crates/gbrain-store/tests/cli_reads_doctor_derived_health.rs', finding: 'pii.phone.e164', tails: [
      ['1111-4111-8111-111111', '111111");'].join(''),
      ['111111', '111111");'].join(''),
      ['4444-4444-8444-444444', '444444");'].join(''),
      ['444444', '444444");'].join(''),
    ] },
    { path: 'rust/crates/gbrain-store/tests/cli_reads_ops.rs', finding: 'pii.phone.e164', tails: [
      '+1 (415) 555-0100"}),',
      ['14155', '550100"]), false),'].join(''),
      ['14155', '550100"]), true).is_empty());'].join(''),
      ['415.555.0199", 41555', '50142_i64]));'].join(''),
      ['415.555.0199", 41555', '50142_i64], "email": "bob@example.com"}),'].join(''),
    ] },
    { path: 'rust/crates/gbrain-store/tests/cli_reads_ops.rs', finding: 'pii.phone.e164', tails: [
      ['41555', '50100"]), false).is_empty());'].join(''),
      ['41555', '50142"]), false), ["people/bob-example"]);'].join(''),
      ['41555', '50199"]),'].join(''),
      ['41555', '50199"]), false), ["people/bob-example"]);'].join(''),
    ] },
    { path: 'rust/crates/gbrain-store/tests/cli_reads_sweep_reads.rs', finding: 'pii.phone.e164', tails: [
      ['1111-4111-8111-111111', '111111");'].join(''),
      ['111111', '111111");'].join(''),
      ['4444-4444-8444-444444', '444444");'].join(''),
      ['444444', '444444");'].join(''),
    ] },
    { path: 'rust/crates/gbrain-store/tests/generation_atom_reads.rs', finding: 'env.kv', tails: [
      'format!("input:{id}"),',
    ] },
    { path: 'rust/crates/gbrain-store/tests/jobs_wake.rs', finding: 'env.kv', tails: [
      'client-A",',
    ] },
    { path: 'rust/crates/gbrain-store/tests/owner_only_pages.rs', finding: 'env.kv', tails: [
      'Some(PrivacyPolicy {',
    ] },
    { path: 'rust/crates/gbrain-store/tests/relational_reads.rs', finding: 'env.kv', tails: [
      'Some(PrivacyPolicy {',
    ] },
    { path: 'rust/crates/gbrain-store/tests/repair_plan_scans.rs', finding: 'pii.phone.e164', tails: [
      ['1111-4111-8111-111111', '111111");'].join(''),
      ['111111', '111111");'].join(''),
      ['4444-4444-8444-444444', '444444"), "sourceId": "default",'].join(''),
      ['444444', '444444"), "sourceId": "default",'].join(''),
    ] },
  ];
  const added = policy.allowlist.slice(ORIGINAL, ORIGINAL + LINES.length);
  const secret = ['sk-live-', '0123456789abcdef', '0123456789abcdef'].join('');
  const pemBody = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----', ' probe body that is not a key'].join('');
  const phone = ['+1 (415) ', '555', '-0100'].join('');

  test('one entry per file and finding (a long list takes two), in order, each for one exact path with no glob and a pattern anchored at both ends', () => {
    expect(added).toHaveLength(LINES.length);
    expect(added.map(e => ({ finding: e.finding, paths: e.paths }))).toEqual(LINES.map(l => ({ finding: l.finding, paths: [l.path] })));
    for (const e of added) {
      expect(e.paths![0]).toMatch(/^rust\/crates\/[\w./-]+\.rs$/);
      expect(e.paths![0]).not.toContain('*');
      expect(e.pattern!.startsWith('^') && e.pattern!.endsWith('$')).toBe(true);
      expect(e.reason.length).toBeGreaterThan(20);
    }
  });

  test('only the finding kinds the landing needs: env.kv, pem.private_key, pii.cc and pii.phone.e164', () => {
    expect([...new Set(added.map(e => e.finding))].sort()).toEqual(['env.kv', 'pem.private_key', 'pii.cc', 'pii.phone.e164']);
  });

  for (const [index, line] of LINES.entries()) {
    test(`${line.path} (${line.finding}, entry ${index + 1}): covers its ${line.tails.length} tail(s) and nothing a credential could ride on`, () => {
      const entry = added[index]!;
      for (const tail of line.tails) {
        expect({ tail, covered: anchored(entry.pattern, tail) }).toEqual({ tail, covered: true });
        // The same text followed by anything, or led by anything, or a quoted credential before it, is not covered.
        for (const probe of [`${tail} x`, `x${tail}`, `${tail}${secret}`, `"${secret}", ${tail}`, `"${secret}", // ${tail}`, `${pemBody}`, `"${phone}"}),`])
          expect({ tail, probe, covered: anchored(entry.pattern, probe) }).toEqual({ tail, probe, covered: false });
      }
      expect(new RegExp(entry.pattern!).test(`"${secret}", // ${line.tails[0]}`)).toBe(false);
    });
  }

  test('the standalone bench crate has a declared empty lane, as scripts/bench does, and no other new lane', () => {
    const deps = (policy as unknown as { dependencies: Record<string, string[]> }).dependencies;
    expect(deps['rust/concurrency-bench/**']).toEqual([]);
    expect(deps['scripts/bench/**']).toEqual([]);
    expect(Object.keys(deps).filter(k => k.includes('concurrency-bench'))).toEqual(['rust/concurrency-bench/**']);
  });
});

describe('pregate allowlist: the persistence journal claim statement (for the RP2 landing, rust-engine/land-rp2)', () => {
  // `CLAIM_STAMP_SQL` in src/core/engine-sql/persistence-journal.ts has a line `execution_token=$2::uuid,claim_expires_at=...`:
  // the secrets check reads the column assignment as a secret-named key with a random-looking value. The one entry is
  // for that file and that line's text from the flagged column (the value after `execution_token=`) to the line end.
  const FILE = 'src/core/engine-sql/persistence-journal.ts';
  const TAIL = "$2::uuid,claim_expires_at=now()+($3::double precision*interval '1 millisecond'),";
  const secret = ['sk-live-', '0123456789abcdef', '0123456789abcdef'].join('');
  const pemBody = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----', ' probe body that is not a key'].join('');
  const rows = policy.allowlist.filter(e => e.paths?.includes(FILE));
  const entry = rows[0]!;

  test('exactly one entry for the file, env.kv, one exact path, no glob, anchored at both ends, and nothing after the Rust entries', () => {
    expect(policy.allowlist).toHaveLength(ORIGINAL + 29 + 1);
    expect(policy.allowlist[policy.allowlist.length - 1]).toBe(entry);
    expect(rows).toHaveLength(1);
    expect(entry.finding).toBe('env.kv');
    expect(entry.paths).toEqual([FILE]);
    expect(entry.pattern!.startsWith('^') && entry.pattern!.endsWith('$')).toBe(true);
    expect(entry.reason.length).toBeGreaterThan(20);
  });

  test('covers the flagged value of the claim line and nothing a credential could ride on', () => {
    expect({ tail: TAIL, covered: anchored(entry.pattern, TAIL) }).toEqual({ tail: TAIL, covered: true });
    for (const probe of [
      `${TAIL} x`, `x${TAIL}`, `${TAIL}${secret}`, `"${secret}", ${TAIL}`, `"${secret}", // ${TAIL}`, `${TAIL} // "${secret}"`,
      `$2::uuid,claim_expires_at=now(),`, `"${secret}",`, pemBody, `'${secret}'`,
    ]) expect({ probe, covered: anchored(entry.pattern, probe) }).toEqual({ probe, covered: false });
    expect(new RegExp(entry.pattern!).test(`execution_token="${secret}",claim_expires_at=now(),`)).toBe(false);
  });
});
