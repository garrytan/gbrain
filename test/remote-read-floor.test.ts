/**
 * GBRA-108 design 1: which call sites read through the remote read floor.
 * 1. Protects: a remote read gate that is not caller-aware uses remoteReadFloorSql / remoteProvenanceFloorSql, which keep
 *    a labelled-only caller to pages that name it; only the write-side, maintenance, egress and classification sites
 *    listed here keep the plain privatePagesFilterFragment / privateProvenanceFilterFragment, each with its reason.
 * 2. Fails when: a new call of either plain fragment appears outside src/core/search/private-visibility.ts without a
 *    row here (use the floor, or add a row with the reason it is not a remote read), a listed site moves to another
 *    function, or the floor stops being byte-identical to the plain fragment for a caller that is not labelled-only.
 * 3. Real seams: the source tree as shipped, and the SQL the helpers emit inside caller records.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { privatePagesFilterFragment, privateProvenanceFilterFragment, remoteProvenanceFloorSql, remoteReadFloorSql, withCallerAccess } from '../src/core/search/private-visibility.ts';

/** file, enclosing top-level declaration, fragment: why it stays plain. */
const PLAIN: Record<string, string> = {
  'src/core/engine-sql/belief-state.ts readBeliefStateRows privatePagesFilterFragment': 'the ledger and purge read the stored world visibility, not a caller view',
  'src/commands/sources-add-next.ts noGrantFloorNext privatePagesFilterFragment': 'local CLI hint after sources add; never a remote read',
  'src/core/ai/decide/egress.ts visiblePages privatePagesFilterFragment': 'egress policy: which pages may leave the machine, judged as world',
  'src/core/belief/backfill.ts preparePage privatePagesFilterFragment': 'maintenance: stamps the ledger visibility of each page',
  'src/core/rust-engine/store-members/belief-ledger.ts readBeliefStateRows privatePagesFilterFragment': 'the Rust ledger state read: the stored world visibility, not a caller view',
  'src/core/engine-sql/dream-cycle.ts listDreamAtomPages privatePagesFilterFragment': 'dream cycle: marks a concept private when an input is (moved from cycle/synthesize-concepts.ts runPhaseSynthesizeConcepts)',
  'src/core/engine-sql/link-temporal.ts readLinkRelationshipEvidence privatePagesFilterFragment': 'write-side: records whether a link origin is public',
  'src/core/engine-sql/identity-decisions.ts listRestrictedIdentityMembers privatePagesFilterFragment': 'write-side: which duplicate-decision members may be written into the home repository, judged as world; local dedupe only',
  'src/core/engine-sql/trust-tier-reads.ts listValidTimeIdentities privatePagesFilterFragment': 'the world flag of the page; the read itself is gated by privatePagesFilterForCaller',
  'src/core/engine-sql/facts-purge.ts readHeldRowVisibility privatePagesFilterFragment': 'write-side: whether the target page is world (the held-fact move plan read)',
  'src/core/rust-engine/store-members/list-reads.ts readChatCensusRows privatePagesFilterFragment': 'maintenance: the Rust member of the chat-channel census serves the no-caller page policy the SQL fast filter is (a credential install warning, never a remote read)',
  'src/core/rust-engine/store-members/facts-held.ts (module) privatePagesFilterFragment': 'write-side: the Rust member of the held-fact move plan read names the no-caller page policy it serves',
  'src/core/rust-engine/store-members/facts-held.ts readHeldRowVisibility privatePagesFilterFragment': 'write-side: whether the target page is world (the held-fact move plan read, on the Rust engine)',
  'src/core/rust-engine/store-members/dream-cycle.ts atomPolicy privatePagesFilterFragment': 'dream cycle: marks a concept private when an input is (the Rust member of listDreamAtomPages)',
  'src/core/persistence/change-reason.ts pageWorldVisible privatePagesFilterFragment': 'write-side: whether a change reason may be published',
  'src/core/engine-sql/concept-rebuild.ts ACCESS_OPEN_SQL privatePagesFilterFragment': 'maintenance: compares a hidden concept\'s access with its rebuild\'s, to refuse a wider one',
  'src/core/engine-sql/concept-rebuild.ts readHeldConceptRows privatePagesFilterFragment': 'maintenance: classifies a held concept\'s members as private for the purge preview; callers get a count or the local CLI',
  'src/core/rust-engine/store-members/concept-rebuild.ts readHeldConceptRows privatePagesFilterFragment': 'maintenance: the Rust store\'s policy for that same member classification, read off the same fragment',
  'src/core/engine-sql/repair-page-scans.ts listOriginClaimants privatePagesFilterFragment': 'maintenance: classifies twin pages as private',
  'src/core/persistence/rows-behind.ts scanRowsBehind privatePagesFilterFragment': 'maintenance: lineage privacy of rows behind the projection',
  'src/core/rust-engine/store-members/trust-tier-reads.ts listValidTimeIdentities privatePagesFilterFragment': 'the Rust store derives the world flag of the page under the same policy; the read itself is gated by privatePagesFilterForCaller',
  'src/core/rust-engine/store-members/entity-identities.ts listRestrictedIdentityMembers privatePagesFilterFragment': 'write-side: the Rust store judges which duplicate-decision members may be written into the home repository under the same world policy as the SQL member; local dedupe only',
  'src/core/rust-engine/store-members/repair-page-scans.ts listOriginClaimants privatePagesFilterFragment': 'maintenance: the Rust store classifies twin pages as private under the same policy',
  'src/core/rust-engine/store-members/link-temporal.ts originPolicy privatePagesFilterFragment': 'write-side: the Rust store records whether a link origin is public under the same policy',
  'src/core/engine-sql/belief-purge-ledger.ts listPurgeCarrierVersions privatePagesFilterFragment': 'maintenance: classifies the purged versions of a fact purge, moved out of belief/purge.ts registerVersionCarriers, which classified the purged versions',
  'src/core/rust-engine/store-members/belief-purge-ledger.ts (module) privatePagesFilterFragment': 'maintenance: the Rust member of the purge version classification names the no-caller page policy it serves',
  'src/core/rust-engine/store-members/belief-purge-ledger.ts listPurgeCarrierVersions privatePagesFilterFragment': 'maintenance: classifies the purged versions of a fact purge on the Rust engine, under the same no-caller page policy',
  'src/core/rust-engine/store-members/private-provenance.ts storePageTextPolicy privatePagesFilterFragment': 'classification: renders the remote read floor text so the store judges it as a record with no readers; the text is only compared, and no read uses this call',
};

const DECL = /^(?:export )?(?:async )?function\*?\s+(\w+)|^(?:export )?(?:const|let)\s+(\w+)\s*[=:]/;

function plainSites(): string[] {
  const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
  const sites: string[] = [];
  for (const file of walk('src')) {
    if (file === join('src', 'core', 'search', 'private-visibility.ts')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\b(privatePagesFilterFragment|privateProvenanceFilterFragment)\(/g)) {
        let fn = '(module)';
        for (let j = i; j >= 0; j--) { const d = lines[j]!.match(DECL); if (d) { fn = d[1] ?? d[2]!; break; } }
        sites.push(file.split('\\').join('/') + ' ' + fn + ' ' + m[1]);
      }
    });
  }
  return [...new Set(sites)].sort();
}

describe('the remote read floor', () => {
  test('every plain fragment call outside private-visibility.ts is a listed write-side, maintenance or classification site', () => {
    const unlisted = plainSites().filter(site => !(site in PLAIN));
    expect({ unlisted, hint: unlisted.length ? 'A remote read gate uses remoteReadFloorSql (pages) or remoteProvenanceFloorSql (facts); add a row to PLAIN only with the reason it is not a remote read.' : '' })
      .toEqual({ unlisted: [], hint: '' });
    expect(Object.keys(PLAIN).filter(site => !plainSites().includes(site))).toEqual([]);
  });

  test('for any caller that is not labelled-only the floor is exactly the plain fragment; a labelled-only caller gets a narrower one', () => {
    const records = [{}, { identity: ['member:alice-example'], applyRemoteReadPolicy: true, hidePrivate: true, privateReadableSources: [] },
      { identity: ['member:alice-example'], lineage: true }, { audienceIdentities: [['member:alice-example'], ['member:bob-example']] }];
    for (const access of records) {
      withCallerAccess(access, () => {
        for (const derived of [false, true]) expect(remoteReadFloorSql('p', derived)).toBe(privatePagesFilterFragment('p', derived));
        expect(remoteProvenanceFloorSql('f')).toBe(privateProvenanceFilterFragment('f'));
      });
    }
    withCallerAccess({ identity: ['member:alice-example'], labelledOnly: true }, () => {
      expect(remoteReadFloorSql('p')).toStartWith('(' + privatePagesFilterFragment('p') + ' AND ');
      expect(remoteProvenanceFloorSql('f')).toStartWith('(' + privateProvenanceFilterFragment('f') + ' AND ');
      expect(remoteProvenanceFloorSql('f')).toContain("lp.slug = 'memory/members/alice-example'");
    });
  });
});
