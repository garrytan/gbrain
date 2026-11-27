/**
 * The synthetic household (agent platform plan, H1): invented people and 40 household records, written through
 * household_add and household_mark, with the ranking a person computed by hand for AS_OF. No real household: every
 * name is invented (household-example). Used by test/household-*.test.ts and by scripts/synthetic-household.ts,
 * which seeds a fresh brain for W1's cross-harness check.
 */

export const AS_OF = '2026-12-01';
export const TIMEZONE = 'America/Los_Angeles';
export const HOUSEHOLD = 'household-example';

/** Subject pages and their household_role. robin-example is the child. */
export const PEOPLE: Array<{ slug: string; role: 'adult' | 'child' | 'helper' | 'pet' }> = [
  { slug: 'people/alice-example', role: 'adult' },
  { slug: 'people/bob-example', role: 'adult' },
  { slug: 'people/robin-example', role: 'child' },
  { slug: 'people/casey-example', role: 'helper' },
  { slug: 'pets/biscuit-example', role: 'pet' },
];

export type AddCall = { kind: string; title: string } & Record<string, unknown>;

/** The 40 household_add calls, in order. The comments carry the hand computation for AS_OF (window 7). */
export const RECORDS: AddCall[] = [
  // In the due window. score = state (overdue 50, at_risk 30, upcoming 10) - min(days_left, 14) + kind weight.
  { kind: 'bill', title: 'Water bill', due: '2026-11-28', recurs: 'monthly', amount: 60, currency: 'USD' }, // -3 overdue: 50+3+6 = 59
  { kind: 'deadline', title: 'Permission slip', due: '2026-11-30', about: ['people/bob-example'] }, // -1 overdue: 50+1+5 = 56
  { kind: 'deadline', title: 'Field trip form', due: '2026-12-02', school: true, about: ['people/robin-example'] }, // 1 at_risk: 30-1+5 = 34
  { kind: 'bill', title: 'Electric bill', due: '2026-12-03', recurs: 'monthly', amount: 85, currency: 'USD' }, // 2 at_risk: 30-2+6 = 34
  { kind: 'return', title: 'Winter boots return', due: '2026-12-03' }, // 2 at_risk (lead 3): 30-2+5 = 33
  { kind: 'bill', title: 'Internet bill', due: '2026-11-05', recurs: 'monthly' }, // marked paid below: next 12-05, 4 at_risk: 30-4+6 = 32
  { kind: 'supply', title: 'Milk', cadence: '7d', last_done: '2026-11-26' }, // next 12-03, 2 at_risk: 30-2+2 = 30
  { kind: 'supply', title: 'Coffee beans', cadence: '14d', last_done: '2026-11-20' }, // next 12-04, 3 at_risk: 30-3+2 = 29
  { kind: 'deadline', title: 'Library books', due: '2026-12-07' }, // 6 at_risk (lead 7): 30-6+5 = 29
  { kind: 'supply', title: 'Dog food', cadence: '30d', last_done: '2026-11-05', about: ['pets/biscuit-example'] }, // next 12-05, 4 at_risk: 30-4+2 = 28
  { kind: 'appointment', title: 'Car service', due: '2026-12-08' }, // 7 at_risk (lead 21): 30-7+3 = 26
  { kind: 'birthday', title: 'Bob birthday', on: '12-10', about: ['people/bob-example'] }, // 9 at_risk, no gift: 30-9+2 = 23
  { kind: 'credit', title: 'Store credit', due: '2026-12-12', amount: 25, currency: 'USD' }, // 11 at_risk (lead 14): 30-11+4 = 23
  { kind: 'appointment', title: 'Dentist cleaning', cadence: '6m', last_done: '2026-06-15', about: ['people/alice-example'] }, // +180d = 12-12, 11 at_risk: 30-11+3 = 22
  { kind: 'birthday', title: 'Alice birthday', on: '12-06', about: ['people/alice-example'] }, // gift bought below: 5 upcoming: 10-5+2 = 7
  { kind: 'supply', title: 'Toothpaste', cadence: '30d', last_done: '2026-11-08', lead_days: 2 }, // next 12-08, 7 upcoming (lead 2): 10-7+2 = 5
  // Outside the window, unknown, paused or done.
  { kind: 'supply', title: 'Laundry detergent', cadence: '30d' }, // never bought: unknown
  { kind: 'supply', title: 'Paper towels', cadence: '30d', last_done: '2026-11-22' }, // 12-22: ok
  { kind: 'bill', title: 'Gym membership', due: '2026-12-02', recurs: 'monthly' }, // paused below: ok
  { kind: 'bill', title: 'Rent', due: '2026-12-01', recurs: 'monthly', amount: 2000, currency: 'USD' }, // paid below: next 2027-01-01: ok
  { kind: 'deadline', title: 'Tax form', due: '2026-12-20' }, // 19: ok
  { kind: 'bill', title: 'Phone bill', due: '2026-12-25', recurs: 'monthly' }, // 24: ok
  { kind: 'bill', title: 'Insurance', due: '2027-01-15', recurs: 'yearly' }, // ok
  { kind: 'birthday', title: 'Robin birthday', on: '04-02', about: ['people/robin-example'] }, // ok (adults only: child)
  { kind: 'birthday', title: 'Casey birthday', on: '08-19', about: ['people/casey-example'] }, // ok
  { kind: 'birthday', title: 'Leap day birthday', on: '02-29' }, // 2027-02-28: ok
  { kind: 'supply', title: 'Olive oil', cadence: '60d', last_done: '2026-11-10' }, // ok
  { kind: 'supply', title: 'Batteries', cadence: '6m', last_done: '2026-10-01' }, // ok
  { kind: 'supply', title: 'Water filter', cadence: '3m', last_done: '2026-11-15' }, // ok
  { kind: 'appointment', title: 'Robin checkup', cadence: '1y', last_done: '2026-03-01', about: ['people/robin-example'] }, // 2027-03-01: ok (adults only)
  { kind: 'appointment', title: 'Vet visit', cadence: '1y', last_done: '2026-05-20', about: ['pets/biscuit-example'] }, // ok
  { kind: 'deadline', title: 'Science fair entry', due: '2027-01-20', school: true }, // ok
  { kind: 'deadline', title: 'Passport renewal', due: '2027-03-01', about: ['people/alice-example'] }, // ok
  { kind: 'return', title: 'Lamp return', due: '2026-12-15' }, // 14 (lead 3): ok
  { kind: 'credit', title: 'Airline voucher', due: '2027-06-30' }, // ok
  { kind: 'credit', title: 'Gift card', due: '2027-12-31' }, // ok
  { kind: 'bill', title: 'Streaming plan', due: '2026-12-20', recurs: 'monthly' }, // ok
  { kind: 'deadline', title: 'Old form', due: '2026-11-01' }, // submitted below: done, ok
  { kind: 'supply', title: 'Old supply', cadence: '30d', last_done: '2026-10-01' }, // archived below: left out
  { kind: 'birthday', title: 'Old birthday', on: '01-05' }, // archived below: left out
];

/** household_mark calls applied after the adds (slug tail, event, params). */
export const MARKS: Array<{ title: string; event: string; on?: string; due?: string }> = [
  { title: 'Internet bill', event: 'paid', on: '2026-11-04' },
  { title: 'Alice birthday', event: 'gift_bought', on: '2026-11-25' },
  { title: 'Gym membership', event: 'pause', on: '2026-11-15' },
  { title: 'Rent', event: 'paid', on: '2026-11-30' },
  { title: 'Old form', event: 'submitted', on: '2026-10-30' },
  { title: 'Old supply', event: 'archive', on: '2026-11-01' },
  { title: 'Old birthday', event: 'archive', on: '2026-11-01' },
];

/** The hand-computed household_due ranking for AS_OF (include due, window 7), by title. */
export const EXPECTED_DUE = [
  'Water bill', 'Permission slip', 'Field trip form', 'Electric bill', 'Winter boots return', 'Internet bill', 'Milk', 'Coffee beans',
  'Library books', 'Dog food', 'Car service', 'Bob birthday', 'Store credit', 'Dentist cleaning', 'Alice birthday', 'Toothpaste',
];
export const EXPECTED_COUNTS = { overdue: 2, at_risk: 12, upcoming: 2, ok: 21, unknown: 1, invalid: 0 };
/** Records that stay adults only: money, returns and everything about the child. */
export const ADULTS_ONLY = ['Water bill', 'Field trip form', 'Electric bill', 'Winter boots return', 'Internet bill', 'Store credit', 'Gym membership', 'Rent',
  'Phone bill', 'Insurance', 'Robin birthday', 'Robin checkup', 'Lamp return', 'Airline voucher', 'Gift card', 'Streaming plan'];

export type Call = (op: string, params: Record<string, unknown>) => Promise<any>;

/** Seeds the household through `call` (household_add then household_mark); returns slug by title. */
export async function seedSyntheticHousehold(call: Call): Promise<Map<string, string>> {
  const slugs = new Map<string, string>();
  const roles = new Map(PEOPLE.map(p => [p.slug, p.role]));
  const classified = new Set<string>();
  for (const record of RECORDS) {
    const about = (record.about as string[] | undefined) ?? [];
    const unclassified = about.filter(s => !classified.has(s));
    const role = unclassified.length === 1 ? roles.get(unclassified[0]!) : undefined;
    const out = await call('household_add', { ...record, ...(role ? { about_role: role } : {}) });
    if (role) classified.add(unclassified[0]!);
    slugs.set(record.title, out.slug);
  }
  for (const mark of MARKS) await call('household_mark', { slug: slugs.get(mark.title)!, event: mark.event, ...(mark.on ? { on: mark.on } : {}), ...(mark.due ? { due: mark.due } : {}) });
  return slugs;
}
