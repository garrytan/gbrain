import type { BrainEngine } from '../engine.ts';
import type {
  NoteManifestEntry,
  NoteSectionEntry,
  PrecisionLookupRoute,
  PrecisionLookupRouteInput,
  PrecisionLookupRouteRead,
  PrecisionLookupRouteResult,
} from '../types.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
import {
  listAllNoteManifestEntries,
  listAllNoteSectionEntries,
} from './structural-entry-pagination.ts';

export async function getPrecisionLookupRoute(
  engine: BrainEngine,
  input: PrecisionLookupRouteInput,
): Promise<PrecisionLookupRouteResult> {
  const scopeId = input.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;

  if (input.section_id) {
    const section = await findSectionById(engine, scopeId, input.section_id, input.slug);
    return buildSectionMatchResult(engine, scopeId, section, 'direct_section_match');
  }

  if (input.path) {
    const anchored = parseAnchoredSectionPath(input.path);
    if (anchored) {
      const section = await findSectionByAnchoredPath(engine, scopeId, anchored, input.slug);
      return buildSectionMatchResult(engine, scopeId, section, 'direct_section_path_match', input.path);
    }

    const page = await findManifestByExactPath(engine, scopeId, input.path);
    if (!page) {
      return {
        selection_reason: 'no_match',
        candidate_count: 0,
        route: null,
      };
    }

    if (input.slug && input.slug !== page.slug) {
      return {
        selection_reason: 'no_match',
        candidate_count: 0,
        route: null,
      };
    }

    return {
      selection_reason: 'direct_path_match',
      candidate_count: 1,
      route: buildPageRoute(scopeId, page, input.path),
    };
  }

  if (!input.slug) {
    if (input.source_ref) {
      return buildSourceRefMatchResult(engine, scopeId, input.source_ref);
    }

    return {
      selection_reason: 'no_match',
      candidate_count: 0,
      route: null,
    };
  }

  const [page] = await engine.listNoteManifestEntries({
    scope_id: scopeId,
    slug: input.slug,
    limit: 1,
  });
  if (!page) {
    return {
      selection_reason: 'no_match',
      candidate_count: 0,
      route: null,
    };
  }

  return {
    selection_reason: 'direct_page_match',
    candidate_count: 1,
    route: buildPageRoute(scopeId, page),
  };
}

function buildPageRoute(
  scopeId: string,
  page: NoteManifestEntry,
  anchoredPath?: string,
  sourceRef?: string,
): PrecisionLookupRoute {
  return {
    route_kind: 'precision_lookup',
    target_kind: 'page',
    slug: page.slug,
    path: page.path,
    title: page.title,
    scope_id: scopeId,
    retrieval_route: [
      'direct_canonical_artifact',
      'minimal_supporting_reads',
    ],
    summary_lines: [
      anchoredPath
        ? `Precision lookup is anchored to exact canonical path ${anchoredPath}.`
        : sourceRef
          ? `Precision lookup is anchored to exact canonical source ref ${sourceRef}.`
        : `Precision lookup is anchored to exact canonical page ${page.slug}.`,
      'Supporting reads kept narrow: 1.',
      'Use the exact canonical artifact before relying on memory summaries.',
    ],
    recommended_reads: [
      {
        node_id: `page:${page.slug}`,
        node_kind: 'page',
        label: page.title,
        page_slug: page.slug,
        path: page.path,
      },
    ],
  };
}

async function findManifestByExactPath(
  engine: BrainEngine,
  scopeId: string,
  path: string,
): Promise<NoteManifestEntry | null> {
  const manifests = await listAllNoteManifestEntries(engine, scopeId);
  return manifests.find((entry) => entry.path === path) ?? null;
}

async function findSectionById(
  engine: BrainEngine,
  scopeId: string,
  sectionId: string,
  slug?: string,
): Promise<NoteSectionEntry | null> {
  const [section] = await engine.listNoteSectionEntries({
    scope_id: scopeId,
    section_id: sectionId,
    limit: 1,
  });
  if (!section) return null;
  if (slug && slug !== section.page_slug) return null;
  return section;
}

interface AnchoredSectionPath {
  page_path: string;
  fragment: string;
}

function parseAnchoredSectionPath(path: string): AnchoredSectionPath | null {
  const separatorIndex = path.indexOf('#');
  if (separatorIndex === -1) {
    return null;
  }

  const pagePath = path.slice(0, separatorIndex);
  const fragment = path.slice(separatorIndex + 1).replace(/^\/+|\/+$/g, '');
  if (!pagePath || !fragment) {
    return null;
  }

  return {
    page_path: pagePath,
    fragment,
  };
}

async function findSectionByAnchoredPath(
  engine: BrainEngine,
  scopeId: string,
  anchored: AnchoredSectionPath,
  slug?: string,
): Promise<NoteSectionEntry | null> {
  const sections = await listAllNoteSectionEntries(engine, scopeId);
  return sections.find((entry) => {
    if (entry.page_path !== anchored.page_path) return false;
    if (slug && entry.page_slug !== slug) return false;
    return entry.heading_path.join('/') === anchored.fragment;
  }) ?? null;
}

async function buildSectionMatchResult(
  engine: BrainEngine,
  scopeId: string,
  section: NoteSectionEntry | null,
  selectionReason:
    | 'direct_section_match'
    | 'direct_section_path_match'
    | 'direct_source_ref_section_match',
  anchoredPath?: string,
  sourceRef?: string,
): Promise<PrecisionLookupRouteResult> {
  if (!section) {
    return {
      selection_reason: 'no_match',
      candidate_count: 0,
      route: null,
    };
  }

  const [page] = await engine.listNoteManifestEntries({
    scope_id: scopeId,
    slug: section.page_slug,
    limit: 1,
  });
  if (!page) {
    return {
      selection_reason: 'no_match',
      candidate_count: 0,
      route: null,
    };
  }

  return {
    selection_reason: selectionReason,
    candidate_count: 1,
    route: buildSectionRoute(scopeId, page, section, anchoredPath, sourceRef),
  };
}

async function buildSourceRefMatchResult(
  engine: BrainEngine,
  scopeId: string,
  sourceRef: string,
): Promise<PrecisionLookupRouteResult> {
  const sections = (await listAllNoteSectionEntries(engine, scopeId))
    .filter((entry) => entry.source_refs.includes(sourceRef));
  if (sections.length === 1) {
    const section = sections[0];
    if (!section) {
      throw new Error('Expected one section match for source_ref lookup');
    }
    return buildSectionMatchResult(
      engine,
      scopeId,
      section,
      'direct_source_ref_section_match',
      buildAnchoredSectionPath(section),
      sourceRef,
    );
  }
  if (sections.length > 1) {
    return {
      selection_reason: 'ambiguous_source_ref_match',
      candidate_count: sections.length,
      route: null,
    };
  }

  const pages = (await listAllNoteManifestEntries(engine, scopeId))
    .filter((entry) => entry.source_refs.includes(sourceRef));
  if (pages.length === 1) {
    const page = pages[0];
    if (!page) {
      throw new Error('Expected one page match for source_ref lookup');
    }
    return {
      selection_reason: 'direct_source_ref_page_match',
      candidate_count: 1,
      route: buildPageRoute(scopeId, page, undefined, sourceRef),
    };
  }
  if (pages.length > 1) {
    return {
      selection_reason: 'ambiguous_source_ref_match',
      candidate_count: pages.length,
      route: null,
    };
  }

  return {
    selection_reason: 'no_match',
    candidate_count: 0,
    route: null,
  };
}

function buildSectionRoute(
  scopeId: string,
  page: NoteManifestEntry,
  section: NoteSectionEntry,
  anchoredPath?: string,
  sourceRef?: string,
): PrecisionLookupRoute {
  return {
    route_kind: 'precision_lookup',
    target_kind: 'section',
    slug: page.slug,
    path: anchoredPath ?? section.page_path,
    title: section.heading_text,
    scope_id: scopeId,
    section_id: section.section_id,
    retrieval_route: [
      'direct_canonical_artifact',
      'minimal_supporting_reads',
    ],
    summary_lines: [
      sourceRef
        ? `Precision lookup is anchored to exact canonical source ref ${sourceRef}.`
        : anchoredPath
          ? `Precision lookup is anchored to exact canonical section path ${anchoredPath}.`
        : `Precision lookup is anchored to exact canonical section ${section.heading_text}.`,
      'Supporting reads kept narrow: 2.',
      'Use the exact canonical artifact before relying on memory summaries.',
    ],
    recommended_reads: [
      {
        node_id: `section:${section.section_id}`,
        node_kind: 'section',
        label: section.heading_text,
        page_slug: section.page_slug,
        path: anchoredPath ?? section.page_path,
        section_id: section.section_id,
      },
      {
        node_id: `page:${page.slug}`,
        node_kind: 'page',
        label: page.title,
        page_slug: page.slug,
        path: page.path,
      },
    ],
  };
}

function buildAnchoredSectionPath(section: NoteSectionEntry): string {
  return `${section.page_path}#${section.heading_path.join('/')}`;
}
