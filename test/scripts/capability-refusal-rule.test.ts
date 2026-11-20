/**
 * The capability-refusal rule (scripts/capability-refusal-rule.ts) for the silent read-catch guard.
 *
 * Protects: a catch around a raw-SQL engine call must rethrow a Rust capability refusal before its
 * fallback, so a Rust brain reports a read it cannot serve instead of answering "nothing".
 * Regression it catches: a matcher that misses `.catch(() => [])` or a try/catch fallback, or that
 * flags a handler which already rethrows (a false failure the guard would baseline for ever).
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
