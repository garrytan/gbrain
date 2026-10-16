import { expect, test } from 'bun:test';
import { classifyCaptureValue, chooseSpecificEntity, captureMode, type RoutingDeps } from '../src/core/facts/capture-policy.ts';
const drops = {
  scheduling: ['Meeting scheduled for tomorrow at noon', 'Will attend the meeting today', 'Invite for Tuesday call', 'The call is planned for the week of July 20, 2026.'],
  shipping: ['Parcel arrived', 'Courier is delayed', 'Tracking number is ABC123'],
  logistics: ['Hotel is booked', 'Restaurant table reserved', 'Room booking confirmed', 'Password reset link arrived', 'Travel booking was confirmed'],
  spam: ['Newsletter arrived', 'Webinar invitation arrived', 'Marketing email received'],
  transient: ['She is running late', 'Out of office until Friday', 'Waiting for a reply', 'Will send it tomorrow', 'Reminder to bring a notebook'],
};
for (const [category, claims] of Object.entries(drops)) for (const fact of claims) test(`drops ${category}: ${fact}`, () => {
  expect(classifyCaptureValue({ fact })).toMatchObject({ verdict: 'drop', category });
});
const keeps = ['IV-to-subcutaneous delivery improves adherence', 'Operating cadence/calendar changes', 'Discount option in commercial terms', 'Follow up is part of the management process', 'Call quality improved', 'Meeting culture is inclusive', 'Meeting tomorrow approved the strategy', 'Courier contract signed', 'Hotel costs USD 500', 'Flight risk is high', 'Parking revenue grew 30%', 'Restaurant raised $2M', 'Reminder to file the patent', 'Appointment with FDA tomorrow', 'Call Monday about valuation', 'Parcel contains licensed IP', 'Will not attend the call tomorrow', 'Room booking must be approved', 'The project has a new owner', 'Sponsored research contract was signed'];
for (const fact of keeps) test(`keeps: ${fact}`, () => expect(classifyCaptureValue({ fact }).verdict).toBe('keep'));
test('notability is separate and substance vetoes all regex noise', () => {
  expect(classifyCaptureValue({ fact: 'Approved the strategy', notability: 'low' }).verdict).toBe('keep');
  expect(classifyCaptureValue({ fact: 'Newsletter about $5M valuation' }).verdict).toBe('keep');
  expect(classifyCaptureValue({ fact: 'Meeting tomorrow', claim_metric: 'mrr' }).verdict).toBe('keep');
  expect(['ON', 'true', 'yes', '1'].map(captureMode)).toEqual(['on', 'on', 'on', 'on']);
});
const broad = 'companies/acme-example';
const identities: Record<string, string> = { 'Alice Example': 'people/alice-example', 'Alice': 'people/alice-example', 'Project Sunrise': 'projects/sunrise', 'Northstar Example': 'companies/northstar-example', [broad]: broad, 'Acme Example': broad, 'people/alice-example': 'people/alice-example' };
function deps(withdrawn: string[] = []): RoutingDeps {
  return { resolve: async query => identities[query] ? { slug: identities[query]!, arm: 'alias_exact' } : { slug: null, miss: query === 'Annual Review' ? 'not_entity' : 'no_page' },
    typeOf: async slug => slug.startsWith('companies/') ? 'company' : slug.startsWith('people/') ? 'person' : 'project', isWithdrawn: async slug => withdrawn.includes(slug) };
}
const route = (fact: string, d = deps()) => chooseSpecificEntity({ fact, slug: broad, broadNames: ['Acme Example', 'Acme'] }, d);
for (const fact of ['Alice Example prefers written reports', 'people/alice-example prefers written reports', 'Project Sunrise has a new owner']) test(`routes ${fact}`, async () => expect((await route(fact)).rerouted).toBe(true));
for (const [fact, reason] of [
  ['Alice Example supports Project Sunrise', 'multiple_specific'],
  ['Alice Example works at Northstar Example', 'other_broad'],
  ['Alice Example works with Blake Unknown', 'competing_name'],
  ['Alice prefers written reports', 'bare_first_name'],
  ['Acme Example hired Alice Example', 'broad_mentioned'],
  ["Alice Example's company prefers written reports", 'possessive_broad'],
  ['No names here', 'no_specific'],
]) test(`routing veto ${reason}`, async () => expect(await route(fact)).toMatchObject({ slug: broad, rerouted: false, reason }));
test('withdrawal on either subject drops', async () => {
  expect(await route('Alice Example prefers reports', deps([broad]))).toMatchObject({ slug: null, reason: 'withdrawn_original' });
  expect(await route('Alice Example prefers reports', deps(['people/alice-example']))).toMatchObject({ slug: null, reason: 'withdrawn_target' });
});
test('non-broad targets and non-identity arms stay put', async () => {
  expect((await chooseSpecificEntity({ fact: 'Alice Example prefers reports', slug: 'projects/sunrise' }, deps())).reason).toBe('not_broad');
  const d = deps(); d.resolve = async () => ({ slug: 'people/alice-example', arm: 'same_name' });
  expect((await route('Alice Example prefers reports', d)).reason).toBe('non_identity');
});
test('nonentity and role/opening tokens do not compete', async () => {
  expect((await route('Met Alice Example at Annual Review')).rerouted).toBe(true);
  expect((await route('Alice Example is CEO')).rerouted).toBe(true);
});

test('bare names never route to person pages in a custom directory', async () => {
  const d = deps();
  d.resolve = async () => ({ slug: 'contacts/alice-example', arm: 'alias_exact' });
  d.typeOf = async slug => slug === broad ? 'company' : 'person';
  expect((await route('Alice prefers reports', d)).reason).toBe('bare_first_name');
});

const falsePositives = [
  'An intro call with X took place on July 20, 2026 about Y',
  'An intro call with X took place on <date> about Y',
  'The board meeting may revisit pricing', '24/7 call center',
  'Acme is a restaurant-POS startup',
  "Acme's drone completed its first autonomous flight",
  'Acme bought a parcel of land',
  'Alice writes a biotech newsletter with 20k readers',
  'Newsletter about $5M valuation',
  'An introductory call between Acme and Jane Roe of Example Capital took place on July 20, 2026.',
  'Acme held an intro call with John Doe of Example Bank on 2026-05-06 about sell-side market reads.',
  'Acme and Example Pharma had a meeting scheduled for July 28, 2026, to share cell-based assay data.',
  'Alice proposed a call for Friday at 9:00 AM to discuss scopes',
];
for (const fact of falsePositives) test(`false-positive corpus keeps: ${fact}`, () => {
  expect(classifyCaptureValue({ fact }).verdict).toBe('keep');
});
for (const fact of ['Thomas Example said Acme is still interested in the models',
  'Alice said Acme is still interested…',
  'Alice Example is co-founder and CEO of Acme', 'Alice Example said Acme, Inc. is hiring',
  'Alice Example likes her company', 'Alice Example likes his startup', 'Alice Example likes their firm']) {
  test(`broad routing corpus stays: ${fact}`, async () => expect((await route(fact)).rerouted).toBe(false));
}
test('standalone invoice routes to person', async () => {
  expect((await route('Alice Example paid invoice 123 on August 17')).slug).toBe('people/alice-example');
});

test('cap config accepts only nonnegative safe integers and cap checks are pure', async () => {
  const { validPageCapValue, checkPageCap, admitFenceAppends } = await import('../src/core/facts/page-cap.ts');
  for (const value of ['0', '1', '1000']) expect(validPageCapValue(value)).toBe(true);
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', '', '9007199254740992']) expect(validPageCapValue(value)).toBe(false);
  expect(checkPageCap({ warn: 2, max: 3 }, 3)).toEqual({ warn: true, refuse: true });
  const replacement = { replacesExisting: true };
  const append = { replacesExisting: false };
  expect(admitFenceAppends([append, replacement, append], { warn: 0, max: 2 }, 1))
    .toEqual({ admitted: [append, replacement], capped: 1 });
});

test('punctuated broad aliases match normalized mentions anywhere', async () => {
  const result = await chooseSpecificEntity({ fact: 'Alice Example said Acme Inc is still interested',
    slug: 'companies/holding-example', broadNames: ['Acme, Inc.'] }, {
    ...deps(), typeOf: async slug => slug === 'companies/holding-example' ? 'company' : 'person',
  });
  expect(result).toMatchObject({ slug: 'companies/holding-example', reason: 'broad_mentioned', rerouted: false });
});
