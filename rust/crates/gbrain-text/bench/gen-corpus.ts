// Deterministic "realistic names" corpus for the mention-pass and sync benches.
// 10,000 pages: 2,000 people, 1,000 companies, 7,000 notes. Notes are ~2-4 KB of prose that
// mention entities by plain name (the mention pass's real input), plus wikilinks, a code block
// now and then, and a timeline. ~3% of people have Hangul names, ~2% Katakana, ~1% Han, and
// ~4% of notes are written in Korean or Japanese around those names.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? '/var/tmp/rx/corpus';
const N = Number(process.argv[3] ?? 10000);
let s = 1 >>> 0;
const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;

const FIRST = 'James Mary Robert Patricia John Jennifer Michael Linda David Elizabeth William Barbara Richard Susan Joseph Jessica Thomas Sarah Charles Karen Christopher Lisa Daniel Nancy Matthew Betty Anthony Margaret Mark Sandra Donald Ashley Steven Kimberly Paul Emily Andrew Donna Joshua Michelle Kenneth Carol Kevin Amanda Brian Dorothy George Melissa Timothy Deborah Ronald Stephanie Edward Rebecca Jason Sharon Jeffrey Laura Ryan Cynthia Jacob Kathleen Gary Amy Nicholas Angela Eric Shirley Jonathan Anna Stephen Brenda Larry Pamela Justin Emma Scott Nicole Brandon Helen Benjamin Samantha Samuel Katherine Gregory Christine Alexander Debra Frank Rachel Patrick Carolyn Raymond Janet Jack Catherine Dennis Maria Jerry Heather Tyler Diane Aaron Ruth Jose Julie Adam Olivia Nathan Joyce Henry Virginia Douglas Victoria Zachary Kelly Peter Lauren Kyle Christina Noah Joan Ethan Evelyn Jeremy Judith Walter Megan Christian Andrea Keith Cheryl Roger Hannah Terry Jacqueline Austin Martha Sean Gloria Gerald Teresa Carl Ann Harold Sara Dylan Madison Arthur Frances Lawrence Kathryn Jordan Janice Jesse Jean Bryan Abigail Billy Alice Bruce Julia Gabriel Judy Joe Sophia Logan Grace Alan Denise Juan Amber Albert Doris Willie Marilyn Elijah Danielle Wayne Beverly Randy Isabella Vincent Theresa Mason Diana Roy Natalie Ralph Brittany Bobby Charlotte Russell Marie Bradley Kayla Philip Alexis Eugene Lori Nguyễn Zoë Renée José Søren Björn'.split(' ');
const LAST = 'Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson Thomas Taylor Moore Jackson Martin Lee Perez Thompson White Harris Sanchez Clark Ramirez Lewis Robinson Walker Young Allen King Wright Scott Torres Nguyen Hill Flores Green Adams Nelson Baker Hall Rivera Campbell Mitchell Carter Roberts Gomez Phillips Evans Turner Diaz Parker Cruz Edwards Collins Reyes Stewart Morris Morales Murphy Cook Rogers Gutierrez Ortiz Morgan Cooper Peterson Bailey Reed Kelly Howard Ramos Kim Cox Ward Richardson Watson Brooks Chavez Wood James Bennett Gray Mendoza Ruiz Hughes Price Alvarez Castillo Sanders Patel Myers Long Ross Foster Jimenez Powell Jenkins Perry Russell Sullivan Bell Coleman Butler Henderson Barnes Gonzales Fisher Vasquez Simmons Romero Jordan Patterson Alexander Hamilton Graham Reynolds Griffin Wallace Moreno West Cole Hayes Bryant Herrera Gibson Ellis Tran Medina Aguilar Stevens Murray Ford Castro Marshall Owens Harrison Fernandez McDonald Woods Washington Kennedy Wells Vargas Henry Chen Freeman Webb Tucker Guzman Burns Crawford Olson Simpson Porter Hunter Gordon Mendez Silva Shaw Snyder Mason Dixon Muñoz Hunt Hicks Holmes Palmer Wagner Black Robertson Boyd Rose Stone Salazar Fox Warren Mills Meyer Rice Schmidt Garza Daniels Ferguson Nichols Stephens Soto Weaver Ryan Gardner Payne Grant Dunn Kelley Spencer Hawkins Arnold Pierce Vazquez Hansen Peters Santos Hart Bradley Knight Elliott Cunningham Duncan Armstrong Hudson Carroll Lane Riley Andrews Alvarado Ray Delgado Berry Perkins Hoffman Johnston Matthews Peña Richards Contreras Willis Carpenter Lawrence Sandoval'.split(' ');
const HANGUL_FAMILY = '김 이 박 최 정 강 조 윤 장 임 한 오 서 신 권 황 안 송 류 전'.split(' ');
const HANGUL_GIVEN = '민준 서연 지원 하은 도윤 서준 예준 지호 수아 지우 하준 주원 지민 서윤 채원 현우 은서 시우 유진 민서'.split(' ');
const KATA = 'タナカ スズキ サトウ ヤマモト ナカムラ コバヤシ カトウ ヨシダ ヤマダ ササキ マツモト イノウエ キムラ ハヤシ シミズ'.split(' ');
const HAN = '王伟 李娜 张敏 刘洋 陈静 杨磊 黄勇 赵艳 周杰 吴霞 徐明 孙丽'.split(' ');
const CO_A = 'Acme Blue Northwind Vertex Quantum Silver Bright Lumen Granite Harbor Cobalt Summit Orbit Pioneer Nimbus Atlas Crimson Evergreen Ironwood Polar Redwood Solstice Tidal Union Velvet Willow Zenith Apex Beacon Cascade'.split(' ');
const CO_B = 'Robotics Labs Systems Capital Health Energy Foods Analytics Networks Bio Devices Logistics Media Security Software Materials Ventures Dynamics Partners Works Cloud Motors Studio Pharma Finance Data Air Grid Mobility Retail'.split(' ');
const WORDS = 'the of and to in a is that for it as was with be by on not he this are or his from at which but have an they you were her she there had been one we their all has would when if more will so no out up into do any your what time its only could new them man some these then two first may than other like over our way such after also did most back many where know us people years very think made said much use great make state good well get through just still own see work world long because last under year here day see each those both again around however life few might take while help why come part much little same high another place another every early plan meeting launch customer product team revenue hiring roadmap budget quarter board investor contract pilot partner research design market strategy feedback'.split(' ');
const KO_WORDS = '오늘 회의 에서 프로젝트 일정 을 논의 했다 다음 주 에 발표 할 예정 이다 고객 피드백 정리 투자 계획 검토 팀 지원 하는 지원금 문서'.split(' ');
const JA_WORDS = '今日 は 会議 で プロジェクト の 予定 を 話し合った 来週 発表 する 予定 です 顧客 フィードバック インシデント デンタル 資料 確認'.split(' ');

type Ent = { slug: string; title: string; kind: 'person' | 'company'; script: 'latin' | 'hangul' | 'kata' | 'han' };
const ents: Ent[] = [];
const used = new Set<string>();
const people = Math.round(N * 0.2), companies = Math.round(N * 0.1), notes = N - people - companies;
for (let i = 0; i < people; i++) {
  const r = rand();
  let title: string, script: Ent['script'];
  do {
    if (r < 0.03) { title = pick(HANGUL_FAMILY) + pick(HANGUL_GIVEN); script = 'hangul'; }
    else if (r < 0.05) { title = pick(KATA) + '・' + pick(KATA); script = 'kata'; }
    else if (r < 0.06) { title = pick(HAN) + pick(['', '明', '华', '强']); script = 'han'; }
    else { title = `${pick(FIRST)} ${pick(LAST)}`; script = 'latin'; }
  } while (used.has(title));
  used.add(title);
  ents.push({ slug: `people/p-${i}`, title, kind: 'person', script });
}
for (let i = 0; i < companies; i++) {
  let title: string;
  do { title = `${pick(CO_A)} ${pick(CO_B)}${rand() < 0.2 ? ' Inc' : ''}`; } while (used.has(title));
  used.add(title);
  ents.push({ slug: `companies/c-${i}`, title, kind: 'company', script: 'latin' });
}
const cjkEnts = ents.filter(e => e.script !== 'latin');
const latinEnts = ents.filter(e => e.script === 'latin');

rmSync(out, { recursive: true, force: true });
const write = (slug: string, text: string) => { const p = join(out, `${slug}.md`); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
const prose = (words: number, mentionEvery: number, pool: Ent[]) => {
  const w: string[] = [];
  for (let k = 0; k < words; k++) {
    if (k > 0 && k % mentionEvery === 0) {
      const e = pick(pool); const r = rand();
      w.push(r < 0.1 ? `${e.title}'s` : r < 0.15 ? `@${e.title.split(' ')[0]}` : e.title);
    } else w.push(pick(WORDS));
  }
  let t = w.join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1) + '.';
};
for (const e of ents) {
  const body = e.script === 'latin' ? prose(120 + Math.floor(rand() * 200), 25, latinEnts) : `${e.title} ${pick(KO_WORDS)} ${prose(80, 30, latinEnts)}`;
  write(e.slug, `---\ntitle: ${JSON.stringify(e.title)}\ntype: ${e.kind}\n---\n# ${e.title}\n\n${body}\n\n## Timeline\n\n- **2025-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}** | Met ${pick(latinEnts).title}\n`);
}
for (let i = 0; i < notes; i++) {
  const r = rand();
  const paras: string[] = [];
  const nparas = 3 + Math.floor(rand() * 4);
  for (let p = 0; p < nparas; p++) {
    if (r < 0.02) paras.push(Array.from({ length: 60 }, (_, k) => k % 9 === 4 ? pick(cjkEnts).title + pick(['는', '에게', '씨는', '이', '']) : pick(KO_WORDS)).join(' '));
    else if (r < 0.04) paras.push(Array.from({ length: 60 }, (_, k) => k % 9 === 4 ? pick(cjkEnts).title + pick(['に', 'さん', '']) : pick(JA_WORDS)).join(''));
    else paras.push(prose(70 + Math.floor(rand() * 60), 18 + Math.floor(rand() * 20), latinEnts));
  }
  if (rand() < 0.15) paras.push('```ts\n// ' + pick(latinEnts).title + ' wrote this\nconst x = 1;\n```');
  const links = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => `[[${pick(ents).slug}]]`).join(' ');
  write(`notes/n-${i}`, `---\ntitle: "Note ${i}: ${pick(WORDS)} ${pick(WORDS)}"\ntype: note\n---\n# Note ${i}\n\n${paras.join('\n\n')}\n\nSee ${links}.\n\n## Timeline\n\n- **2026-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}** | Discussed with ${pick(latinEnts).title}\n`);
}
console.log(JSON.stringify({ out, pages: N, people, companies, notes }));
