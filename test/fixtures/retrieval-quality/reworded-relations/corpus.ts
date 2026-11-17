/**
 * A small relationship world for reworded one-hop questions (GST-2899). Ten
 * companies, each with a founder, an engineer, an investor, an adviser and
 * two people who only crossed its path, a board meeting and a few concept
 * pages that hold the relation words in their titles. Every name is a
 * placeholder. Each person's page links the company in its dated timeline,
 * the way people pages do, so a question that names the company in words the
 * pages never use ("Who is on the payroll at Quorvex?") is answered only by a
 * search step that matches timelines on any of the question's words.
 * Data only: the tests seed it.
 */
export interface RelationPage {
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
}

export interface RelationQuestion {
  id: string;
  relation: 'works_at' | 'invested_in' | 'advises';
  wording: 'template' | 'reworded';
  text: string;
  /** Pages that answer it. */
  relevant: string[];
}

const COMPANIES = ['Quorvex', 'Nastel', 'Kelmit', 'Riulten', 'Velmora', 'Tarsik', 'Ombrel', 'Juniva', 'Halcet', 'Zirella'];
const SECTORS = ['data infrastructure', 'payments', 'robotics', 'climate software', 'developer tools', 'logistics', 'health records', 'security', 'education software', 'energy storage'];
const FIRST_NAMES = [
  'Alice', 'Bob', 'Carol', 'Dan', 'Erin', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy',
  'Kevin', 'Laura', 'Mallory', 'Niaj', 'Olivia', 'Peggy', 'Quentin', 'Rupert', 'Sybil', 'Trent',
  'Uma', 'Victor', 'Wendy', 'Xavier', 'Yolanda', 'Zane', 'Amara', 'Boris', 'Celia', 'Dmitri',
  'Elena', 'Farid', 'Gita', 'Hugo', 'Ines', 'Jorge', 'Keiko', 'Lars', 'Mina', 'Nolan',
  'Oksana', 'Pablo', 'Qiana', 'Rafael', 'Selma', 'Tariq', 'Ulla', 'Vikram', 'Willa', 'Xiomara',
  'Yusuf', 'Zelda', 'Anika', 'Bram', 'Chiara', 'Darius', 'Esme', 'Felix', 'Greta', 'Hamid',
];

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function buildWorld(): { pages: RelationPage[]; questions: RelationQuestion[] } {
  const pages: RelationPage[] = [];
  const questions: RelationQuestion[] = [];
  COMPANIES.forEach((co, i) => {
    const sector = SECTORS[i]!;
    const person = (k: number) => {
      const name = `${FIRST_NAMES[i * 6 + k]!} Example`;
      return { name, slug: `people/${slugOf(name)}-${i * 6 + k}` };
    };
    const [founder, engineer, investor, adviser, customer, writer] = [0, 1, 2, 3, 4, 5].map(person) as [ReturnType<typeof person>, ReturnType<typeof person>, ReturnType<typeof person>, ReturnType<typeof person>, ReturnType<typeof person>, ReturnType<typeof person>];
    const year = 2019 + (i % 4);
    const coLink = `[${co}](companies/${slugOf(co)})`;
    const link = (p: { name: string; slug: string }) => `[${p.name}](${p.slug})`;
    pages.push({
      slug: `companies/${slugOf(co)}`, type: 'company', title: co,
      compiled_truth: `${co} is a ${sector} company started in ${year} by ${link(founder)}. The team is about ${30 + i * 4} people, mostly engineers, and its investors include ${link(investor)}. ${link(adviser)} sits on its advisory board.`,
      timeline: `- ${year}-03-0${1 + (i % 9)}: Company formed\n- ${year + 1}-04-12: Seed round closes\n- ${year + 3}-02-14: Series A announced`,
    });
    pages.push({
      slug: `meetings/${slugOf(co)}-board-q${1 + (i % 4)}-2025`, type: 'meeting', title: `${co} Board Meeting Q${1 + (i % 4)} 2025`,
      compiled_truth: `Minutes of the board meeting: runway, the hiring plan, and which people the team wants to add to its staff next quarter.`,
      timeline: `- 2025-0${1 + (i % 9)}-15: Meeting held`,
    });
    pages.push({
      slug: founder.slug, type: 'person', title: founder.name,
      compiled_truth: `${founder.name} is the founder and chief executive of ${coLink}. Earlier ${founder.name.split(' ')[0]} spent four years on a platform group at a large payments firm and writes a widely read engineering blog.`,
      timeline: `- ${year - 1}-09-01: Left the platform group to start ${coLink}\n- ${year}-11-28: Shipped the first ${coLink} release to three design partners\n- ${year + 3}-02-14: ${coLink} announces its Series A`,
    });
    pages.push({
      slug: engineer.slug, type: 'person', title: engineer.name,
      compiled_truth: `${engineer.name} is a senior engineer who works on the ingestion pipeline at ${coLink}. Colleagues describe ${engineer.name.split(' ')[0]} as the person who unblocks everyone else.`,
      timeline: `- ${year + 1}-01-10: Joins ${coLink} as a senior engineer\n- ${year + 2}-02-22: Promoted to tech lead at ${coLink}\n- ${year + 3}-11-01: Leads the internal audit ahead of recertification`,
    });
    pages.push({
      slug: investor.slug, type: 'person', title: investor.name,
      compiled_truth: `${investor.name} is an angel who invested in ${coLink} at the seed stage and backs early ${sector} companies. Founders say the check comes with unusually direct feedback.`,
      timeline: `- ${year + 1}-04-12: Wires a seed check to ${coLink}\n- ${year + 3}-02-14: Takes a pro rata share of the ${coLink} Series A`,
    });
    pages.push({
      slug: adviser.slug, type: 'person', title: adviser.name,
      compiled_truth: `${adviser.name} advises ${coLink} on architecture reviews and is a researcher who has published on ${sector}.`,
      timeline: `- ${year + 1}-06-15: Formalizes an advisory role with ${coLink}\n- ${year + 2}-03-09: Gives a talk on implementation patterns`,
    });
    pages.push({
      slug: customer.slug, type: 'person', title: customer.name,
      compiled_truth: `${customer.name} runs operations at a regional freight firm and is known for careful vendor reviews.`,
      timeline: `- ${year + 2}-05-02: Signed a pilot with ${coLink}\n- ${year + 3}-01-20: Renewed the freight firm's main carrier contract`,
    });
    pages.push({
      slug: writer.slug, type: 'person', title: writer.name,
      compiled_truth: `${writer.name} is a reporter covering ${sector} and early-stage companies.`,
      timeline: `- ${year + 2}-08-19: Published a profile of ${coLink}\n- ${year + 3}-06-03: Moderated a conference panel`,
    });

    const ask = (relation: RelationQuestion['relation'], relevant: string[], template: string, reworded: string[]) => {
      questions.push({ id: `${relation}-${slugOf(co)}-t`, relation, wording: 'template', text: template, relevant });
      reworded.forEach((text, n) => questions.push({ id: `${relation}-${slugOf(co)}-r${n + 1}`, relation, wording: 'reworded', text, relevant }));
    };
    // Half of the rewordings share their words with the company page alone ("team", "investors",
    // "advisory board"), so the all-words match finds that one page and nothing asks for more.
    ask('works_at', [founder.slug, engineer.slug], `Who works at ${co}?`, [
      `Which people are on the ${co} team?`,
      `Who are the engineers at ${co}?`,
      `Who is on the payroll at ${co}?`,
      `Who is employed by ${co}?`,
    ]);
    ask('invested_in', [investor.slug], `Who invested in ${co}?`, [
      `Who are the investors in ${co}?`,
      `Who put money into ${co}?`,
      `Who holds a stake in ${co}?`,
    ]);
    ask('advises', [adviser.slug], `Who advises ${co}?`, [
      `Who is on the advisory board of ${co}?`,
      `Who counsels ${co}?`,
      `Name the advisers of ${co}.`,
    ]);
  });
  const concepts: Array<[string, string, string]> = [
    ['Hiring Playbook', 'How a team hires people and grows its staff without lowering the bar.', '- 2024-01-08: First version written'],
    ['Advisory Boards', 'What an advisory board is for, and how advisers are paid in equity.', '- 2024-02-19: Notes from three founders added'],
    ['Seed Investors', 'How seed investors decide where to put money, and what backers expect in return.', '- 2024-03-04: Updated after the spring rounds'],
    ['Payroll Basics', 'Running payroll for a small team: who is employed, who is a contractor.', '- 2024-04-22: Checklist added'],
    ['Team Offsites', 'Planning an offsite the whole team belongs at.', '- 2024-05-13: Venue list added'],
    ['Cap Tables', 'Who owns a piece of the company after each round.', '- 2024-06-10: Worked example added'],
  ];
  for (const [title, compiled_truth, timeline] of concepts) pages.push({ slug: `concepts/${slugOf(title)}`, type: 'concept', title, compiled_truth, timeline });
  return { pages, questions };
}

const world = buildWorld();
export const RELATION_PAGES: RelationPage[] = world.pages;
export const RELATION_QUESTIONS: RelationQuestion[] = world.questions;
