import { expect, test } from 'bun:test';
import { classifyCaptureValue, chooseSpecificEntity, captureMode, type RoutingDeps } from '../src/core/facts/capture-policy.ts';
const drops = {
  scheduling: ['Meeting tomorrow at noon', 'Call at 3pm', 'Appointment Monday', 'Rescheduled meeting to Friday', 'Will attend the meeting today', 'Invite for Tuesday call', 'Meeting 2026-10-20 in room 2'],
  shipping: ['Parcel arrived', 'Courier is delayed', 'Tracking number is ABC123', 'Delivery ETA is tomorrow', 'Customs status is pending', 'Physical shipment left the depot'],
  logistics: ['Hotel is booked', 'Flight leaves tomorrow', 'Restaurant table reserved', 'Room booking confirmed', 'Parking is behind the hotel', 'Wifi is unavailable', 'Password reset link arrived', 'Travel booking was confirmed'],
  spam: ['Newsletter arrived', 'Unsubscribe link is broken', 'Limited time offer', 'Sponsored email', 'Promotional offer for subscribers', 'Webinar invitation arrived', 'Marketing email received'],
  transient: ['She is running late', 'Out of office until Friday', 'Waiting for a reply', 'Will send it tomorrow', 'Reminder to bring a notebook'],
};
for (const [category, claims] of Object.entries(drops)) for (const fact of claims) test(`drops ${category}: ${fact}`, () => {
  expect(classifyCaptureValue({ fact })).toMatchObject({ verdict: 'drop', category });
});
const keeps = ['IV-to-subcutaneous delivery improves adherence', 'Operating cadence/calendar changes', 'Discount option in commercial terms', 'Follow up is part of the management process', 'Call quality improved', 'Meeting culture is inclusive', 'Meeting tomorrow approved the strategy', 'Courier contract signed', 'Hotel costs USD 500', 'Flight risk is high', 'Parking revenue grew 30%', 'Restaurant raised $2M', 'Reminder to file the patent', 'Appointment with FDA tomorrow', 'Call Monday about valuation', 'Parcel contains licensed IP', 'Will not attend the call tomorrow', 'Room booking must be approved', 'The project has a new owner', 'Sponsored research contract was signed'];
for (const fact of keeps) test(`keeps: ${fact}`, () => expect(classifyCaptureValue({ fact }).verdict).toBe('keep'));
test('low and spam override substance, metrics veto noise', () => {
  expect(classifyCaptureValue({ fact: 'Approved the strategy', notability: 'low' }).category).toBe('low_notability');
  expect(classifyCaptureValue({ fact: 'Newsletter about $5M valuation' }).category).toBe('spam');
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
  ['Acme Example hired Alice Example', 'broad_subject'],
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
