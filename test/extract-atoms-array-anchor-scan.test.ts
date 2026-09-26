/**
 * Atoms-array ANCHOR SCAN (`parseAtomsOutcomeInner`).
 *
 * The extractor used to commit to `cleaned.indexOf('[')` — the FIRST left
 * bracket anywhere in the response. Any bracket in a preamble hijacked that
 * anchor, so a response carrying a perfectly good atoms array was reported as
 * `unparseable JSON array` and the page counted a deterministic failure.
 *
 * This is not a hypothetical: a brain whose house style mandates inline
 * `[Source: …]` citations and `[[wikilink]]` backlinks, and whose transcripts
 * carry `[user]` / `[assistant]` / `[tool: …]` role markers, hands the model
 * bracketed prose to echo while it narrates its answer.
 *
 * THE HAZARD the scan must avoid: `atomsFromParsedArray` skips every element
 * failing the shape gate, so a parseable-but-wrong array (say an array of
 * strings lifted out of prose) yields `ok: true, atoms: []`. A zero-yield
 * result is what TOMBSTONES a page (#2144), so a shape-blind scan would
 * permanently retire pages that still had real content — worse than the bug.
 * Acceptance therefore requires >= 1 atom-shaped element, not mere parseability.
 *
 * NOTE: assertions go through the PUBLIC `parseAtomsOutcome` entry point, which
 * exists pre-fix, so a reverted-source run fails on BEHAVIOUR rather than dying
 * with a module-load SyntaxError (the vacuous failure class in CONTRIBUTING.md).
 */
import { describe, expect, test } from 'bun:test';
import { parseAtomsOutcome } from '../src/core/cycle/extract-atoms.ts';

/** A minimally valid atom: title + atom_type (in ATOM_TYPES) + body. */
const ATOM = {
  title: 'Brackets in prose hijack the parse anchor',
  atom_type: 'insight',
  body: 'The extractor anchored on the first bracket, not the first array.',
};
const ATOM_ARRAY = JSON.stringify([ATOM]);

function atomsOf(raw: string) {
  const outcome = parseAtomsOutcome(raw);
  if (!outcome.ok) throw new Error(`expected ok, got reason: ${outcome.reason}`);
  return outcome.atoms;
}

describe('anchor scan — bracketed preamble no longer hijacks the parse', () => {
  test('recovers the array after a preamble carrying a [Source: …] citation', () => {
    const raw =
      'Looking at the page, the claim is supported by ' +
      '[Source: alice-example, agent session, 2026-09-03], so here are the atoms:\n' +
      ATOM_ARRAY;
    expect(atomsOf(raw)).toHaveLength(1);
    expect(atomsOf(raw)[0]!.title).toBe(ATOM.title);
  });

  test('recovers the array after a preamble naming a [[wikilink]]', () => {
    const raw = 'The page backlinks [[people/alice-example]] and [[companies/acme-example]].\n' + ATOM_ARRAY;
    expect(atomsOf(raw)).toHaveLength(1);
  });

  test('recovers the array after a transcript [user] role marker in the preamble', () => {
    const raw = 'The [user] turn sets up the problem and [assistant] answers it.\n' + ATOM_ARRAY;
    expect(atomsOf(raw)).toHaveLength(1);
  });

  test('preamble recovery: a parseable-but-WRONG array ahead of the real one is skipped', () => {
    // `["a","b"]` parses cleanly but yields no atom, so the scan moves on and
    // recovers the real payload below. The first-bracket offset now parses
    // successfully on its own (findArrayCloseIndex correctly bounds it to
    // `["a","b"]`) and is rejected by the SHAPE GATE instead — this test still
    // pins recovery (the scan moving past a non-atom offset to the real one),
    // the gate itself is pinned directly further down.
    const raw = 'Candidate labels were ["a","b"] before I settled on:\n' + ATOM_ARRAY;
    const atoms = atomsOf(raw);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.title).toBe(ATOM.title);
  });

  test('preamble recovery: an array of atom-shaped-but-empty objects ahead of the real one is skipped', () => {
    // Objects, but every one fails the shape gate (no title/atom_type/body).
    const raw = 'Draft skeleton: [{"note":"tbd"},{"note":"tbd"}] — final answer:\n' + ATOM_ARRAY;
    expect(atomsOf(raw)).toHaveLength(1);
  });
});

describe('anchor scan — the shape gate is what accepts a candidate (atoms.length > 0)', () => {
  // THE HAZARD, pinned directly. In each case a later offset holds an array
  // that PARSES but yields zero atoms, and no offset holds a real one. A scan
  // that accepted mere parseability would return `ok: true, atoms: []` — the
  // zero-yield that tombstones a page — instead of the FIRST offset's failure.
  test('a parseable array of strings after bracketed prose is NOT accepted', () => {
    const outcome = parseAtomsOutcome('see [Source: X] then candidate labels ["a","b"]');
    expect(outcome).toEqual({ ok: false, reason: 'unparseable JSON array' });
  });

  test('a parseable array of shape-failing objects after bracketed prose is NOT accepted', () => {
    const outcome = parseAtomsOutcome('see [Source: X] then [{"note":"tbd"}]');
    expect(outcome).toEqual({ ok: false, reason: 'unparseable JSON array' });
  });
});

describe('anchor scan — MAX_ARRAY_ANCHOR_CANDIDATES bounds the scan at 64 offsets', () => {
  // Each `[tN]` token is one failing `[` offset; the atoms array itself holds
  // exactly one `[`, so 63 tokens put it at the 64th (last tried) offset and
  // 64 tokens push it past the cap.
  const preamble = (n: number) => Array.from({ length: n }, (_, i) => `[t${i}]`).join(' ');

  test('63 bracketed preamble tokens: the array at the 64th offset is still recovered', () => {
    expect(atomsOf(preamble(63) + ' ' + ATOM_ARRAY)).toHaveLength(1);
  });

  test("64 bracketed preamble tokens: cap reached, the FIRST offset's failure is returned", () => {
    const outcome = parseAtomsOutcome(preamble(64) + ' ' + ATOM_ARRAY);
    expect(outcome).toEqual({ ok: false, reason: 'unparseable JSON array' });
  });
});

describe('anchor scan — preserved behaviour', () => {
  test('an honest empty array is still a zero-yield SUCCESS, not malformed output', () => {
    // #4148 keeps "malformed output" and "the model found nothing" distinct:
    // only the latter is a legitimate tombstone. The scan must not blur that
    // by reclassifying `[]` as a parse failure just because it yields no atom.
    const outcome = parseAtomsOutcome('[]');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.atoms).toEqual([]);
  });

  test('an empty array after prose is still a zero-yield success', () => {
    const outcome = parseAtomsOutcome('Nothing worth extracting here.\n[]');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.atoms).toEqual([]);
  });

  test('a clean array with no preamble is unchanged', () => {
    expect(atomsOf(ATOM_ARRAY)).toHaveLength(1);
  });

  test('a fenced array is unchanged', () => {
    expect(atomsOf('```json\n' + ATOM_ARRAY + '\n```')).toHaveLength(1);
  });

  test('trailing prose after a valid array is still recovered', () => {
    expect(atomsOf(ATOM_ARRAY + '\n\nThose are the atoms I found.')).toHaveLength(1);
  });

  test('trailing prose containing a bracketed citation does not hijack the recovery boundary', () => {
    // The trim-back recovery used to find the array's boundary with a naive
    // `lastIndexOf(']')`. A valid array followed by a `[Source: X]`-style
    // citation has that citation's `]` sorting AFTER the array's own closing
    // bracket, so the naive scan trimmed back to the wrong `]` and included
    // the dangling citation text in the re-parse attempt — which then failed
    // as `unparseable JSON array` even though the array itself was fine.
    const raw = ATOM_ARRAY + '\nSee [Source: alice-example, agent session, 2026-09-03].';
    expect(atomsOf(raw)).toHaveLength(1);
    expect(atomsOf(raw)[0]!.title).toBe(ATOM.title);
  });

  test('trailing prose with an unmatched trailing bracket after a valid array is still recovered', () => {
    // A pathological variant: a stray, unbalanced `]` after the array (no
    // opening `[` to pair with it). The array's own boundary must still win.
    const raw = ATOM_ARRAY + '\nas noted above]';
    expect(atomsOf(raw)).toHaveLength(1);
  });

  test('recovery still finds the true boundary when the array body has escaped quotes, brackets inside strings, and a nested array', () => {
    // Exercises findArrayCloseIndex's string/escape handling together with
    // the depth counter: the atom body embeds an escaped quote, a literal
    // `[bracket]`-looking substring inside a JSON string (must not perturb
    // depth), and a nested array value — all ahead of a trailing citation
    // that forces the recovery path to run at all.
    const nestedAtom = {
      title: 'Escapes and nesting inside the array body',
      atom_type: 'insight' as const,
      body: 'She said \\"data is in [brackets]\\" and listed refs [1, 2].',
      tags: ['[a]', '[b]'],
    };
    const raw = JSON.stringify([nestedAtom]) + '\nSee [Source: alice-example, 2026-09-03].';
    const atoms = atomsOf(raw);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.title).toBe(nestedAtom.title);
  });

  test('two complete top-level arrays: the FIRST one wins, pinning the anchor scan precedence', () => {
    // Not a documented/prompted output shape (extract_atoms asks for ONE
    // array), but worth pinning explicitly: finding each candidate's own real
    // boundary (instead of occasionally over-running into later text) means
    // the first candidate that parses to >=1 atom now succeeds where it
    // previously sometimes failed and fell through to a later offset. That is
    // the anchor scan's existing first-candidate-wins policy applying
    // correctly, not a new precedence rule — see the NOTE on parseArrayAtOffset.
    const secondAtom = { ...ATOM, title: 'A later, different array' };
    const raw = ATOM_ARRAY + '\nCorrected answer:\n' + JSON.stringify([secondAtom]);
    const atoms = atomsOf(raw);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.title).toBe(ATOM.title);
  });

  test('an empty array after BRACKETED prose is a zero-yield success (#4948 rule holds at any offset)', () => {
    // The #4948 prompt tells the model to answer exactly `[]` when nothing is
    // extractable. A model that first echoes a bracketed citation and then
    // obeys used to lose the `[]` to the shape gate: the first offset failed
    // to parse, no later offset yielded an atom, so the FIRST offset's failure
    // was returned — three strikes and the transcript was tombstoned + the
    // phase halted for content that was honestly empty.
    expect(parseAtomsOutcome('[Source: x] nothing here.\n[]')).toEqual({ ok: true, atoms: [] });
    expect(parseAtomsOutcome('Checked [[people/alice-example]] — no atoms.\n\n[]')).toEqual({ ok: true, atoms: [] });
  });

  test('a NON-empty array with no atom-shaped element is a counted failure, not a zero-yield success', () => {
    // Pre-fix this returned `ok: true, atoms: []` — the zero-yield shape that
    // tombstones the item FOREVER on the first try — for output that was
    // simply malformed (wrong keys). Malformed output rides the failure streak
    // (retries, then the bounded MAX_DETERMINISTIC_FAILURES tombstone), like
    // every other parse failure; only a literal `[]` is an honest zero-yield.
    expect(parseAtomsOutcome('[{"claim":"Water is wet","kind":"fact"}]')).toEqual({
      ok: false,
      reason: 'array had no atom-shaped elements',
    });
    expect(parseAtomsOutcome('["a","b"]')).toEqual({ ok: false, reason: 'array had no atom-shaped elements' });
  });
});

describe('anchor scan — failure reasons still describe the FIRST bracket', () => {
  test('no bracket at all', () => {
    const outcome = parseAtomsOutcome('I could not extract anything from this content.');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('no JSON array in response');
  });

  test('an opened-but-never-closed array reports unterminated, not unparseable', () => {
    const outcome = parseAtomsOutcome('here goes [{"title":"a"');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unterminated JSON array');
  });

  test('bracketed prose with no recoverable array anywhere still reports unparseable', () => {
    // The scan exhausts every candidate and falls back to the FIRST offset's
    // reason — never a later offset's, which would silently change the string
    // the drain surfaces as `last_error`.
    const outcome = parseAtomsOutcome('see [Source: X] and [[people/alice-example]] for details]');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unparseable JSON array');
  });
});
