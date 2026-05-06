#!/usr/bin/env node
/**
 * gdoc-ingest v0.3.0 — Index Google Workspace documents into the brain.
 *
 * Pure functions are exported for unit testing. The CLI entry point is at
 * the bottom of the file and orchestrates: parse URL → fetch metadata →
 * fetch content → propose slug → render markdown → put_page.
 *
 * Drive remains the source of truth; the brain is the index. Each indexed
 * document gets a page in `docs/inbox/<slug>` with frontmatter type:document
 * carrying owner, status, disciplina, tema, url_drive, last_modified_drive,
 * a 3–5 bullet summary, and Iron-Law back-link stubs. Triage promotes pages
 * from `docs/inbox/<slug>` to `docs/<disciplina>/<tema>/<slug>` later.
 *
 * Stable contract — do not regress without a test:
 *   parseDriveUrl(url)            → { kind, fileId } | null
 *   inferDisciplinaTema(name,...) → { disciplina, tema, secondaryTags }
 *   slugifyTitle(title)           → kebab-case ascii slug
 *   renderInboxPage(args)         → markdown string with frontmatter
 *   buildSummaryPrompt(args)      → string (deterministic prompt body)
 *   detectMeetingDoc(name)        → boolean (transcript / Gemini notes)
 *   extractSlideText(slidesJSON)  → { plainText, totalSlides, visibleSlides, hiddenSlides }
 *   extractEntities(text)         → { people: [], projects: [], decisions: [] }
 *
 * Side-effecting helpers (callGAS, callBrainPutPage, summarizeWithLLM) are
 * exported for integration tests but only invoked from main().
 */

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────
// Constants

const WORKSPACE_ROOT = process.env.OPSOS_WORKSPACE
  || '/Users/rafaelreisr/.openclaw/workspace-opsos';
const GWS_SCRIPT = path.join(
  WORKSPACE_ROOT,
  'skills/gas-workspace-bridge/scripts/gws-call.cjs',
);

// Disciplinas + tema keywords. Order matters — first match wins within title,
// then within body. See concepts/title-first-classification.
export const TAXONOMY = [
  // disciplina, tema, regex
  // NOTE: order matters — title-first matching uses the first regex hit.
  // Specific patterns (e.g. "gestão contábil") MUST come before generic ones.
  ['ops',    'gestao',        /gest[aã]o\s+cont[aá]bil|gest[aã]o\s+(de\s+)?opera[cç][oõ]es|capacity\s+planning|fte\s+plan/i],
  ['fiscal', 'reforma-renda', /reforma\s+(da\s+|de\s+)?renda|imposto\s+de\s+renda/i],
  ['fiscal', 'informe-rendimentos', /informe[\s-]+(de\s+)?rendimentos|comprovante\s+(de\s+)?rendimentos/i],
  ['fiscal', 'dctf',          /\bdctf(web)?\b/i],
  ['fiscal', 'ecd',           /\becd\b/i],
  ['fiscal', 'ecf',           /\becf\b/i],
  ['fiscal', 'retificacoes',  /retifica[cç][aã]o|retificar/i],
  ['ops',    'df',            /\bdf\b|demonstra[cç][oõ]es\s*(financeiras|cont[aá]beis)|\bdfc\b/i],
  ['ops',    'inativos',      /inativ[ao]s?|migra[cç][aã]o/i],
  ['ops',    'fechamento',    /fechamento\s*cont[aá]bil|fecho\s*cont[aá]bil/i],
  ['ops',    'reaberturas',   /reabertura/i],
  ['ops',    'metas',         /\bmetas?\s*(qd|q[1-4]|trimestre|semestre)?\b|okrs?/i],
  ['ops',    'backlog',       /\bbacklog\b|raio[\s-]*x/i],
  ['ops',    'sac',           /\bvs\s*sac\b|\bsac\s*n[12]\b|atendimento\s*ao\s*cliente|servi[cç]o\s*de\s*atendimento/i],
  ['ops',    'csa',           /\bcsa\b|central\s*de\s*servi[cç]os/i],
  ['ops',    'semanal',       /semanal\s*cont[aá]bil|reuni[aã]o\s*semanal|weekly\s*report/i],
  ['rh',     'contratacoes',  /contrata[cç][aã]o|hiring|vaga|recruta/i],
  ['rh',     'pdi',           /\bpdi\b|plano\s*de\s*desenvolvimento/i],
  ['rh',     'escola-lideranca', /escola\s*(de\s*)?lideran[cç]a/i],
  ['rh',     'performance',   /performance|desempenho|avalia[cç][aã]o/i],
  ['tech',   'bia',           /\bbia\b/i],
  ['tech',   'jira',          /\bjira\b|\bgira\b/i],
  ['tech',   'looker',        /looker/i],
  ['tech',   'automacao',     /automa[cç][aã]o|automation/i],
  ['comercial', 'nps',        /\bnps\b/i],
  ['comercial', 'churn',      /churn|rotatividade/i],
  ['comercial', 'retencao',   /reten[cç][aã]o/i],
  ['comercial', 'ativacao',   /ativa[cç][aã]o/i],
  ['juridico',  'cancelamentos', /cancelamento/i],
  ['juridico',  'regulatorio',   /regulat[oó]rio|complianc/i],
  ['juridico',  'lgpd',          /\blgpd\b/i],
  ['exec',   'apresentacoes',  /apresenta[cç][aã]o|deck|slides?\b/i],
  ['exec',   'okrs',           /\bokrs?\b/i],
  ['exec',   'board',          /\bboard\b|comit[eê]\s*diretor/i],
  ['exec',   'qbr',            /\bqbr\b|quarterly\s*business\s*review/i],
];

export const MIME_KIND = {
  'application/vnd.google-apps.document':     'doc',
  'application/vnd.google-apps.spreadsheet':  'sheet',
  'application/vnd.google-apps.presentation': 'slide',
  'application/pdf':                          'pdf',
};

// Patterns that mean "this Drive doc is actually a meeting transcript or
// auto-generated meeting notes". Override-by-filename — see
// concepts/title-first-classification.
export const MEETING_DOC_PATTERNS = [
  /^Google\s+Meet\s+transcript-/i,
  /Anota[cç][oõ]es\s+do\s+Gemini/i,
  /transcript-[a-z]{3}-[a-z]{4}-[a-z]{3}/i,
];

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers

/**
 * Parse a Google Drive / Docs / Sheets / Slides URL. Returns the file kind
 * and id, or null if the URL doesn't match any known pattern.
 */
export function parseDriveUrl(url) {
  if (typeof url !== 'string') return null;
  const m =
    url.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]{20,})/) ||
    url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/);
  if (!m) return null;
  if (m.length === 3) {
    const map = { document: 'doc', spreadsheets: 'sheet', presentation: 'slide' };
    return { kind: map[m[1]] || m[1], fileId: m[2] };
  }
  return { kind: 'drive-file', fileId: m[1] };
}

/**
 * kebab-case ASCII slug, max 60 chars. Strips diacritics, punctuation,
 * collapses whitespace. Returns 'sem-titulo' for empty input — never
 * returns empty string (would break put_page).
 */
export function slugifyTitle(title) {
  if (!title || typeof title !== 'string') return 'sem-titulo';
  const out = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return out || 'sem-titulo';
}

/**
 * Detect if a Drive doc is a meeting transcript / auto-notes. When true,
 * the orchestrator can route to meeting-ingestion in addition to (or
 * instead of) gdoc-ingest.
 */
export function detectMeetingDoc(name) {
  const s = String(name || '');
  return MEETING_DOC_PATTERNS.some((re) => re.test(s));
}

/**
 * Decide disciplina+tema by matching first the title and only then the body.
 * Title wins; body is a fallback for ambiguous titles. Returns BOTH the
 * primary (disciplina, tema) and secondaryTags (other taxonomy matches in
 * the body for cross-search).
 *
 * See concepts/title-first-classification for the principle.
 */
export function inferDisciplinaTema(title, body = '') {
  const titleHay = String(title || '').slice(0, 1000);
  const bodyHay = String(body || '').slice(0, 8000);

  let primary = null;
  for (const [disc, tema, re] of TAXONOMY) {
    if (re.test(titleHay)) { primary = { disciplina: disc, tema }; break; }
  }
  if (!primary) {
    for (const [disc, tema, re] of TAXONOMY) {
      if (re.test(bodyHay)) { primary = { disciplina: disc, tema }; break; }
    }
  }
  if (!primary) primary = { disciplina: 'ops', tema: 'projetos-especiais' };

  // Secondary tags — every other taxonomy match in body that's distinct from primary.
  const secondaryTags = [];
  const seen = new Set([`${primary.disciplina}/${primary.tema}`]);
  for (const [disc, tema, re] of TAXONOMY) {
    const key = `${disc}/${tema}`;
    if (seen.has(key)) continue;
    if (re.test(bodyHay)) {
      secondaryTags.push(tema);
      seen.add(key);
    }
    if (secondaryTags.length >= 5) break;
  }

  return { ...primary, secondaryTags };
}

/**
 * Build a deterministic LLM prompt body for the summary step. Pure so the
 * eval suite can snapshot it.
 */
export function buildSummaryPrompt({ title, content, kind, owner }) {
  const truncated = (content || '').slice(0, 50000);
  return [
    'Você é o OpsOS, assistente do Rafael Reis (Head de Operações na Contabilizei).',
    'Resuma o documento abaixo em PT-BR seguindo este formato EXATO:',
    '',
    'BULLETS (3 a 5 bullets curtos, 1 frase cada, foco no que importa para Rafael):',
    '- ...',
    '',
    'NARRATIVA (1 parágrafo, 2-4 frases, contexto e relevância):',
    '...',
    '',
    'ENTIDADES (pessoas e projetos mencionados, separados por vírgula; vazio se nenhum):',
    'Pessoas: ...',
    'Projetos: ...',
    'Decisões: ...',
    '',
    `--- METADADOS ---`,
    `Título: ${title}`,
    `Tipo: ${kind}`,
    `Owner: ${owner || 'desconhecido'}`,
    '',
    '--- CONTEÚDO (truncado em 50k chars) ---',
    truncated,
  ].join('\n');
}

/**
 * Walk the slides.getAllContent JSON tree and pull plain text. Skips slides
 * with isSkipped=true (the API already filters by default; we double-check).
 */
export function extractSlideText(slidesJSON) {
  if (!slidesJSON || !Array.isArray(slidesJSON.slides)) {
    return { plainText: '', totalSlides: 0, visibleSlides: 0, hiddenSlides: 0 };
  }
  const totalSlides = slidesJSON.totalSlides ?? slidesJSON.slides.length;
  const lines = [];
  let hiddenSlides = 0;
  let visibleSlides = 0;

  function walk(elements, depth = 0) {
    if (!Array.isArray(elements)) return;
    for (const el of elements) {
      if (!el) continue;
      if (typeof el.text === 'string' && el.text.trim()) {
        lines.push(el.text.trim());
      }
      if (Array.isArray(el.children)) walk(el.children, depth + 1);
    }
  }

  for (const slide of slidesJSON.slides) {
    if (slide.isSkipped) { hiddenSlides += 1; continue; }
    visibleSlides += 1;
    lines.push(`\n--- Slide ${slide.index + 1} ---`);
    walk(slide.elements);
    if (slide.notesText && slide.notesText.trim()) {
      lines.push(`[Notas: ${slide.notesText.trim()}]`);
    }
  }
  // The GAS slides.getAllContent already filters hidden by default, so the
  // returned `slides` array typically contains only visible slides. Reconcile
  // the count: anything in totalSlides but NOT in the array is also hidden.
  const filteredUpstream = Math.max(0, totalSlides - slidesJSON.slides.length);
  hiddenSlides += filteredUpstream;
  return {
    plainText: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    totalSlides,
    visibleSlides,
    hiddenSlides,
  };
}

/**
 * Extract people/project/decision entities from text using a heuristic +
 * brain lookup. Returns { people, projects, decisions } as arrays of slugs
 * (when matched in brain) or display names (when not).
 *
 * Heuristic: capitalized name tokens, common project words, "decidir/decisão"
 * markers. The skill stops short of LLM-based NER in MVP; the orchestrator
 * (agent) can refine during triage.
 */
// Stop-words (PT-BR) — capitalized in headers/labels but NOT people.
const PEOPLE_STOPWORDS = new Set([
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto',
  'setembro', 'outubro', 'novembro', 'dezembro',
  'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo',
  'resumo', 'detalhes', 'próximas', 'etapas', 'conteúdo', 'anexo', 'anexos',
  'plano', 'futuro', 'status', 'atual', 'recorte', 'sobre', 'origem',
  'predominante', 'abertura', 'empresas', 'gestão', 'migração', 'ação',
  'judicial', 'alta', 'baixa', 'complexidade', 'risco', 'mapeado',
  'demanda', 'muito', 'pouco', 'otimista', 'pessimista', 'realista',
  'key', 'takeaways', 'vida', 'previsível', 'falsa', 'verdadeira',
  'demonstrações', 'financeiras', 'contábeis', 'fiscal', 'tributário',
  'proposta', 'plano', 'cenário', 'cenários', 'objetivo', 'objetivos',
  'meta', 'metas', 'iniciativa', 'iniciativas', 'projeto', 'projetos',
  'sim', 'não', 'talvez', 'página', 'capítulo', 'introdução',
  'conclusão', 'apresentação', 'reunião', 'minutos', 'horas',
  'ano', 'anos', 'mês', 'meses', 'semana', 'semanas', 'dia', 'dias',
  'novo', 'nova', 'novos', 'novas', 'velho', 'velha',
  'primeiro', 'segundo', 'terceiro', 'quarto', 'quinto',
  'tier', 'level', 'fase', 'sprint', 'qd', 'q1', 'q2', 'q3', 'q4',
  'premium', 'plus', 'basic', 'pro',
  'as', 'os', 'um', 'uma', 'uns', 'umas',
  'da', 'de', 'do', 'das', 'dos',
  'em', 'no', 'na', 'nos', 'nas',
  'por', 'para', 'pra',
  'rh', 'ti', 'tech', 'core', 'ops',
  'crm', 'erp', 'api', 'app',
  'dctf', 'ecd', 'ecf', 'df', 'lgpd', 'nps',
  // Spreadsheet headers / labels that match "Capitalized Word" patterns
  'backlog', 'compensas', 'sem', 'com', 'macro', 'micro',
  'processo', 'processos', 'periodo', 'período', 'entrega', 'entregas',
  'produtividade', 'volume', 'volumes', 'mensal', 'mensais',
  'anual', 'anuais', 'diária', 'diária', 'automático', 'automática',
  'fechamento', 'fechamentos', 'aberto', 'abertos', 'fechado', 'fechados',
  'alocado', 'alocada', 'alocados', 'alocadas', 'alocacao', 'alocação',
  'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
  'jul', 'ago', 'set', 'out', 'nov', 'dez',
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
  'rotina', 'rotinas', 'reforma', 'reformas',
  'dinâmica', 'dinamica', 'base', 'bases',
  'area', 'areas', 'área', 'áreas', 'rafa', 'expert', 'padrão', 'padrao',
  'fte', 'hc', 'hcs', 'recurso', 'recursos', 'gestão', 'gestao',
  'contábil', 'contabil', 'contábeis', 'contabeis',
  'risco', 'riscos', 'compilado', 'resumo',
  'novos', 'novas', 'slides', 'novo', 'nova',
  'criados', 'finalizados', 'demanda', 'demandas',
  'capacity', 'throughput', 'gap',
]);

/**
 * True iff the candidate looks like a person name: 2-3 capitalized words,
 * each at least 3 chars, none of which are stop-words.
 */
function isProbablyPersonName(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  for (const p of parts) {
    if (p.length < 3) return false;
    if (PEOPLE_STOPWORDS.has(p.toLowerCase())) return false;
    // Reject pieces with non-letter chars (\u000b, \t, \n etc.)
    if (/[^a-zA-ZÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç]/.test(p)) return false;
  }
  return true;
}

export function extractEntities(text, opts = {}) {
  // For spreadsheets, the regex-based approach generates too many false
  // positives because column headers and labels look like "Capitalized
  // Word Pairs" (e.g. "Backlog Abr", "Macro Processo"). Heuristic entity
  // extraction is unsafe for sheets — skip and let the orchestrating
  // agent extract entities semantically from the rendered content.
  if (opts.kind === 'sheet') {
    return { people: [], projects: [], decisions: [] };
  }
  const t = String(text || '').replace(/[\u000b\t\r]+/g, ' ');
  // People: 2-3 word capitalized sequences (Rafael Reis, Marcos Junior, Simone Vieira Vera)
  const peopleMatches = new Set();
  const peopleRe = /\b([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+){1,2})\b/g;
  let m;
  while ((m = peopleRe.exec(t)) !== null) {
    const name = m[1];
    if (!isProbablyPersonName(name)) continue;
    peopleMatches.add(name);
  }
  // Projects: anything mentioned as "Projeto X", "iniciativa Y", or known project keywords
  const projectsMatches = new Set();
  const projRe = /(?:projeto|iniciativa|programa)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wáéíóúâêôãõç -]{2,40})/gi;
  while ((m = projRe.exec(t)) !== null) {
    projectsMatches.add(m[1].trim());
  }
  // Decisions: lines containing "decisão", "decidiu", "decidido", "ficou definido"
  const decisionLines = [];
  const decRe = /([^\n.]*(decis[aã]o|decidi(?:u|do)|ficou\s+definido|formaliz[ao]da?)[^\n.]*)/gi;
  while ((m = decRe.exec(t)) !== null) {
    const line = m[1].trim();
    if (line.length > 30 && line.length < 280) decisionLines.push(line);
  }

  return {
    people: Array.from(peopleMatches).slice(0, 20),
    projects: Array.from(projectsMatches).slice(0, 10),
    decisions: decisionLines.slice(0, 10),
  };
}

/**
 * Render the brain page for `docs/inbox/<slug>`. Pure — receives all data,
 * returns a markdown string with YAML frontmatter.
 */
export function renderInboxPage(args) {
  const {
    title,
    fileId,
    kind,
    mimetype,
    owner,
    urlDrive,
    lastModified,
    indexedAt,
    indexedVia,
    proposedSlug,
    disciplina,
    tema,
    secondaryTags = [],
    summary,
    rawCharCount,
    slideStats, // optional { totalSlides, visibleSlides, hiddenSlides } OR for sheets { totalTabs, readTabs, priorityTab, tabsRead }
    isMeetingDoc = false,
    entities, // optional { people, projects, decisions }
  } = args;

  const fm = [
    '---',
    'type: document',
    `title: ${JSON.stringify(title)}`,
    `slug_proposto: ${proposedSlug}`,
    'status: draft-index',
    `disciplina: ${disciplina}`,
    `tema: ${tema}`,
    secondaryTags.length ? `secondary_tags: [${secondaryTags.join(', ')}]` : 'secondary_tags: []',
    `kind: ${kind}`,
    `owner: ${owner || 'unknown'}`,
    `url_drive: ${urlDrive}`,
    `file_id: ${fileId}`,
    `mimetype: ${mimetype}`,
    `last_modified_drive: ${lastModified}`,
    `indexed_at: ${indexedAt}`,
    `indexed_via: ${indexedVia}`,
    `raw_char_count: ${rawCharCount ?? 0}`,
    isMeetingDoc ? 'is_meeting_doc: true' : null,
    (slideStats && kind === 'sheet')
      ? `sheet_stats: { totalTabs: ${slideStats.totalTabs}, readTabs: ${slideStats.readTabs}, priorityTab: ${JSON.stringify(slideStats.priorityTab)}, tabsRead: ${JSON.stringify(slideStats.tabsRead)} }`
      : (slideStats ? `slide_stats: { total: ${slideStats.totalSlides}, visible: ${slideStats.visibleSlides}, hidden: ${slideStats.hiddenSlides} }` : null),
    '---',
  ].filter(Boolean).join('\n');

  const summaryBlock = (summary && summary.trim().length > 0)
    ? summary.trim()
    : '_Resumo não gerado (LLM falhou ou doc vazio). Conteúdo bruto preservado em raw_data._';

  const entitiesBlock = entities
    ? [
        '## Entidades detectadas (Iron Law back-link candidates)',
        '',
        entities.people.length ? `**Pessoas:** ${entities.people.map((p) => `[[people/${slugifyTitle(p)}]]`).join(', ')}` : '_Pessoas: nenhuma detectada heuristicamente_',
        entities.projects.length ? `**Projetos:** ${entities.projects.join(', ')}` : '',
        entities.decisions.length ? `**Decisões candidatas:**\n${entities.decisions.map((d) => `- ${d}`).join('\n')}` : '',
        '',
      ].filter(Boolean).join('\n')
    : '';

  const slideBlock = (slideStats && kind === 'sheet')
    ? `\n**Estatísticas Sheet:** ${slideStats.totalTabs} abas totais, ${slideStats.readTabs} lidas (prioridade: "${slideStats.priorityTab || '—'}"). Abas analisadas: ${(slideStats.tabsRead || []).join(', ')}.\n`
    : (slideStats
      ? `\n**Estatísticas Slides:** ${slideStats.totalSlides} slides totais, ${slideStats.visibleSlides} visíveis, ${slideStats.hiddenSlides} ocultos (ignorados pela skill conforme título-first / metadata-curada).\n`
      : '');

  const meetingBlock = isMeetingDoc
    ? '\n> ⚠️ **Detectado como meeting transcript / Gemini notes.** Considere também rotear para `meeting-ingestion` para entity propagation completa.\n'
    : '';

  return [
    fm,
    '',
    `# ${title}`,
    '',
    `**[Source: GDoc ${fileId}, fetched ${indexedAt}]**`,
    `**Drive:** ${urlDrive}`,
    `**Owner:** ${owner || 'unknown'} | **Kind:** ${kind} | **Status:** draft-index`,
    `**Proposta de slug final:** \`docs/${disciplina}/${tema}/${proposedSlug}\``,
    secondaryTags.length ? `**Tags secundárias:** ${secondaryTags.map((t) => '`' + t + '`').join(', ')}` : '',
    slideBlock,
    meetingBlock,
    '## Resumo',
    '',
    summaryBlock,
    '',
    entitiesBlock,
    '## Triagem',
    '',
    `- [ ] Confirmar slug \`docs/${disciplina}/${tema}/${proposedSlug}\` ou propor outro`,
    '- [ ] Status final: oficial | draft | arquivado | obsoleto',
    '- [ ] Iron Law: validar/criar back-links nas entidades detectadas acima',
    isMeetingDoc ? '- [ ] Rotear também para `meeting-ingestion` (transcript detectado)' : '',
    '',
    '## Histórico',
    '',
    `- ${indexedAt.slice(0, 10)} | Indexado via ${indexedVia} (gdoc-ingest skill v0.2)`,
    `- ${(lastModified || '').slice(0, 10)} | Última modificação detectada no Drive`,
    '',
  ].filter((l) => l !== null && l !== '').join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Side-effecting helpers (still exported for integration tests)

/**
 * Call the GAS Workspace Bridge. Returns parsed JSON. Throws on non-zero exit.
 */
export function callGAS(action, params = {}) {
  if (!existsSync(GWS_SCRIPT)) {
    throw new Error(`GAS bridge not found at ${GWS_SCRIPT}`);
  }
  // 60s hard cap per GAS call. Sheets readRange with 50x26 grid takes ~7-10s.
  // Slides getSlideImagesAsBase64 with 9 images takes ~30-40s. Anything past
  // 60s is almost always an Apps Script execution stall — fail loud.
  const out = execFileSync(
    'node',
    [GWS_SCRIPT, action, JSON.stringify(params)],
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 60_000 },
  );
  return JSON.parse(out);
}

/**
 * Write a brain page via the gbrain CLI. Returns the parsed JSON envelope.
 */
export function callBrainPutPage(slug, content) {
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL
      || 'postgresql://rafaelreisr@localhost:5432/gbrain',
  };
  const out = execFileSync(
    '/Users/rafaelreisr/.bun/bin/bun',
    ['run', '/Users/rafaelreisr/gbrain/src/cli.ts', 'put', slug, '--stdin'],
    { encoding: 'utf8', input: content, env, maxBuffer: 10 * 1024 * 1024 },
  );
  return out;
}

/**
 * Resolve a partial slug to existing brain pages. Returns null if no match.
 * Used by Iron Law to only back-link to entities that ALREADY have a page.
 */
export function resolveBrainSlug(partial) {
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL
      || 'postgresql://rafaelreisr@localhost:5432/gbrain',
  };
  try {
    const out = execFileSync(
      'psql', [env.DATABASE_URL, '-tAc',
        `SELECT slug FROM pages WHERE slug ILIKE '${partial.replace(/'/g, "''")}%' AND deleted_at IS NULL ORDER BY length(slug) ASC LIMIT 1;`],
      { encoding: 'utf8', timeout: 5_000 },
    );
    const match = out.trim();
    return match || null;
  } catch {
    return null;
  }
}

/**
 * Add a back-link from `from` to `to` with a context note. Idempotent.
 */
export function callBrainAddLink(from, to, linkType = 'mentions', context = '') {
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL
      || 'postgresql://rafaelreisr@localhost:5432/gbrain',
  };
  try {
    execFileSync(
      '/Users/rafaelreisr/.bun/bin/bun',
      ['run', '/Users/rafaelreisr/gbrain/src/cli.ts', 'link', from, to, '--type', linkType, '--context', context.slice(0, 200)],
      { encoding: 'utf8', env, maxBuffer: 1 * 1024 * 1024, timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Iron Law: for each entity detected in a document, IF the entity has an
 * existing brain page, create a back-link FROM that entity TO the doc page.
 * Returns counts of links attempted/created.
 *
 * Notability gate: we ONLY back-link to entities that already exist as
 * pages. We don't auto-create new people/projects pages here — that's
 * the orchestrating agent's call during triage.
 */
export function applyIronLaw(docSlug, entities) {
  const stats = { peopleLinked: 0, projectsLinked: 0, peopleSkipped: 0, projectsSkipped: 0 };
  if (!entities || !docSlug) return stats;

  for (const personName of (entities.people || [])) {
    const personSlug = `people/${slugifyTitle(personName)}`;
    const existing = resolveBrainSlug(personSlug);
    if (existing) {
      const ok = callBrainAddLink(existing, docSlug, 'mentions', `Mentioned in document`);
      if (ok) stats.peopleLinked += 1;
    } else {
      stats.peopleSkipped += 1;
    }
  }

  for (const projName of (entities.projects || [])) {
    const projSlug = `projects/${slugifyTitle(projName)}`;
    const existing = resolveBrainSlug(projSlug);
    if (existing) {
      const ok = callBrainAddLink(existing, docSlug, 'mentions', `Mentioned in document`);
      if (ok) stats.projectsLinked += 1;
    } else {
      stats.projectsSkipped += 1;
    }
  }

  return stats;
}

/**
 * Detect potential predecessor by title similarity. Looks for pages with
 * similar slug stem (e.g. "relatorio-mar-2026" suggests "relatorio-feb-2026"
 * exists). Returns { found: true, predecessorSlug } or { found: false }.
 *
 * Strategy: extract base stem (strip date/version suffixes) and search.
 */
export function detectSuccessor(title) {
  if (!title) return { found: false };
  const slug = slugifyTitle(title);
  // Strip trailing date-like or version-like tokens
  const stem = slug
    .replace(/-(v\d+|2\d{3}-\d{2}|2\d{3})$/i, '')
    .replace(/-(jan|feb|fev|mar|abr|apr|mai|may|jun|jul|ago|aug|set|sep|out|oct|nov|dez|dec)(-\d{2,4})?$/i, '')
    .replace(/-q[1-4]$/i, '')
    .replace(/-\d{4}-?\d{0,2}-?\d{0,2}$/, '');
  if (stem === slug || stem.length < 5) return { found: false };
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL
      || 'postgresql://rafaelreisr@localhost:5432/gbrain',
  };
  try {
    const out = execFileSync(
      'psql', [env.DATABASE_URL, '-tAc',
        `SELECT slug FROM pages WHERE slug LIKE 'docs/%${stem.replace(/'/g, "''")}%' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;`],
      { encoding: 'utf8', timeout: 5_000 },
    );
    const match = out.trim();
    if (match) return { found: true, predecessorSlug: match, stem };
    return { found: false, stem };
  } catch {
    return { found: false };
  }
}

/**
 * Generate the bullet summary for a fetched document.
 *
 * Behavior:
 *  - If env OPSOS_GDOC_LLM=heuristic, use summarizeFallback (deterministic).
 *  - Otherwise try a Claude/Sonnet call via the OpenCode CLI runtime
 *    (`oc claude ...`) when available; fall back to heuristic if not.
 *
 * The orchestrating agent typically overrides this anyway (it has direct
 * LLM access). The script-level LLM is for batch / cron invocations where
 * no agent is in the loop.
 */
export async function summarizeWithLLM({ title, content, kind, owner }) {
  if (process.env.OPSOS_GDOC_LLM === 'heuristic') {
    return summarizeFallback({ title, content });
  }
  // Try a minion-based summary if OPSOS_GDOC_LLM=minion, else heuristic.
  // We avoid hard-wiring an LLM HTTP call here to keep the script offline-safe
  // and credential-free. The agent layer is expected to do real LLM calls.
  return summarizeFallback({ title, content });
}

/**
 * Fetch slide images as base64 PNGs using the GAS bridge. Returns an array
 * with `{ index, base64, width, height, mimeType }` per requested slide.
 *
 * The agent runtime calls this to materialize PNGs for Vision
 * interpretation. The GAS endpoint authenticates the contentUrl fetch
 * internally so we get bytes, not redirects.
 */
export function fetchSlideImagesAsBase64({ presentationId, slideIndices, size = 'MEDIUM', maxImages = 12, includeHidden = true }) {
  const params = { presentationId, size, maxImages, includeHidden };
  if (Array.isArray(slideIndices) && slideIndices.length) params.slideIndices = slideIndices;
  const r = callGAS('slides.getSlideImagesAsBase64', params);
  return (r.slides || []).filter((s) => s.base64);
}

/**
 * Heuristic summary used when no LLM is available or as the deterministic
 * fallback. Returns a non-empty 3-bullet placeholder.
 */
export function summarizeFallback({ title, content }) {
  const text = (content || '').replace(/\s+/g, ' ').trim();
  if (!text) return '_Documento vazio ou sem conteúdo extraível._';
  const firstChunk = text.slice(0, 600);
  const bullets = [
    `- Título: ${title}`,
    `- Tamanho: ~${text.length} caracteres extraídos`,
    `- Trecho inicial: ${firstChunk.slice(0, 240)}${firstChunk.length > 240 ? '…' : ''}`,
  ];
  return [
    'BULLETS:',
    bullets.join('\n'),
    '',
    'NARRATIVA:',
    `Resumo automático heurístico (LLM não acionado). Documento "${title}" com ~${text.length} chars.`,
    'A versão final do resumo será gerada pelo agente orquestrador (sonnet-4-6) na sessão de triagem.',
    '',
    'ENTIDADES:',
    'Pessoas: (extração heurística abaixo, na seção Entidades detectadas)',
    'Projetos: (idem)',
    'Decisões: (idem)',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestration

/**
 * Main pipeline. Receives a url and indexedVia, returns the page payload
 * (without writing) or writes via callBrainPutPage when commit=true.
 */
export async function ingest({ url, indexedVia = 'manual-cli', commit = false }) {
  const parsed = parseDriveUrl(url);
  if (!parsed) {
    throw new Error(`URL inválida ou não-Drive: ${url}`);
  }
  const { fileId, kind } = parsed;

  // 1. Content + metadata
  let content = '';
  let charCount = 0;
  let title = fileId;
  let mimetype = '';
  let owner = '';
  let lastModified = new Date().toISOString();
  let urlDrive = url;
  let slideStats = null;
  let payload_thumbnails = [];

  try {
    if (kind === 'doc') {
      const r = callGAS('docs.getContent', { documentId: fileId });
      content = r.content || '';
      charCount = r.charCount ?? content.length;
      title = r.name || title;
      mimetype = 'application/vnd.google-apps.document';
      urlDrive = r.url || urlDrive;
    } else if (kind === 'sheet') {
      // Sheets ingestion strategy (v0.5 — atomic batch read):
      // 1. ONE GAS call (sheets.batchRead) opens the spreadsheet once, reads
      //    metadata + N tabs, returns everything together. This avoids the
      //    Apps Script execution lock contention we had with sequential
      //    sheets.readRange calls (each one hit SpreadsheetApp.openById and
      //    triggered formula recalculation — cumulative slowdown after the
      //    first call until the spreadsheet was effectively locked).
      // 2. Priority tab detected from URL ?gid=N — user-opened tab read first.
      // 3. Skip cloned/conflict/numeric "PáginaN" tabs.
      // 4. Render as plain-text rows for summarization & entity extraction.

      // Detect priority tab from URL (?gid=N or #gid=N) — we filter the read
      // list before calling GAS to avoid wasting time on cloned tabs.
      const gidMatch = String(url || urlDrive || '').match(/[?#&]gid=(\d+)/);
      const priorityGid = gidMatch ? Number(gidMatch[1]) : null;

      // First a lightweight metadata-only call to know which tabs exist.
      // (batchRead with empty `reads` would also work but we keep them
      // separate so we can early-fail if metadata fetch breaks.)
      const debug = process.env.GDOC_DEBUG === '1';
      const t0 = Date.now();
      if (debug) process.stderr.write('[gdoc-ingest] fetching sheet metadata...\n');
      const info = callGAS('sheets.getSheetInfo', { spreadsheetId: fileId });
      if (debug) process.stderr.write(`[gdoc-ingest]   ✓ metadata in ${Date.now() - t0}ms\n`);
      title = info.name || info.title || title;
      mimetype = 'application/vnd.google-apps.spreadsheet';

      const tabs = (info.sheets || []).map((s) => ({
        name: s.name,
        gid: s.sheetId,
        rowCount: s.rowCount,
        colCount: s.columnCount,
        hidden: !!s.isHidden || !!s.hidden,
      }));
      const priorityTab = priorityGid != null
        ? tabs.find((t) => Number(t.gid) === priorityGid)
        : null;

      // Filter tabs: skip clones, conflicts, hidden, numeric "PáginaN" stubs.
      const noiseRe = /(cópia de|copia de|conflict|^página\d+|^página_\d+| página\d+)/i;
      const cleanTabs = tabs.filter((t) => !noiseRe.test(t.name) && !t.hidden);
      const tabsToRead = [];
      if (priorityTab) tabsToRead.push(priorityTab);
      for (const t of cleanTabs) {
        if (tabsToRead.find((x) => x.gid === t.gid)) continue;
        if (tabsToRead.length >= 3) break;
        tabsToRead.push(t);
      }

      // Single batched read — all tabs in one Apps Script execution.
      let tabContents = [];
      if (tabsToRead.length > 0) {
        const tBatch = Date.now();
        if (debug) process.stderr.write(`[gdoc-ingest] batch reading ${tabsToRead.length} tabs...\n`);
        try {
          const batch = callGAS('sheets.batchRead', {
            spreadsheetId: fileId,
            reads: tabsToRead.map((t) => ({ sheetName: t.name, range: 'A1:Z50' })),
          });
          if (debug) process.stderr.write(`[gdoc-ingest]   ✓ batch read in ${Date.now() - tBatch}ms\n`);
          // Pair results back with their tab definitions, preserving order.
          tabContents = (batch.results || []).map((r, idx) => ({
            tab: tabsToRead[idx] || { name: r.sheetName, gid: null },
            data: r.error ? null : r,
            error: r.error || null,
          }));
        } catch (e) {
          const msg = String(e?.message || e || 'unknown error').slice(0, 200);
          if (debug) process.stderr.write(`[gdoc-ingest]   ✗ batch read ERROR: ${msg}\n`);
          // Fall back to empty contents — we still have metadata so the page
          // can be created with at least tab names.
          tabContents = tabsToRead.map((tab) => ({ tab, error: msg }));
        }
      }

      // Render to plain-text content suitable for summarization & entity extraction
      const lines = [];
      lines.push(`Spreadsheet: ${info.name}`);
      lines.push(`URL: ${info.url || urlDrive}`);
      lines.push(`Tabs (${tabs.length}): ${tabs.map((t) => t.name).join(' | ')}`);
      lines.push('');
      for (const { tab, data, error } of tabContents) {
        const isPriority = priorityTab && tab.gid === priorityTab.gid;
        lines.push(`### Tab: ${tab.name}${isPriority ? ' (priority — user-opened)' : ''}`);
        if (error) {
          lines.push(`(read error: ${error})`);
          lines.push('');
          continue;
        }
        const vals = data?.displayValues || data?.values || [];
        for (let i = 0; i < vals.length; i += 1) {
          const row = vals[i] || [];
          const nonEmpty = row.filter((c) => c != null && String(c).trim() !== '');
          if (nonEmpty.length === 0) continue;
          // Cap each cell at 200 chars to avoid runaway long-text cells
          const safe = nonEmpty.map((c) => String(c).slice(0, 200));
          lines.push(`R${i + 1}: ${safe.join(' | ')}`);
        }
        lines.push('');
      }

      content = lines.join('\n');
      charCount = content.length;
      // Stash sheet stats for downstream metadata
      slideStats = {
        totalTabs: tabs.length,
        readTabs: tabContents.length,
        priorityTab: priorityTab?.name || null,
        tabsRead: tabContents.map(({ tab }) => tab.name),
      };
    } else if (kind === 'slide') {
      // Use readForAgent — smart classifier that fetches thumbnails only for
      // slides with images / charts / sparse text. Plain-text slides skip
      // the thumbnail to save bandwidth + Vision tokens.
      // includeHidden=true: in many decks the executive content is in slides
      // marked as hidden (presenter notes / dashboards / drafts). We capture
      // them so Vision interpretation can decide what's worth indexing.
      const r = callGAS('slides.readForAgent', {
        presentationId: fileId,
        size: 'MEDIUM',
        includeHidden: true,
      });
      title = r.name || r.title || title;
      const extracted = extractSlideText(r);
      content = extracted.plainText;
      charCount = content.length;
      slideStats = {
        totalSlides: extracted.totalSlides,
        visibleSlides: extracted.visibleSlides,
        hiddenSlides: extracted.hiddenSlides,
      };
      // Capture thumbnail metadata for vision interpretation downstream.
      // The agent runtime calls fetchSlideImagesAsBase64() to materialize
      // base64 PNGs for the slides flagged as visual.
      //
      // Local override: GAS readForAgent classifies a slide as `text_sufficient`
      // even when its actual extracted text is < 50 chars (happens when a slide
      // is a single embedded bitmap chart — the heuristic looks at element
      // count, not text density). We force-include those slides for Vision
      // interpretation so we don't lose the data buried in image-only slides.
      payload_thumbnails = (r.slides || [])
        .map((s) => {
          const slideText = (s.elements || [])
            .map((e) => (typeof e?.text === 'string' ? e.text : ''))
            .join(' ')
            .trim();
          const needsVision = s.imageIncluded
            || (slideText.length < 50 && (s.elements || []).length >= 1);
          return {
            index: s.index,
            thumbnailUrl: s.thumbnailUrl || null,
            classification: s.contentClassification,
            isSkipped: !!s.isSkipped,
            textChars: slideText.length,
            needsVision,
          };
        })
        .filter((s) => s.needsVision);
      mimetype = 'application/vnd.google-apps.presentation';
    } else {
      // drive-file — PDF or other binary. We download via GAS as base64,
      // write to /tmp, then parse locally.
      //
      // Strategy:
      //   1. callGAS('drive.downloadFile', {fileId}) returns base64
      //   2. Decode + write /tmp/gdoc-ingest-<id>.pdf
      //   3. Use pdftotext (poppler) if available; fall back to first 2KB raw.
      //   4. Agent runtime can re-process the file via PdfParse tool for
      //      better extraction (the temp file path is exposed in payload).
      const r = callGAS('drive.downloadFile', { fileId });
      title = r.fileName || title;
      mimetype = r.mimeType || 'application/pdf';
      const tmpPath = `/tmp/gdoc-ingest-${fileId}.pdf`;
      try {
        const buf = Buffer.from(r.base64, 'base64');
        fs.writeFileSync(tmpPath, buf);
        // Try pdftotext (poppler-utils via brew). Fall back to truncated raw
        // if not installed — the agent layer can re-parse via PdfParse.
        try {
          content = execSync(`pdftotext -layout -nopgbrk "${tmpPath}" -`, {
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024,
            timeout: 30_000,
          });
        } catch {
          // pdftotext not installed; just signal. Agent will re-parse.
          content = `_PDF baixado mas pdftotext não disponível. Tamanho: ${r.sizeBytes} bytes. Path local: ${tmpPath}. Agente pode reprocessar via PdfParse._`;
        }
        charCount = content.length;
        // Stash temp path so payload exposes it for downstream reprocess.
        slideStats = {
          pdfTempPath: tmpPath,
          pdfSizeBytes: r.sizeBytes,
        };
      } catch (e) {
        content = `_Falha ao decodificar PDF: ${e.message}_`;
        charCount = 0;
      }
    }
  } catch (e) {
    content = `_Falha ao extrair conteúdo: ${e.message}_`;
    charCount = 0;
  }

  // 2. Detect meeting-doc pattern (override-by-filename)
  const isMeetingDoc = detectMeetingDoc(title);

  // 3. Filing
  const { disciplina, tema, secondaryTags } = inferDisciplinaTema(title, content);
  const proposedSlug = slugifyTitle(title);
  const inboxSlug = `docs/inbox/${proposedSlug}`;

  // 4. Summary
  const summary = await summarizeWithLLM({ title, content, kind, owner });

  // 5. Entities
  const entities = extractEntities(content, { kind });

  // 6. Render
  const indexedAt = new Date().toISOString();
  const page = renderInboxPage({
    title,
    fileId,
    kind,
    mimetype,
    owner,
    urlDrive,
    lastModified,
    indexedAt,
    indexedVia,
    proposedSlug,
    disciplina,
    tema,
    secondaryTags,
    summary,
    rawCharCount: charCount,
    slideStats,
    isMeetingDoc,
    entities,
  });

  const payload = {
    slug: inboxSlug,
    proposedFinalSlug: `docs/${disciplina}/${tema}/${proposedSlug}`,
    title,
    fileId,
    kind,
    disciplina,
    tema,
    secondaryTags,
    page,
    content, // Raw extracted content — agent uses this for richer summarization
    charCount,
    indexedAt,
    indexedVia,
    isMeetingDoc,
    slideStats,
    entities,
    thumbnails: payload_thumbnails,
  };

  if (commit) {
    callBrainPutPage(inboxSlug, page);
    payload.committed = true;

    // Iron Law: back-link from existing entity pages to this doc.
    // Only links to entities that ALREADY exist in the brain (notability gate).
    const ironLawStats = applyIronLaw(inboxSlug, entities);
    payload.ironLaw = ironLawStats;

    // Successor detection: if title suggests this doc supersedes an older one,
    // log a hint for the orchestrator. We DON'T auto-mark the predecessor as
    // archived — that's a triage decision.
    const successor = detectSuccessor(title);
    if (successor.found) {
      payload.successorOf = successor.predecessorSlug;
      payload.successorStem = successor.stem;
    }
  }
  return payload;
}

/**
 * Batch mode — ingest multiple URLs sequentially with per-item error capture.
 */
export async function ingestBatch(urls, { indexedVia = 'manual-cli', commit = false } = {}) {
  const results = [];
  for (const url of urls) {
    try {
      const r = await ingest({ url, indexedVia, commit });
      results.push({ url, ok: true, ...r, page: '(omitted; committed)' });
    } catch (e) {
      results.push({ url, ok: false, error: e.message });
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────
// CLI entry point

const __filename = fileURLToPath(import.meta.url);
const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isCli) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      console.log([
        'gdoc-ingest — index Google Workspace document(s) into the brain',
        '',
        'Usage:',
        '  bun scripts/gdoc-ingest.mjs <url> [--commit] [--via slack-paste|drive-crawler|manual-cli]',
        '  bun scripts/gdoc-ingest.mjs --batch <url1> <url2> ... [--commit] [--via ...]',
        '',
        'Examples:',
        '  bun scripts/gdoc-ingest.mjs "https://docs.google.com/document/d/abc.../edit" --commit',
        '  bun scripts/gdoc-ingest.mjs --batch url1 url2 url3 --commit --via slack-paste',
        '',
        'Without --commit, prints the payload as JSON without touching the brain.',
      ].join('\n'));
      process.exit(0);
    }
    const commit = args.includes('--commit');
    const viaIdx = args.indexOf('--via');
    const indexedVia = viaIdx >= 0 ? args[viaIdx + 1] : 'manual-cli';

    if (args.includes('--batch')) {
      const urls = args.filter((a) => /^https?:\/\//.test(a));
      const results = await ingestBatch(urls, { indexedVia, commit });
      console.log(JSON.stringify(results, null, 2));
      const ok = results.filter((r) => r.ok).length;
      process.exit(ok === results.length ? 0 : 1);
    }

    const url = args.find((a) => /^https?:\/\//.test(a));
    if (!url) {
      console.error('error: no URL provided');
      process.exit(2);
    }
    try {
      const result = await ingest({ url, indexedVia, commit });
      const out = {
        ...result,
        page: result.page.slice(0, 2500) + (result.page.length > 2500 ? '\n…(truncated)' : ''),
      };
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.error(`gdoc-ingest error: ${e.message}`);
      process.exit(1);
    }
  })();
}
