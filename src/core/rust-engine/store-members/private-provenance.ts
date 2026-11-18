/**
 * The private-provenance policy a fact read applies under `excludePrivate`, as the store reads it.
 *
 * PGLite renders the policy as SQL for the caller in context (src/core/search/private-visibility.ts). The store
 * implements one rendering: the one with no caller record (the empty identity, no satisfied folder rule, no lineage
 * read), less its two process settings, which travel as flags. A member renders its own PGLite fragment in the
 * current context and serves the read only when that text equals the no-caller text; any other caller (a member page,
 * a grant, a lineage or owner read, a labelled-only grant, a relaxed remote read) refuses with
 * `engine_capability_missing`.
 *
 * A page read under `excludePrivate` (pageReadFilter, src/core/search/read-policy-sql.ts) adds the page policy
 * `privatePagesFilterForCaller('p')` instead, which the entity gate of the fact policy applies to its entity page;
 * `storePagePolicy` refuses the same way and sends the same flags (`entityPrivacy` is then the privacy part of `p`).
 * A page family that opts in with `callerReaders` also serves a caller whose record holds only a reader identity
 * (its member id and groups) and a private-readable grant: the member renders the page policy for a fresh record of
 * just those two, and when the caller's text equals it, the store reads the identity and the granted sources from
 * the policy (`readers_allowed` and `orPrivateReadableSource` in privacy.rs). Folder rules, pending coverage,
 * audiences, lineage, owner-only sources, labelled-only grants and relaxed reads still refuse.
 *
 * The concept-input test is rendered either inline or as a call of `gbrain_concept_inputs_private` (migration v311),
 * by the schema version the context carries. The two forms are the same test, so the comparison reads both as one.
 */
import {
  currentCallerAccess,
  privacyAliasSql,
  privatePagesFilterForCaller,
  privateSnapshotFilterFragment,
  withCallerAccess,
  withoutCallerAccess,
  privateProvenanceFilterUnderPolicy,
} from '../../search/private-visibility.ts';
import { refuseMember } from './common.ts';

/** The policy flags the store reads (`PrivacyPolicy` in rust/crates/gbrain-store/src/facts/privacy.rs). */
export interface StorePrivacyPolicy {
  honorAliases: boolean;
  entityPrivacy: boolean;
  /** The caller's reader principals; empty for the no-caller policy. */
  identity?: string[];
  /** The sources whose private pages the caller reads; empty for the no-caller policy. */
  privateReadableSources?: string[];
}

/** The page aliases the policies judge: the fact policy's two, and `p` of a page read. */
const PAGE_ALIASES = ['pp', 'entity_pp', 'p'] as const;

/** `derivedPageSql(alias)` as derivedOriginPrivateSql opens its concept-input branch with it. */
const conceptBranchStart = (p: string): string =>
  `\n    WHEN (${p}.type IN ('atom', 'question') OR (${p}.type = 'concept' AND ${p}.frontmatter->>'synthesized_by' IS NOT NULL)) THEN `;
const conceptBranchEnd = (p: string): string => `\n    WHEN ${p}.type = 'event'`;

/** The policy text with each concept-input test, inline or a function call, read as one placeholder. */
export function normalizeConceptInputs(sql: string): string {
  let out = sql;
  for (const p of PAGE_ALIASES) {
    const start = conceptBranchStart(p);
    const end = conceptBranchEnd(p);
    let from = 0;
    for (;;) {
      const at = out.indexOf(start, from);
      if (at < 0) break;
      const body = at + start.length;
      const stop = out.indexOf(end, body);
      if (stop < 0) break;
      const marker = `<concept-inputs ${p}>`;
      out = out.slice(0, body) + marker + out.slice(stop);
      from = body + marker.length;
    }
  }
  return out;
}

/**
 * The store policy for a read under `excludePrivate`, or undefined when the read does not ask for it. `rendered` is
 * the fragment PGLite would add in the current context; a caller whose fragment is not the no-caller one refuses.
 */
export function storePrivacyPolicy(member: string, excludePrivate: unknown, rendered: () => string): StorePrivacyPolicy | undefined {
  if (excludePrivate !== true) return undefined;
  const baseline = withoutCallerAccess(() => privateProvenanceFilterUnderPolicy('facts'));
  if (normalizeConceptInputs(rendered()) !== normalizeConceptInputs(baseline)) {
    refuseMember(member, 'excludePrivate for a caller whose member pages, grants or lineage widen the policy');
  }
  return {
    honorAliases: baseline.includes(privacyAliasSql('pp')),
    entityPrivacy: baseline.includes(privateSnapshotFilterFragment('entity_pp')),
  };
}

/**
 * The store policy for a page read (`pageReadFilter`'s `excludePrivate`), or undefined when the read does not ask for
 * it. The read's page alias is `p`; a caller whose `privatePagesFilterForCaller('p')` is not the no-caller one refuses.
 */
export function storePagePolicy(
  member: string,
  excludePrivate: unknown,
  opts: { callerReaders?: boolean } = {},
): StorePrivacyPolicy | undefined {
  if (!excludePrivate) return undefined;
  const rendered = normalizeConceptInputs(privatePagesFilterForCaller('p'));
  const baseline = withoutCallerAccess(() => privatePagesFilterForCaller('p'));
  if (rendered === normalizeConceptInputs(baseline)) return pagePolicyFlags(baseline);
  if (opts.callerReaders) {
    const access = currentCallerAccess();
    const readers = { identity: [...access.identity], privateReadableSources: [...access.privateReadableSources] };
    const canonical = withoutCallerAccess(() =>
      withCallerAccess({ ...readers, hidePrivate: true }, () => privatePagesFilterForCaller('p')));
    if (rendered === normalizeConceptInputs(canonical)) return { ...pagePolicyFlags(canonical), ...readers };
  }
  refuseMember(member, 'excludePrivate for a caller whose member pages, grants or lineage widen the policy');
}

/** The process-setting flags of a rendered page policy. */
function pagePolicyFlags(sql: string): StorePrivacyPolicy {
  return {
    honorAliases: sql.includes(privacyAliasSql('p')),
    entityPrivacy: sql.includes(privateSnapshotFilterFragment('p')),
  };
}
