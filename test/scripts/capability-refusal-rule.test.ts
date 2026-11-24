/**
 * The capability-refusal rule (scripts/capability-refusal-rule.ts) for the silent read-catch guard.
 *
 * Protects: a catch around a raw-SQL engine call must rethrow a Rust capability refusal before its
 * fallback, so a Rust brain reports a read it cannot serve instead of answering "nothing".
 * Regression it catches: a matcher that misses `.catch(() => [])` or a try/catch fallback, or that
 * flags a handler which already rethrows (a false failure the guard would baseline for ever).
 * It also catches a matcher that misses a raw-SQL call reached through a promise a callback hands
 * back, or a fallback returned from a loop or block before the refusal check.
 * No existing coverage: the rule is new; the guard it plugs into has its own rules and fixtures.
 * Seam: none. The sites are built from source text the way the guard's visitor builds them.
 */
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { CAPABILITY_REFUSAL_RULE, type CapabilityRefusalSite } from '../../scripts/capability-refusal-rule.ts';

/** Every try/catch and `.catch(fn)` site in `text`, shaped as the guard shapes them. */
function sites(text: string, fileName = 'src/core/example.ts'): CapabilityRefusalSite[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: CapabilityRefusalSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && ts.isTryStatement(node.parent)) {
      const v = node.variableDeclaration;
      out.push({ kind: 'try-catch', guarded: node.parent.tryBlock, handlerStatements: node.block.statements, sourceFile: sf,
        errorName: v && ts.isIdentifier(v.name) ? v.name.text : undefined });
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch'
      && node.arguments.length === 1 && (ts.isArrowFunction(node.arguments[0]!) || ts.isFunctionExpression(node.arguments[0]!))) {
      const fn = node.arguments[0] as ts.ArrowFunction | ts.FunctionExpression;
      const p = fn.parameters[0];
      out.push({ kind: 'promise-catch', guarded: node.expression.expression, sourceFile: sf,
        handlerStatements: ts.isBlock(fn.body) ? fn.body.statements : [ts.factory.createReturnStatement(fn.body)],
        errorName: p && ts.isIdentifier(p.name) ? p.name.text : undefined });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const flagged = (text: string, fileName?: string): number => sites(text, fileName).filter(CAPABILITY_REFUSAL_RULE.matcher).length;

describe('capability-refusal rule', () => {
  test('flags a try/catch fallback around a raw-SQL call', () => {
    expect(flagged(`async function f(engine) { try { return await engine.executeRaw('SELECT 1'); } catch { return []; } }`)).toBe(1);
    expect(flagged(`async function f(engine) { try { await engine.executeRaw('SELECT 1'); } catch (err) { console.warn(err); return null; } }`)).toBe(1);
  });

  test('flags a promise .catch fallback around a raw-SQL call', () => {
    expect(flagged(`const rows = await engine.executeRaw('SELECT 1').catch(() => []);`)).toBe(1);
    expect(flagged(`const rows = await engine.executeRaw('SELECT 1').then(r => r.length).catch(err => { log(err); return 0; });`)).toBe(1);
  });

  test('flags a handler that tests for the refusal and still falls back', () => {
    expect(flagged(`async function f(e) { try { await e.executeRaw('x'); } catch (err) { if (isEngineCapabilityRefusal(err)) return null; return []; } }`)).toBe(1);
    expect(flagged(`async function f(e) { try { await e.executeRaw('x'); } catch (err) { if (bad) return []; rethrowCapabilityRefusal(err); return []; } }`)).toBe(1);
  });

  test('passes handlers that let the refusal through first', () => {
    const ok = [
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { rethrowCapabilityRefusal(err); return []; } }`,
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { console.warn(err); rethrowCapabilityRefusal(err); return []; } }`,
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { if (isEngineCapabilityRefusal(err)) throw err; return []; } }`,
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { if (isEngineCapabilityRefusal(err) || other(err)) { throw err; } return []; } }`,
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { throw new Error('read failed', { cause: err }); } }`,
      `const r = await e.executeRaw('x').catch(err => nullUnlessCapabilityRefusal(err));`,
      `const r = await e.executeRaw('x').catch(err => { rethrowCapabilityRefusal(err); return []; });`,
      `const r = await e.executeRawJsonb('x', [{}]).catch(err => { throw err; });`,
    ];
    for (const text of ok) expect({ text, n: flagged(text) }).toEqual({ text, n: 0 });
  });

  test('a helper call on another value does not count as rethrowing the caught error', () => {
    expect(flagged(`async function f(e) { try { await e.executeRaw('x'); } catch (err) { rethrowCapabilityRefusal(last); return []; } }`)).toBe(1);
  });

  test('ignores catches with no raw-SQL call of their own', () => {
    expect(flagged(`async function f(e) { try { return await e.getPage('a'); } catch { return null; } }`)).toBe(0);
    // The call runs inside a callback, not inside the try.
    expect(flagged(`function f(e) { try { schedule(() => e.executeRaw('x')); } catch { return null; } }`)).toBe(0);
    expect(flagged(`async function f(e) { try { const g = async () => e.executeRaw('x'); return null; } catch { return null; } }`)).toBe(0);
  });

  test('flags a raw-SQL call reached through a promise a callback hands back', () => {
    const swallowed = [
      `async function f(e, ids) { try { return await e.transaction(tx => Promise.all(ids.map(id => tx.executeRaw('x', [id])))); } catch { return []; } }`,
      `const r = await e.transaction(tx => Promise.all(ids.map(id => tx.executeRaw('x', [id])))).catch(() => []);`,
      `async function f(e) { try { await e.transaction(async tx => { await tx.executeRaw('x'); }); } catch { return null; } }`,
      `async function f(e) { try { const rows = await withLock(function () { return e.executeRawJsonb('x', [{}]); }); return rows; } catch { return null; } }`,
    ];
    for (const text of swallowed) expect({ text, n: flagged(text) }).toEqual({ text, n: 1 });
    const ok = [
      `async function f(e, ids) { try { return await e.transaction(tx => Promise.all(ids.map(id => tx.executeRaw('x', [id])))); } catch (err) { rethrowCapabilityRefusal(err); return []; } }`,
      // Nothing awaits the callback's promise, so its failure never reaches this catch.
      `function f(e) { try { schedule(async () => { await e.executeRaw('x'); }); } catch { return null; } }`,
      `function f(e) { try { const job = later(() => e.executeRaw('x')); job.start(); } catch { return null; } }`,
    ];
    for (const text of ok) expect({ text, n: flagged(text) }).toEqual({ text, n: 0 });
  });

  test('flags a fallback returned on any path before the refusal check', () => {
    const swallowed = [
      `async function f(e, xs) { try { await e.executeRaw('x'); } catch (err) { for (const x of xs) { if (x) return []; } rethrowCapabilityRefusal(err); return []; } }`,
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { { return []; } rethrowCapabilityRefusal(err); } }`,
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { while (retry()) return []; if (isEngineCapabilityRefusal(err)) throw err; return []; } }`,
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { switch (mode) { case 'quiet': return []; } rethrowCapabilityRefusal(err); return []; } }`,
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { out: { if (quiet) return null; break out; } rethrowCapabilityRefusal(err); return null; } }`,
      `const r = await e.executeRaw('x').catch(err => { for (const x of xs) return x; rethrowCapabilityRefusal(err); return []; });`,
    ];
    for (const text of swallowed) expect({ text, n: flagged(text) }).toEqual({ text, n: 1 });
    const ok = [
      `async function f(e, xs) { try { await e.executeRaw('x'); } catch (err) { for (const x of xs) log(x); rethrowCapabilityRefusal(err); return []; } }`,
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { { console.warn(err); rethrowCapabilityRefusal(err); } return []; } }`,
      `async function f(e, xs) { try { await e.executeRaw('x'); } catch (err) { xs.forEach(x => { return x; }); rethrowCapabilityRefusal(err); return []; } }`,
    ];
    for (const text of ok) expect({ text, n: flagged(text) }).toEqual({ text, n: 0 });
  });

  test('flags a raw-SQL call inside a callback the try awaits', () => {
    expect(flagged(`async function f(e) { try { await e.transaction(async tx => { await tx.executeRaw('x'); }); } catch { return []; } }`)).toBe(1);
    expect(flagged(`async function f(e) { try { await Promise.all(ids.map(async id => e.executeRaw('x', [id]))); } catch { return []; } }`)).toBe(1);
    expect(flagged(`async function f(e) { try { await e.transaction(async tx => { schedule(() => tx.executeRaw('x')); }); } catch { return []; } }`)).toBe(0);
    expect(flagged(`async function f(e) { return await Promise.resolve().then(() => e.executeRaw('x')).catch(() => ({ mode: 'git' })); }`)).toBe(1);
  });

  test('flags a bare executeRawJsonb call and the direct raw-SQL method', () => {
    expect(flagged(`async function f(e) { try { await executeRawJsonb(e, 'x', [{}]); } catch { return []; } }`)).toBe(1);
    expect(flagged(`async function f(e) { try { await e.executeRawDirect('x'); } catch { return []; } }`)).toBe(1);
  });

  test('a switch before the rethrow can answer first, so it does not count', () => {
    expect(flagged(`async function f(e) { try { await e.executeRaw('x'); } catch (err) { switch (err.code) { case '42P01': break; default: return []; } rethrowCapabilityRefusal(err); return []; } }`)).toBe(1);
  });

  test('keeps flagging the shapes a looser rule would let through: a promise stored in a callback local, a helper on a shadowed or overwritten error', () => {
    // A pin, not a fail-first test: the rule already flags every one of these. A change that follows callback locals
    // or reads past a `switch` must keep each at one site, or a swallowed capability refusal slips through.
    const swallowed = [
      `async function f(e) { try { await e.transaction(tx => { let p; p = tx.executeRaw('x'); return p; }); } catch { return ['fallback']; } }`,
      `async function f(e) { try { await e.transaction(tx => { const ps = []; ps.push(tx.executeRaw('x')); return Promise.all(ps); }); } catch { return ['fallback']; } }`,
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { switch (err.code) { default: { const err = new Error('ordinary'); return rethrowCapabilityRefusal(err); } } rethrowCapabilityRefusal(err); return ['fallback']; } }`,
      `async function f(e) { try { await e.executeRaw('x'); } catch (err) { switch (err.code) { default: ({ err } = { err: new Error('ordinary') }); } rethrowCapabilityRefusal(err); return ['fallback']; } }`,
    ];
    for (const text of swallowed) expect({ text, n: flagged(text) }).toEqual({ text, n: 1 });
  });

  test('ignores engine implementation files, which Rust never runs', () => {
    const text = `async function f(e) { try { await e.executeRaw('x'); } catch { return []; } }`;
    expect(flagged(text, 'src/core/pglite-engine.ts')).toBe(0);
    expect(flagged(text, 'src/core/engine-sql/pages.ts')).toBe(0);
    expect(flagged(text, 'src/core/rust-engine/store-members/pages.ts')).toBe(0);
    expect(flagged(text, 'src/core/search/example.ts')).toBe(1);
  });

  test('names a metric and an ok marker of its own', () => {
    expect(CAPABILITY_REFUSAL_RULE.metric).toBe('capability_refusal_swallowed');
    expect(CAPABILITY_REFUSAL_RULE.okMarker).toBe('capability-refusal-ok');
  });
});
