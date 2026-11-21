// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/core/verbs/entity-card.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

// verbatim src/core/verbs/entity-card.ts:811-819
export async function readAka(engine: BrainEngine, sourceId: string, slug: string): Promise<string[]> {
  return engine
    .executeRaw<{ alias_norm: string }>(
      `SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 ORDER BY alias_norm`,
      [sourceId, slug],
    )
    .then(rs => rs.map(r => r.alias_norm))
    .catch(() => [] as string[]);
}

export async function selectEntityCandidates(engine: any) {
  // verbatim src/core/verbs/entity-card.ts:340-345
    try {
      const aliasMap = await engine.resolveAliases([norm], { sourceId });
      for (const hit of aliasMap.get(norm) ?? []) consider(hit.slug, ARM_ALIAS);
    } catch {
      /* no page_aliases table — degrade to arm 2 [E3] */
    }
  // ...
  // verbatim src/core/verbs/entity-card.ts:351-364
  try {
    rows = await engine.executeRaw<CardPageRow>(
      `SELECT ${CARD_ROW_COLUMNS}
         FROM pages
        WHERE deleted_at IS NULL
          AND source_id = $1
          AND ( lower(title) = $2
             OR slug = ANY($3::text[])
             OR slug LIKE $4 )${privatePredicate}`,
      [sourceId, titleLc, exactSlugs, `%/${slug || trimmed}`],
    );
  } catch {
    rows = [];
  }
  // ...
  // verbatim src/core/verbs/entity-card.ts:375-385
    try {
      const extra = await engine.executeRaw<CardPageRow>(
        `SELECT ${CARD_ROW_COLUMNS}
           FROM pages
          WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[])${privatePredicate}`,
        [sourceId, missing],
      );
      for (const r of extra) rowBySlug.set(r.slug, r);
    } catch {
      /* stale alias rows — drop */
    }
}

export async function assembleCard(engine: any) {
  // verbatim src/core/verbs/entity-card.ts:620-682
  const [aka, outLinks, inEdges, backlinkCount, timeline, facts, activeFactCount] = await Promise.all([
    readAka(engine, sourceId, pageSlug),
    engine.getLinks(pageSlug, { ...(remote ? { sourceIds: [sourceId] } : { sourceId }), excludePrivate, temporal: { status: 'all' } }).catch(() => []),
    engine
      .executeRaw<{ from_slug: string; link_type: string; context: string | null }>(
        `SELECT f.slug AS from_slug, l.link_type, l.context${TEMPORAL_LINK_SELECT_SQL}
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
           ${temporalLinkJoinSql('l', excludePrivate)}
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2 AND f.deleted_at IS NULL
            AND COALESCE(l.link_source, '') <> 'mentions'${inboundPrivacy}
          ORDER BY l.id`,
        [pageSlug, sourceId],
      )
      .then(rs => rs.map(r => annotateTemporalRow(r)))
      .catch(() => [] as Array<{ from_slug: string; link_type: string; context: string | null } & TemporalAnnotation>),
    engine
      .executeRaw<{ n: string | number }>(
        `SELECT COUNT(*) AS n
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2 AND f.deleted_at IS NULL
            AND COALESCE(l.link_source, '') <> 'mentions'${inboundPrivacy}`,
        [pageSlug, sourceId],
      )
      .then(rs => Number(rs[0]?.n ?? 0))
      .catch(() => 0),
    engine.getTimeline(pageSlug, { limit: 5, sourceId, excludePrivate, eligibility }).catch(() => []),
    Promise.all(factSlugs.map(slug => engine.listFactsByEntity(sourceId, slug, {
      activeOnly: true,
      limit: FACT_FETCH_CAP,
      ...(visibility ? { visibility } : {}),
      excludePrivate,
      eligibility,
    })))
      .then(lists => lists.flat().sort((a, b) => factTime(b) - factTime(a)).slice(0, FACT_FETCH_CAP))
      // GST-3170: a slot value a later one ended at read time is no longer current (slot-ends.ts).
      .then(async rows => {
        const current = await applySlotEnds(engine, { sourceId, worldOnly, excludePrivate, minTrust: eligibility.floor, suppressFlagged: eligibility.suppressFlagged }, rows,
          { activeOnly: true, entities: [{ source_id: sourceId, slugs: factSlugs }] });
        endedFacts = rows.length - current.length;
        return current;
      })
      .catch(() => [] as FactRow[]),
    // Exact active-fact count: the payload fetch above is capped at
    // FACT_FETCH_CAP, so facts.length silently reports the cap for bigger
    // entities. Same predicate as the fetch (active + source + caller
    // visibility), indexed COUNT instead of rows. Fail-soft to null so a
    // count failure degrades to the capped payload length, never to 0.
    engine
      .executeRaw<{ n: string | number }>(
        `SELECT COUNT(*) AS n
           FROM facts
          WHERE source_id = $1 AND entity_slug = ANY($2::text[])
            AND expired_at IS NULL${worldOnly ? ` AND visibility = 'world'` : ''}${excludePrivate ? ` AND ${privateFactFilterForReader('facts')}` : ''}
            AND ${projectionEligibleSql('facts', 'facts', eligibility)}`,
        [sourceId, factSlugs],
      )
      .then(rs => Number(rs[0]?.n ?? 0))
      .catch(() => null),
  ]);
  // ...
  // verbatim src/core/verbs/entity-card.ts:784-784
  const pageTrust = (await loadPageTrust(engine, [{ source_id: sourceId, slug: pageSlug }]).catch(() => null))?.byKey.get(`${sourceId}\u0000${pageSlug}`);
}
