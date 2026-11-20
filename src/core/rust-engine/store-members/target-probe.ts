/**
 * The copies of one slug under a read policy (SQL in engine-sql/collate-target-probe.ts): explain_target's probe rows
 * and the relational chain's anchors, served from the page, source and chunk records
 * (rust/crates/gbrain-store/src/page_ops/target_probe.rs, rust/docs/store/page_ops.md).
 */
import type { PageReadPolicy } from '../../types.ts';
import type { ChainAnchorRow, TargetProbeRow } from '../../engine-sql/collate-target-probe.ts';
import { storeCall, type StoreMember } from './common.ts';
import { readScope } from './page-ops.ts';

/** Every readable live copy of `slug` under the policy with its visible chunk count, vectors and revision state. */
export const probeTargetRows: StoreMember<[slug: string, policy: PageReadPolicy, chunkManifest?: boolean], TargetProbeRow[]> = (brain, slug, policy, chunkManifest = true) => {
  const scope = readScope('probeTargetRows', policy ?? {});
  return storeCall({ member: 'probeTargetRows' }, () => brain.probeTargetRows(slug, scope, chunkManifest));
};

/** The page id and source id of each live copy of `slug` the policy admits, by source id in byte order. */
export const listChainAnchors: StoreMember<[slug: string, policy: PageReadPolicy], ChainAnchorRow[]> = (brain, slug, policy) => {
  const scope = readScope('listChainAnchors', policy ?? {});
  return storeCall({ member: 'listChainAnchors' }, () => brain.listChainAnchors(slug, scope));
};
