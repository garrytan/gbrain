// v0.42 schema-pack inheritance merge (T20 / issue #1749).
//
// resolvePack walks the `extends` chain and resolves `borrow_from`, then
// hands the ancestor manifests + child + borrowed types to this pure
// helper to produce the fully-composed `resolved.manifest`. Every
// downstream consumer reads `resolved.manifest`, so doing the merge once
// here is what makes inheritance transparent to the ~dozen call sites that
// read page_types / link_types / filing_rules / etc.
//
// Precedence, highest → lowest:  child  →  borrowed  →  nearest parent … base.
//
// Scope — the SIX ingest/query-shaping fields inherit:
//   page_types, link_types, frontmatter_links, enrichable_types,
//   filing_rules, takes_kinds.
// `phases` and `calibration_domains` are deliberately NOT inherited — they
// gate real cycle execution (cycle.ts `packDeclaresPhase`) and the manifest
// contract says each pack declares its own participation explicitly. They
// stay whatever the CHILD declared (child-only), same as before this change.
// `mapping_rules`, `migration_from`, `extends`, `borrow_from`, and every
// identity field (name/version/…) are child-only too.
//
//                page_types ordering (inferType path_prefix precedence)
//   ┌───────────────────────────────────────────────────────────────────┐
//   │ inferTypeFromPack (markdown.ts) is FIRST-path_prefix-match-wins in  │
//   │ array order, and gbrain-base orders its types by priority on        │
//   │ purpose. So:                                                        │
//   │   • the BASE (root, extends:null) pack is the ordered foundation —  │
//   │     it forms the tail, in its declared order.                       │
//   │   • a NEW type from ANY non-base layer (child, borrowed, or a       │
//   │     middle pack in the extends chain) is PREPENDED, nearest-first   │
//   │     (child → borrowed → nearest parent … → farthest middle parent), │
//   │     so a more-derived type's prefix wins. This makes a type's       │
//   │     priority independent of chain depth: `thesis` (declared by      │
//   │     gbrain-investor) wins the same whether investor is the active   │
//   │     pack (2-level) or a middle pack under gbrain-everything.        │
//   │   • an OVERRIDE of an existing BASE type keeps the base POSITION    │
//   │     (only its value changes) so base's curated priority is intact.  │
//   └───────────────────────────────────────────────────────────────────┘

import type { SchemaPackManifest, PackPageType, PackLinkType } from './manifest-v1.ts';

/** Types pulled from `borrow_from` targets (already name-filtered by resolvePack). */
export interface BorrowedTypes {
  page_types: PackPageType[];
  link_types: PackLinkType[];
}

/**
 * Merge keyed records child-wins: walk layers highest-precedence-first and
 * keep the FIRST occurrence of each key. Used for the order-insensitive
 * fields (link_types, frontmatter_links, enrichable_types, filing_rules) —
 * these are keyed lookups, so array order carries no behavior.
 */
export function mergeByKey<T>(
  layersHighToLow: ReadonlyArray<ReadonlyArray<T>>,
  keyFn: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const layer of layersHighToLow) {
    for (const item of layer) {
      const k = keyFn(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/**
 * Order-preserving union across layers (dedup by value identity). Used for
 * `takes_kinds`. UNION (not replace) because Zod applies the default
 * `['fact','take','bet','hunch']` at parse time, so an omitted field is
 * indistinguishable from an explicit one — replace-semantics would let a
 * child that omits `takes_kinds` wipe the parent's. Consequence: a child
 * cannot NARROW takes_kinds below base ∪ parent (documented constraint).
 */
export function mergeUnion<T>(layers: ReadonlyArray<ReadonlyArray<T>>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const layer of layers) {
    for (const item of layer) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Merge page_types with the ordering contract above. The BASE (root) pack is
 * the ordered foundation (tail); overrides of a base type keep the base
 * position; genuinely-new types from ANY non-base layer are prepended
 * nearest-first so a more-derived type's prefix wins in inferType regardless
 * of chain depth.
 */
export function mergePageTypes(
  ancestorsBaseFirst: ReadonlyArray<SchemaPackManifest>,
  borrowedPageTypes: ReadonlyArray<PackPageType>,
  child: SchemaPackManifest,
): PackPageType[] {
  // Split the extends chain: the root (extends:null) pack is the ordered
  // foundation; everything above it (middle parents) contributes overrides +
  // new types like child/borrowed do. ancestorsBaseFirst is [root … nearest].
  const base = ancestorsBaseFirst[0];
  const middleParentsBaseFirst = ancestorsBaseFirst.slice(1);

  // 1. Foundation map from the base pack, in declared order. Map.set() on an
  //    existing key UPDATES the value but KEEPS the insertion position, so an
  //    override of a base type stays in the base's curated priority slot.
  const byName = new Map<string, PackPageType>();
  if (base) for (const pt of base.page_types) byName.set(pt.name, pt);

  // 2. Value overrides of base types, applied lowest→highest precedence
  //    (farthest middle parent → nearest parent → borrowed → child) so the
  //    highest-precedence value wins for any type that exists in the base.
  const overrideLayersLowToHigh: ReadonlyArray<ReadonlyArray<PackPageType>> = [
    ...middleParentsBaseFirst.map(p => p.page_types),
    borrowedPageTypes,
    child.page_types,
  ];
  for (const layer of overrideLayersLowToHigh) {
    for (const pt of layer) if (byName.has(pt.name)) byName.set(pt.name, pt);
  }

  // 3. Genuinely-new types (absent from the base foundation), prepended
  //    nearest-first: child → borrowed → nearest parent … → farthest middle
  //    parent. Deduped by name, so the nearer layer wins a name declared new
  //    in more than one place.
  const newLayersHighToLow: ReadonlyArray<ReadonlyArray<PackPageType>> = [
    child.page_types,
    borrowedPageTypes,
    ...[...middleParentsBaseFirst].reverse().map(p => p.page_types),
  ];
  const seenNew = new Set<string>();
  const prepended: PackPageType[] = [];
  for (const layer of newLayersHighToLow) {
    for (const pt of layer) {
      if (byName.has(pt.name) || seenNew.has(pt.name)) continue;
      seenNew.add(pt.name);
      prepended.push(pt);
    }
  }
  return [...prepended, ...byName.values()];
}

/**
 * Compose the resolved manifest from the extends ancestors (base-first),
 * the child, and the resolved `borrow_from` types. Pure + deterministic.
 * Identity fields and the child-only fields come from `child` via spread;
 * the six inheritable fields are overwritten with their merged values.
 */
export function mergeInheritedManifest(
  ancestorsBaseFirst: ReadonlyArray<SchemaPackManifest>,
  child: SchemaPackManifest,
  borrowed: BorrowedTypes,
): SchemaPackManifest {
  // Ancestors highest-precedence-first (nearest parent … base) for the
  // keyed merges. Child sits above all ancestors; borrowed sits between
  // child and the ancestors (only page_types + link_types).
  const ancestorsHighToLow = [...ancestorsBaseFirst].reverse();
  const ancLink = ancestorsHighToLow.map(a => a.link_types);
  const ancFront = ancestorsHighToLow.map(a => a.frontmatter_links);
  const ancEnrich = ancestorsHighToLow.map(a => a.enrichable_types);
  const ancFiling = ancestorsHighToLow.map(a => a.filing_rules);
  const ancTakes = ancestorsHighToLow.map(a => a.takes_kinds);

  return {
    // Keeps identity fields AND the child-only fields (phases,
    // calibration_domains, mapping_rules, migration_from, extends,
    // borrow_from) exactly as the child declared them.
    ...child,
    page_types: mergePageTypes(ancestorsBaseFirst, borrowed.page_types, child),
    link_types: mergeByKey([child.link_types, borrowed.link_types, ...ancLink], lt => lt.name),
    frontmatter_links: mergeByKey(
      [child.frontmatter_links, ...ancFront],
      // NUL delimiter, not a space: page_type/link_type are unconstrained
      // strings, so a space-join would collide {"a b","c"} with {"a","b c"}.
      fl => `${fl.page_type}\x00${fl.link_type}`,
    ),
    enrichable_types: mergeByKey([child.enrichable_types, ...ancEnrich], et => et.type),
    filing_rules: mergeByKey([child.filing_rules, ...ancFiling], fr => fr.kind),
    takes_kinds: mergeUnion([child.takes_kinds, ...ancTakes]),
  };
}
