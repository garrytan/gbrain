// Fixture for test/rust-access-derivation-coverage.test.ts: builder calls outside the derivation, and allowed ones.
declare const renderForStoreCaller: (r: unknown, f: () => string) => string, pagePolicyFlags: (t: string) => unknown, selfChecked: (m: string, r: unknown, f: () => unknown) => unknown, accessDerivationOn: () => boolean;
export function leaks(): unknown {
  return pagePolicyFlags('x');
}
function storeThingRendered(): unknown { return pagePolicyFlags('y'); }
export function wrapped(): unknown { return selfChecked('m', {}, () => storeThingRendered()); }
export function unguarded(): unknown { return storeThingRendered(); }
export function wrongGuard(): unknown { if (Math.random()) return storeThingRendered(); return null; }
export function offPath(): unknown { if (!accessDerivationOn()) return storeThingRendered(); return selfChecked('m', {}, storeThingRendered); }
// The shape enforcedMemberPolicy had before it asked the store: a helper that renders and reads the flags itself.
export function enforcedLeaks(): unknown { const reference = renderForStoreCaller({}, () => 'x'); return pagePolicyFlags(reference); }
export function enforcedChecked(): unknown { return selfChecked('m', {}, () => { const reference = renderForStoreCaller({}, () => 'x'); return pagePolicyFlags(reference); }); }
