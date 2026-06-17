import type { BrainEngine } from '../core/engine.ts';
import type { FreshnessMeta } from '../core/freshness/types.ts';
import type { DigestPage } from '../core/freshness/digest.ts';
import { generateDigest, digestToMarkdown } from '../core/freshness/index.ts';
import { runReconcileCheck } from '../core/freshness/index.ts';

const HELP = `Usage: gbrain freshness <subcommand> [options]

Subcommands:
  digest [--limit N]         Generate freshness digest (JSON)
  digest-markdown [--limit N] Generate freshness digest (markdown format)
  reconcile [--limit N]      Run reconciliation check
  help                       Show this help
`;

function deriveFreshnessMeta(page: any): FreshnessMeta {
  const source = page.metadata?.source ?? 'unknown';
  const decayClass = source === 'code' ? 'fast' : source === 'file' ? 'medium' : 'slow';
  return {
    last_verified_at: page.updated_at ?? page.created_at ?? new Date().toISOString(),
    decay_class: decayClass,
    source_precision: 'medium',
    confidence: 0.8,
    stale_after_days: decayClass === 'fast' ? 30 : decayClass === 'medium' ? 90 : 180,
  };
}

export async function runFreshness(engine: BrainEngine, args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'help';

  const parseLimit = (): number => {
    const limitIdx = args.indexOf('--limit');
    return limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) || 100 : 100;
  };

  const loadDigestPages = async (limit: number): Promise<DigestPage[]> => {
    const listResult = await engine.listPages({ limit });
    const pages = ((listResult as any)?.pages ?? listResult ?? []) as any[];
    return pages.map((page: any) => ({
      slug: page.slug,
      title: page.title ?? page.slug,
      pageType: page.type ?? 'unknown',
      freshness: deriveFreshnessMeta(page),
    }));
  };

  switch (subcommand) {
    case 'digest': {
      const digestPages = await loadDigestPages(parseLimit());
      const digest = generateDigest(digestPages);
      console.log(JSON.stringify(digest, null, 2));
      break;
    }
    case 'digest-markdown': {
      const digestPages = await loadDigestPages(parseLimit());
      const digest = generateDigest(digestPages);
      console.log(digestToMarkdown(digest));
      break;
    }
    case 'reconcile': {
      const listResult = await engine.listPages({ limit: parseLimit() });
      const pages = ((listResult as any)?.pages ?? listResult ?? []) as any[];
      const reconcilePages = pages.map((p: any) => ({ slug: p.slug, tags: p.tags as string[] | undefined }));
      const report = await runReconcileCheck(reconcilePages, {
        getRelatedEntities: async () => [],
      }, []);
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    default:
      console.log(HELP);
  }
}
