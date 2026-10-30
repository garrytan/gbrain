/**
 * #7160: person and organization name variants for entity lookup (pure).
 *
 * The entity card's precision arms (alias, exact title, exact slug, slug
 * suffix) only match a name as written. Names reach agents in other shapes:
 * a nickname or diminutive ("Allie Example"), an initial ("A. Example"), the
 * surname alone, a one-letter typo, reversed order ("Example, Alice") or a
 * title in front ("Mayor Example", "Dr. Alice Example"). This module decides
 * whether a query and a candidate page name are the same name under one of
 * those shapes, and how strong that match is. It never decides alone: the
 * resolver (verbs/entity-card.ts) accepts a variant only when exactly one
 * entity page holds the strongest match, so a near-name never resolves to a
 * different person.
 *
 * Leaf module: text primitives only, no engine imports.
 */

import { foldNonDecomposingLatin } from '../latin-fold.ts';

/** Variant kinds, strongest first (NAME_MATCH_RANK). */
export type NameMatchKind = 'normalized' | 'honorific' | 'reordered' | 'diminutive' | 'initial' | 'typo' | 'surname';

export const NAME_MATCH_RANK: Readonly<Record<NameMatchKind, number>> = {
  normalized: 0, honorific: 1, reordered: 2, diminutive: 3, initial: 4, typo: 5, surname: 6,
};

/** Kinds that name a person by part of the name only: they also require a single matching page overall. */
export const WEAK_NAME_MATCHES: ReadonlySet<NameMatchKind> = new Set(['typo', 'surname']);

/**
 * Leading honorifics and roles that sit in front of a name in titles, slugs
 * and prose ("mayor-example", "Dr. Alice Example", "CEO Alice Example").
 * Words that are also common given names or surnames (king, judge, chief,
 * general, saint, father, chair) are left out: stripping them would turn a
 * name into a different one ("Judge Example" stays a name).
 */
export const NAME_TITLE_TOKENS: ReadonlySet<string> = new Set([
  'mr', 'mrs', 'ms', 'mx', 'miss', 'dr', 'doctor', 'prof', 'professor', 'sir', 'dame', 'lord', 'lady',
  'rev', 'reverend', 'hon', 'honorable', 'mayor', 'senator', 'sen', 'rep', 'representative',
  'congressman', 'congresswoman', 'gov', 'governor', 'president', 'pres', 'vp',
  'chancellor', 'minister', 'secretary', 'ambassador', 'councilmember', 'councilman', 'councilwoman',
  'magistrate',
  'commissioner', 'sheriff', 'ceo', 'cfo', 'cto', 'coo', 'cmo', 'cpo', 'founder', 'cofounder',
  'chairman', 'chairwoman', 'col', 'colonel', 'capt', 'captain', 'lt', 'sgt', 'admiral',
]);

const NAME_SUFFIX_TOKENS: ReadonlySet<string> = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'esq', 'mba', 'cpa']);

/**
 * Common English given-name groups: names in one group are the same given
 * name (formal form, short forms, diminutives). A name may sit in several
 * groups ("alex"). Deliberately conservative: a pair that often names two
 * different people is left out.
 */
const NICKNAME_GROUPS: readonly string[] = [
  'abigail abby abbie gail', 'alexander alex alec al sasha xander', 'alexandra alex alexa lexi sandra sasha allie',
  'alice allie ally', 'alison allison ali allie', 'allan alan al', 'albert al bert bertie', 'alfred alf alfie fred',
  'amanda mandy manda', 'andrew andy drew', 'angela angie', 'anthony tony ant', 'antonio tony', 'arthur art artie',
  'barbara barb barbie babs', 'benjamin ben benji benny', 'bernard bernie', 'beverly bev', 'bradley brad',
  'calvin cal', 'cameron cam', 'catherine cathy cat kate katie', 'katherine kathy kate katie kat', 'kathryn kathy kate katie',
  'charles charlie chuck chas', 'charlotte charlie lottie', 'christina chris tina', 'christine chris tina chrissy',
  'christopher chris kit topher', 'cynthia cindy', 'daniel dan danny', 'danielle dani', 'david dave davey',
  'deborah debbie deb debra', 'dennis denny', 'donald don donnie', 'dorothy dot dottie', 'douglas doug',
  'edward ed eddie ted ned', 'edwin ed eddie', 'eleanor ellie nell nora', 'elizabeth liz lizzie beth betty eliza libby',
  'emily em emmy', 'eugene gene', 'frances fran franny', 'francis frank fran', 'franklin frank', 'frederick fred freddie rick',
  'gabriel gabe', 'gabrielle gabby', 'gerald gerry jerry', 'gregory greg', 'harold hal harry', 'harrison harry',
  'henry hank harry hal', 'herbert herb', 'isabel izzy bella', 'isabella izzy bella', 'jacob jake', 'james jim jimmy jamie',
  'jane janie', 'janet jan', 'jeffrey jeff', 'jennifer jen jenny', 'jessica jess jessie', 'johnathan jon john',
  'jonathan jon jonny', 'john johnny jack', 'joseph joe joey', 'josephine jo josie', 'joshua josh', 'judith judy',
  'kenneth ken kenny', 'kimberly kim', 'lawrence larry', 'leonard leo len lenny', 'louis lou', 'louise lou',
  'madeline maddie maddy', 'margaret maggie meg peggy marge', 'matthew matt', 'melissa mel missy', 'michael mike mikey mick',
  'michelle shelly', 'nathan nate', 'nathaniel nate nat', 'nicholas nick nicky', 'nicole nikki', 'oliver ollie',
  'pamela pam', 'patricia pat patty trish', 'patrick pat paddy', 'peter pete', 'philip phil', 'phillip phil',
  'rebecca becky becca', 'richard rick ricky dick rich', 'robert rob bob bobby robbie bert', 'roberta bobbie',
  'ronald ron ronnie', 'rosemary rose rosie', 'samantha sam sammy', 'samuel sam sammy', 'sandra sandy',
  'sarah sara sally', 'stephanie steph', 'stephen steve stevie', 'steven steve stevie', 'stuart stu', 'susan sue susie',
  'suzanne sue suzy', 'theodore ted teddy theo', 'thomas tom tommy', 'timothy tim timmy', 'valerie val',
  'victoria vicky tori', 'vincent vince vinny', 'walter walt wally', 'william will bill billy liam willy',
  'zachary zach zack',
];

const NICKNAMES: ReadonlyMap<string, ReadonlySet<number>> = (() => {
  const map = new Map<string, Set<number>>();
  NICKNAME_GROUPS.forEach((group, i) => {
    for (const name of group.split(' ')) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name)!.add(i);
    }
  });
  return map;
})();

/** Lowercase, accent-free name words (punctuation and separators dropped). */
export function nameWords(text: string): string[] {
  const folded = foldNonDecomposingLatin((text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase());
  return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export interface PersonName {
  /** The name words without leading titles or trailing suffixes. */
  core: string[];
  /** The title words removed from the front ("mayor", "dr"). */
  titles: string[];
}

/** nameWords, keeping a hyphenated word whole ("Smith-Jones" is one surname, not two names); a slug basename (`alice-example`, no space, lowercase) splits. */
function personTokens(text: string): string[] {
  if (!/\s/.test(text ?? '') && text === (text ?? '').toLowerCase()) return nameWords(text);
  const folded = foldNonDecomposingLatin((text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase());
  return folded.split(/[^\p{L}\p{N}-]+/u).map(t => t.replace(/^-+|-+$/g, '')).filter(Boolean);
}

/** Split a name into its core words and the titles in front of it; a name that is only titles keeps them as its core. */
export function parsePersonName(text: string): PersonName {
  const words = personTokens(text);
  let start = 0;
  while (start < words.length - 1 && NAME_TITLE_TOKENS.has(words[start]!)) start++;
  let end = words.length;
  while (end - 1 > start && NAME_SUFFIX_TOKENS.has(words[end - 1]!)) end--;
  return { core: words.slice(start, end), titles: words.slice(0, start) };
}

/** The name as written, without its leading title words ("Mayor Quill-Example" -> "Quill-Example"). */
export function stripLeadingTitles(text: string): string {
  const parts = (text ?? '').trim().split(/\s+/);
  let start = 0;
  while (start < parts.length - 1 && nameWords(parts[start]!).every(w => NAME_TITLE_TOKENS.has(w))) start++;
  return parts.slice(start).join(' ');
}

/** True when the page name starts with a title word ("Mayor Example", `people/dr-alice-example`). */
export function hasLeadingTitle(text: string): boolean {
  return parsePersonName(text).titles.length > 0;
}

function sameGivenName(a: string, b: string): boolean {
  if (a === b) return true;
  const ga = NICKNAMES.get(a);
  const gb = NICKNAMES.get(b);
  if (ga && gb) for (const g of ga) if (gb.has(g)) return true;
  return false;
}

/** Alternate forms that are English stopwords: full-text search drops them, so a variant would lose its given name. */
const STOPWORD_GIVEN_FORMS: ReadonlySet<string> = new Set(['will', 'don']);

/**
 * #7471: the name with its given name (the first word after any leading
 * titles) swapped for each other form in the given name's nickname groups,
 * in group order and capped: "Matt Example" -> ["matthew example"]. Empty
 * unless the name has 2-4 words and a surname after the given name.
 */
export function givenNameVariants(name: string, max = 6): string[] {
  const words = nameWords(name);
  if (words.length < 2 || words.length > 4) return [];
  let i = 0;
  while (i < words.length - 1 && NAME_TITLE_TOKENS.has(words[i]!)) i++;
  if (i >= words.length - 1) return [];
  const forms = new Set<string>();
  for (const g of NICKNAMES.get(words[i]!) ?? []) {
    for (const form of NICKNAME_GROUPS[g]!.split(' ')) {
      if (form !== words[i] && !STOPWORD_GIVEN_FORMS.has(form)) forms.add(form);
    }
  }
  return [...forms].slice(0, max).map(form => [...words.slice(0, i), form, ...words.slice(i + 1)].join(' '));
}

/** Optimal-string-alignment distance, capped: returns cap + 1 once the distance exceeds cap. */
export function editDistance(a: string, b: string, cap = 1): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length]![b.length]!;
}

const sameWords = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((w, i) => w === b[i]);
const sortedKey = (a: readonly string[]) => [...a].sort().join(' ');

/**
 * The strongest variant shape under which `query` names `candidate` (a page
 * title or slug basename), or null. Multi-word shapes need a candidate of at
 * least two words; `surname` needs a one-word query of three or more
 * letters equal to the candidate's last word.
 */
export function matchNameVariant(query: string, candidate: string): NameMatchKind | null {
  const q = parsePersonName(query);
  const c = parsePersonName(candidate);
  if (!q.core.length || !c.core.length) return null;
  if (sameWords(q.core, c.core)) return q.titles.length || c.titles.length ? 'honorific' : 'normalized';
  if (c.core.length < 2) return null;
  if (q.core.length === c.core.length && sortedKey(q.core) === sortedKey(c.core)) return 'reordered';
  if (q.core.length === 1) return q.core[0]!.length >= 3 && q.core[0] === c.core[c.core.length - 1] ? 'surname' : null;
  if (q.core.length !== c.core.length) return null;
  const last = q.core.length - 1;
  if (q.core[last] === c.core[last]) {
    const given = q.core.slice(0, last);
    const cGiven = c.core.slice(0, last);
    if (given.every((w, i) => w === cGiven[i] || sameGivenName(w, cGiven[i]!))) return 'diminutive';
    if (given.every((w, i) => w === cGiven[i] || sameGivenName(w, cGiven[i]!) || (w.length === 1 && cGiven[i]!.startsWith(w)))) return 'initial';
  }
  // One edit in the surname only: a given name one letter off (Jon, Joe) is usually another person.
  const qLast = q.core[last]!;
  const cLast = c.core[last]!;
  if (qLast.length >= 5 && q.core.slice(0, last).every((w, i) => w === c.core[i] || sameGivenName(w, c.core[i]!)) && editDistance(qLast, cLast) === 1) return 'typo';
  return null;
}

/**
 * The words a candidate query should probe titles with: the query's core
 * name words of three or more letters (initials and titles carry no signal).
 */
export function probeWords(query: string): string[] {
  return [...new Set(parsePersonName(query).core.filter(w => w.length >= 3))];
}
