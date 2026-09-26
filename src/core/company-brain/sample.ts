import company from './sample/company.md' with { type: 'text' };
import competitor from './sample/competitors/competitor-example.md' with { type: 'text' };
import customer from './sample/customers/acme-example.md' with { type: 'text' };
import oldDecision from './sample/decisions/2026-05-02-focus-grocery.md' with { type: 'text' };
import decision from './sample/decisions/2026-08-20-focus-3pl.md' with { type: 'text' };
import extracted from './sample/inbox/extracted/2026-09-10-acme-qbr.md' with { type: 'text' };
import review from './sample/meetings/2026-08-19-gtm-review.md' with { type: 'text' };
import meeting from './sample/meetings/2026-09-10-acme-qbr.md' with { type: 'text' };
import alice from './sample/people/alice-example.md' with { type: 'text' };
import bob from './sample/people/bob-example.md' with { type: 'text' };
import casey from './sample/people/casey-example.md' with { type: 'text' };
import product from './sample/product.md' with { type: 'text' };
import strategy from './sample/strategy.md' with { type: 'text' };
import supplier from './sample/suppliers/supplier-example.md' with { type: 'text' };
import weekly from './sample/weekly/2026-W37.md' with { type: 'text' };

export const COMPANY_BRAIN_SAMPLE: ReadonlyArray<{ slug: string; content: string }> = [
  { slug: 'company', content: company },
  { slug: 'competitors/competitor-example', content: competitor },
  { slug: 'customers/acme-example', content: customer },
  { slug: 'decisions/2026-05-02-focus-grocery', content: oldDecision },
  { slug: 'decisions/2026-08-20-focus-3pl', content: decision },
  { slug: 'inbox/extracted/2026-09-10-acme-qbr', content: extracted },
  { slug: 'meetings/2026-08-19-gtm-review', content: review },
  { slug: 'meetings/2026-09-10-acme-qbr', content: meeting },
  { slug: 'people/alice-example', content: alice },
  { slug: 'people/bob-example', content: bob },
  { slug: 'people/casey-example', content: casey },
  { slug: 'product', content: product },
  { slug: 'strategy', content: strategy },
  { slug: 'suppliers/supplier-example', content: supplier },
  { slug: 'weekly/2026-W37', content: weekly },
];
