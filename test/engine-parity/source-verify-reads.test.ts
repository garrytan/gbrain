/**
 * BrainEngine parity: the two source reads `gbrain files` makes, `sourceIdExists` (the file_upload and file_register
 * operations check the named source) and `readSourceLocalPathForVerify` (`gbrain files verify` reads the checkout).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `sourceIdExists` is true for a source whatever its checkout, archive state or config, and false for an
 *    id no source has (the empty id included). `readSourceLocalPathForVerify` answers the stored checkout path, and
 *    null when the source has none, has an empty one, or does not exist.
 *  - Regression: an engine that does not serve these reads drops the `sources` class from `engine.capabilities`
 *    (servedCapabilities() withholds a class when one of its members is unserved), so the Rust engine stopped
 *    reporting `sources` and `config`. An engine that treats an empty path as a path hands `files verify` a directory
 *    it cannot read, and one that hides an archived source makes `files upload` refuse a source that exists.
 *  - Why existing coverage misses it: files-ops-sites.test.ts reads these two members after the other files
 *    statements in one case, so on the Rust arm it stops at an earlier unserved member and never reaches them.
 *  - Seam: none. Sources come from the harness fixture (createSource, archiveSource).
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: the source reads of the files commands', () => {
  parityTest('sourceIdExists is true for every stored source, archived or not, and false for an id nobody has', {
    methods: ['sourceIdExists'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'with-path', { kind: 'git' }, '/var/brain/with-path');
    await createSource(engine, backend, 'no-path');
    await createSource(engine, backend, 'retired');
    await archiveSource(engine, backend, 'retired');
    const out = {
      default: await engine.sourceIdExists('default'),
      withPath: await engine.sourceIdExists('with-path'),
      noPath: await engine.sourceIdExists('no-path'),
      archived: await engine.sourceIdExists('retired'),
      missing: await engine.sourceIdExists('never-made'),
      empty: await engine.sourceIdExists(''),
      prefix: await engine.sourceIdExists('with'),
      otherCase: await engine.sourceIdExists('With-Path'),
    };
    expect(out).toEqual({ default: true, withPath: true, noPath: true, archived: true, missing: false, empty: false, prefix: false, otherCase: false });
    return out;
  });

  parityTest('readSourceLocalPathForVerify answers the checkout path, and null for none, an empty one or an unknown source', {
    methods: ['readSourceLocalPathForVerify'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'with-path', {}, '/var/brain/with-path');
    await createSource(engine, backend, 'no-path');
    await createSource(engine, backend, 'empty-path', {}, '');
    await createSource(engine, backend, 'retired', {}, '/var/brain/retired');
    await archiveSource(engine, backend, 'retired');
    const out = {
      withPath: await engine.readSourceLocalPathForVerify('with-path'),
      noPath: await engine.readSourceLocalPathForVerify('no-path'),
      emptyPath: await engine.readSourceLocalPathForVerify('empty-path'),
      archived: await engine.readSourceLocalPathForVerify('retired'),
      missing: await engine.readSourceLocalPathForVerify('never-made'),
      empty: await engine.readSourceLocalPathForVerify(''),
      default: await engine.readSourceLocalPathForVerify('default'),
    };
    expect(out).toEqual({ withPath: '/var/brain/with-path', noPath: null, emptyPath: null, archived: '/var/brain/retired', missing: null, empty: null, default: null });
    return out;
  });
});
