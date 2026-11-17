/**
 * The graph map: pages and concepts as one two-level graph, each edge labelled
 * with its evidence, clustered across the whole graph, laid out and rendered
 * as one self-contained HTML file. Pure: no I/O; the command reads the rows.
 *
 * Levels. Concept pages (type `concept`, built by the synthesize_concepts
 * phase) are the second level. Atoms (type `atom`, built by extract_atoms) are
 * only the bridge between them: a page's atoms point at concepts, so each
 * page -> atom -> concept path becomes one direct page -- concept edge
 * (`mentions_concept`, evidence `inferred`) and atoms are not drawn.
 *
 * Evidence (a label, never a filter that hides anything):
 *   stated       written by a person: a markdown or wiki link, a frontmatter
 *                field, `add_link`
 *   inferred     worked out by gbrain: mentions, typed NER links, atom and
 *                concept provenance, dream phases, any other producer
 *   tool_output  reported by an outside tool over MCP (`mcp-remote-mention`)
 *
 * Clusters: deterministic weighted label propagation over the undirected
 * graph (ties go to the smallest label), so the same graph always gives the
 * same clusters.
 */

export type Evidence = 'stated' | 'inferred' | 'tool_output';
export const EVIDENCE_KINDS: readonly Evidence[] = ['stated', 'inferred', 'tool_output'];

const STATED_SOURCES = new Set(['markdown', 'frontmatter', 'wikilink-resolved', 'manual']);
const TOOL_SOURCES = new Set(['mcp-remote-mention']);

/** The evidence label of a stored link, from its provenance tag. A NULL tag is a legacy markdown link. */
export function edgeEvidence(linkSource: string | null | undefined, linkKind?: string | null): Evidence {
  if (linkKind === 'typed_ner') return 'inferred';
  if (linkSource === null || linkSource === undefined || linkSource === '') return 'stated';
  if (STATED_SOURCES.has(linkSource)) return 'stated';
  if (TOOL_SOURCES.has(linkSource)) return 'tool_output';
  return 'inferred';
}

export interface GraphPageRow { id: number; slug: string; title: string | null; type: string | null }
export interface GraphLinkRow { from_page_id: number; to_page_id: number; link_type: string | null; link_source: string | null; link_kind: string | null }

export interface GraphNode { id: number; slug: string; title: string; kind: 'page' | 'concept'; type: string | null; degree: number }
export interface GraphEdge {
  /** Smaller node id first: the map is undirected. */
  a: number;
  b: number;
  /** Every evidence label among the links this edge merges. */
  evidence: Evidence[];
  /** Distinct link types (`mentions_concept` for a collapsed page -- concept edge). */
  types: string[];
  /** How many stored links (or atom paths) support it. */
  weight: number;
}
export interface GraphMap {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Pages (not concepts) that reach at least one concept, and pages in all: concept coverage so far. */
  coverage: { pages_with_concepts: number; pages: number; concepts: number };
}

const isAtom = (p: GraphPageRow | undefined) => p?.type === 'atom';
const isConcept = (p: GraphPageRow | undefined) => p?.type === 'concept';

/** Build the two-level map from page and link rows of one source (deleted and private pages already left out). */
export function buildGraphMap(pages: readonly GraphPageRow[], links: readonly GraphLinkRow[]): GraphMap {
  const byId = new Map(pages.map(p => [p.id, p]));
  const edges = new Map<string, GraphEdge>();
  const add = (x: number, y: number, evidence: Evidence, type: string, weight = 1) => {
    if (x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = `${a}:${b}`;
    const e = edges.get(key) ?? { a, b, evidence: [], types: [], weight: 0 };
    if (!e.evidence.includes(evidence)) e.evidence.push(evidence);
    if (type && !e.types.includes(type)) e.types.push(type);
    e.weight += weight;
    edges.set(key, e);
  };

  // Atom bridges: page -> atom (atom-provenance) and atom <-> concept (concept-provenance).
  const atomPages = new Map<number, Set<number>>();
  const atomConcepts = new Map<number, Set<number>>();
  const put = (m: Map<number, Set<number>>, k: number, v: number) => { (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v); };
  for (const l of links) {
    const from = byId.get(l.from_page_id), to = byId.get(l.to_page_id);
    if (!from || !to) continue;
    if (isAtom(from) || isAtom(to)) {
      if (isAtom(to) && !isAtom(from) && !isConcept(from)) put(atomPages, to.id, from.id);
      else if (isAtom(from) && isConcept(to)) put(atomConcepts, from.id, to.id);
      else if (isConcept(from) && isAtom(to)) put(atomConcepts, to.id, from.id);
      continue;
    }
    add(from.id, to.id, edgeEvidence(l.link_source, l.link_kind), l.link_type ?? '');
  }
  for (const [atom, srcPages] of atomPages) {
    for (const concept of atomConcepts.get(atom) ?? []) for (const page of srcPages) add(page, concept, 'inferred', 'mentions_concept');
  }

  const degree = new Map<number, number>();
  for (const e of edges.values()) { degree.set(e.a, (degree.get(e.a) ?? 0) + 1); degree.set(e.b, (degree.get(e.b) ?? 0) + 1); }
  const nodes: GraphNode[] = pages.filter(p => !isAtom(p)).map(p => ({
    id: p.id, slug: p.slug, title: p.title || p.slug, kind: (isConcept(p) ? 'concept' : 'page') as GraphNode['kind'], type: p.type, degree: degree.get(p.id) ?? 0,
  })).sort((x, y) => x.id - y.id);
  const conceptIds = new Set(nodes.filter(n => n.kind === 'concept').map(n => n.id));
  const withConcept = new Set<number>();
  for (const e of edges.values()) {
    if (conceptIds.has(e.a) && !conceptIds.has(e.b)) withConcept.add(e.b);
    if (conceptIds.has(e.b) && !conceptIds.has(e.a)) withConcept.add(e.a);
  }
  return {
    nodes,
    edges: [...edges.values()].sort((x, y) => x.a - y.a || x.b - y.b),
    coverage: { pages_with_concepts: withConcept.size, pages: nodes.length - conceptIds.size, concepts: conceptIds.size },
  };
}

export interface Clusters {
  /** Node id -> cluster number (0 = the largest cluster). */
  of: Map<number, number>;
  /** Cluster number -> member node ids, largest first. */
  members: number[][];
}

/**
 * Deterministic weighted label propagation. Each node starts in its own
 * cluster and repeatedly takes the label with the most edge weight among its
 * neighbours (ties: the smallest label; isolated nodes keep their own). Nodes
 * are visited in id order, so the result never depends on input order.
 */
export function clusterGraph(map: GraphMap, maxRounds = 30): Clusters {
  const adj = new Map<number, Array<[number, number]>>();
  for (const n of map.nodes) adj.set(n.id, []);
  for (const e of map.edges) {
    const w = e.weight * (e.evidence.includes('stated') ? 2 : 1);
    adj.get(e.a)?.push([e.b, w]);
    adj.get(e.b)?.push([e.a, w]);
  }
  const label = new Map(map.nodes.map(n => [n.id, n.id]));
  const order = map.nodes.map(n => n.id);
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    for (const id of order) {
      const score = new Map<number, number>();
      for (const [other, w] of adj.get(id)!) score.set(label.get(other)!, (score.get(label.get(other)!) ?? 0) + w);
      if (score.size === 0) continue;
      let best = label.get(id)!, bestScore = score.get(best) ?? -1;
      for (const [l, s] of score) if (s > bestScore || (s === bestScore && l < best)) { best = l; bestScore = s; }
      if (best !== label.get(id)) { label.set(id, best); changed = true; }
    }
    if (!changed) break;
  }
  const groups = new Map<number, number[]>();
  for (const id of order) (groups.get(label.get(id)!) ?? groups.set(label.get(id)!, []).get(label.get(id)!)!).push(id);
  const members = [...groups.values()].sort((x, y) => y.length - x.length || x[0]! - y[0]!);
  const of = new Map<number, number>();
  members.forEach((m, i) => m.forEach(id => of.set(id, i)));
  return { of, members };
}

/** A short name for a cluster: its concept with the most connections, else its best-connected page. */
export function clusterName(map: GraphMap, ids: readonly number[]): string {
  const byId = new Map(map.nodes.map(n => [n.id, n]));
  const nodes = ids.map(id => byId.get(id)!).filter(Boolean);
  const pick = (list: GraphNode[]) => list.sort((x, y) => y.degree - x.degree || x.id - y.id)[0];
  return (pick(nodes.filter(n => n.kind === 'concept')) ?? pick(nodes))?.title ?? 'cluster';
}

export interface Point { x: number; y: number }

/**
 * Deterministic layout: cluster centres on a golden-angle spiral (largest in
 * the middle), members around their centre on a sunflower spiral, nudged by a
 * few rounds of spring forces inside each cluster up to 300 members.
 */
export function layoutGraph(map: GraphMap, clusters: Clusters): Map<number, Point> {
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const pos = new Map<number, Point>();
  const radiusOf = (n: number) => 14 * Math.sqrt(n) + 20;
  let ring = 0;
  clusters.members.forEach((ids, ci) => {
    const r = radiusOf(ids.length);
    const centre = ci === 0 ? { x: 0, y: 0 } : { x: Math.cos(ci * GOLDEN) * (ring + r), y: Math.sin(ci * GOLDEN) * (ring + r) };
    ring = Math.max(ring, Math.hypot(centre.x, centre.y) * 0.9 + r * 0.6);
    ids.forEach((id, i) => {
      const d = 14 * Math.sqrt(i + 0.5);
      pos.set(id, { x: centre.x + Math.cos(i * GOLDEN) * d, y: centre.y + Math.sin(i * GOLDEN) * d });
    });
    if (ids.length > 1 && ids.length <= 300) springs(map, new Set(ids), pos);
  });
  return pos;
}

function springs(map: GraphMap, members: Set<number>, pos: Map<number, Point>): void {
  const ids = [...members];
  const local = map.edges.filter(e => members.has(e.a) && members.has(e.b));
  for (let round = 0; round < 40; round++) {
    const move = new Map(ids.map(id => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const p = pos.get(ids[i]!)!, q = pos.get(ids[j]!)!;
      const dx = p.x - q.x, dy = p.y - q.y, d2 = Math.max(dx * dx + dy * dy, 1);
      const f = 400 / d2;
      move.get(ids[i]!)!.x += dx * f; move.get(ids[i]!)!.y += dy * f;
      move.get(ids[j]!)!.x -= dx * f; move.get(ids[j]!)!.y -= dy * f;
    }
    for (const e of local) {
      const p = pos.get(e.a)!, q = pos.get(e.b)!;
      const dx = q.x - p.x, dy = q.y - p.y;
      move.get(e.a)!.x += dx * 0.02; move.get(e.a)!.y += dy * 0.02;
      move.get(e.b)!.x -= dx * 0.02; move.get(e.b)!.y -= dy * 0.02;
    }
    for (const id of ids) {
      const m = move.get(id)!, len = Math.hypot(m.x, m.y), cap = 6;
      const s = len > cap ? cap / len : 1;
      const p = pos.get(id)!;
      pos.set(id, { x: p.x + m.x * s, y: p.y + m.y * s });
    }
  }
}

/** Everything the HTML page needs, ready to embed as JSON. */
export interface GraphMapExport {
  title: string;
  generated_at: string;
  source: string;
  coverage: GraphMap['coverage'];
  clusters: Array<{ id: number; name: string; size: number }>;
  nodes: Array<{ id: number; slug: string; title: string; kind: 'page' | 'concept'; cluster: number; x: number; y: number; degree: number }>;
  edges: Array<{ a: number; b: number; evidence: Evidence[]; types: string[]; weight: number }>;
}

export function graphMapExport(map: GraphMap, clusters: Clusters, layout: Map<number, Point>, meta: { source: string; generatedAt: Date; title?: string }): GraphMapExport {
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    title: meta.title ?? `Graph map: ${meta.source}`,
    generated_at: meta.generatedAt.toISOString(),
    source: meta.source,
    coverage: map.coverage,
    clusters: clusters.members.map((ids, i) => ({ id: i, name: clusterName(map, ids), size: ids.length })),
    nodes: map.nodes.map(n => ({ id: n.id, slug: n.slug, title: n.title, kind: n.kind, cluster: clusters.of.get(n.id) ?? 0,
      x: round(layout.get(n.id)?.x ?? 0), y: round(layout.get(n.id)?.y ?? 0), degree: n.degree })),
    edges: map.edges.map(e => ({ a: e.a, b: e.b, evidence: e.evidence, types: e.types, weight: e.weight })),
  };
}

/** JSON safe to place inside a <script> element: no `</script`, no `<!--`, no line separators. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** One self-contained HTML file: no network requests, data inline, pan/zoom, filters, search. */
export function renderGraphHtml(data: GraphMapExport): string {
  const title = escapeHtml(data.title);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${title}</title>
<style>
:root{--bg:#fafafa;--fg:#1b1b1f;--muted:#666;--line:#bbb;--panel:#fff;--border:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#121216;--fg:#ececec;--muted:#9a9a9a;--line:#555;--panel:#1c1c22;--border:#333}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
#bar{position:fixed;top:0;left:0;right:0;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:8px 12px;background:var(--panel);border-bottom:1px solid var(--border);z-index:2}
#bar h1{font-size:15px;margin:0 8px 0 0}#bar label{white-space:nowrap}#bar input[type=search]{padding:4px 8px;min-width:180px}
#info{position:fixed;right:12px;bottom:12px;max-width:min(380px,calc(100% - 24px));background:var(--panel);border:1px solid var(--border);padding:10px 12px;border-radius:6px;z-index:2}
#info .muted{color:var(--muted)}svg{display:block;width:100%;height:100%;cursor:grab}
line{stroke:var(--line);stroke-width:1}line.inferred{stroke-dasharray:4 3}line.tool_output{stroke-dasharray:1 3}line.dim,circle.dim{opacity:.12}
circle{stroke:var(--bg);stroke-width:1.5;cursor:pointer}text.lbl{font-size:11px;fill:var(--fg);pointer-events:none;paint-order:stroke;stroke:var(--bg);stroke-width:3px}circle.concept{stroke:var(--fg);stroke-width:2}circle.hit{stroke:var(--fg);stroke-width:3}
</style></head><body>
<div id="bar"><h1>${title}</h1>
<label><input type="checkbox" data-ev="stated" checked> stated</label>
<label><input type="checkbox" data-ev="inferred" checked> inferred</label>
<label><input type="checkbox" data-ev="tool_output" checked> tool output</label>
<label><input type="checkbox" id="concepts" checked> concepts</label>
<input type="search" id="q" placeholder="Find a page or concept">
<span id="stats"></span></div>
<svg id="map" role="img" aria-label="${title}"><g id="view"><g id="edges"></g><g id="nodes"></g></g></svg>
<div id="info"><span class="muted">Click a node. Drag to pan, scroll to zoom. Solid lines are stated links, dashed are inferred, dotted came from a tool.</span></div>
<script id="graph-data" type="application/json">${scriptSafeJson(data)}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('graph-data').textContent);
var NS='http://www.w3.org/2000/svg',svg=document.getElementById('map'),view=document.getElementById('view');
var byId={},adj={};D.nodes.forEach(function(n){byId[n.id]=n;adj[n.id]=[];});
D.edges.forEach(function(e){adj[e.a].push(e.b);adj[e.b].push(e.a);});
function hue(c){return (c*137.508)%360;}
function el(t,a){var x=document.createElementNS(NS,t);for(var k in a)x.setAttribute(k,a[k]);return x;}
var lines=D.edges.map(function(e){var a=byId[e.a],b=byId[e.b];var ev=e.evidence.indexOf('stated')>=0?'stated':(e.evidence.indexOf('tool_output')>=0?'tool_output':'inferred');
var l=el('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,'class':ev});l.__e=e;l.__ev=ev;document.getElementById('edges').appendChild(l);return l;});
var dots=D.nodes.map(function(n){var c=el('circle',{cx:n.x,cy:n.y,r:Math.min(4+Math.sqrt(n.degree)*1.6,16),fill:'hsl('+hue(n.cluster)+',60%,55%)','class':n.kind});
var t=el('title',{});t.textContent=n.title;c.appendChild(t);c.__n=n;c.addEventListener('click',function(ev){ev.stopPropagation();show(n);});
document.getElementById('nodes').appendChild(c);return c;});
var labelled=D.nodes.slice().sort(function(a,b){return b.degree-a.degree||a.id-b.id;}).slice(0,60);
var labels=labelled.map(function(n){var t=el('text',{x:n.x+8,y:n.y+4,'class':'lbl'});t.textContent=n.title.length>40?n.title.slice(0,39)+'\u2026':n.title;t.__n=n;document.getElementById('nodes').appendChild(t);return t;});
document.getElementById('stats').textContent=D.nodes.length+' nodes, '+D.edges.length+' links, '+D.clusters.length+' clusters; concepts on '+D.coverage.pages_with_concepts+' of '+D.coverage.pages+' pages';
function txt(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function show(n){var cl=D.clusters[n.cluster];var nb=adj[n.id].map(function(i){return byId[i];}).sort(function(a,b){return b.degree-a.degree;}).slice(0,12);
document.getElementById('info').innerHTML='<strong>'+txt(n.title)+'</strong><div class="muted">'+txt(n.slug)+' &middot; '+n.kind+' &middot; cluster: '+txt(cl?cl.name:'')+'</div>'+
(nb.length?'<div>Linked to: '+nb.map(function(m){return txt(m.title);}).join(', ')+(adj[n.id].length>12?' &hellip;':'')+'</div>':'<div class="muted">No links.</div>');
dots.forEach(function(d){d.classList.toggle('hit',d.__n===n);});}
function apply(){var on={};document.querySelectorAll('[data-ev]').forEach(function(b){on[b.getAttribute('data-ev')]=b.checked;});
var showC=document.getElementById('concepts').checked;
dots.forEach(function(d){d.style.display=(!showC&&d.__n.kind==='concept')?'none':'';});
labels.forEach(function(t){t.style.display=(!showC&&t.__n.kind==='concept')?'none':'';});
lines.forEach(function(l){var e=l.__e;var hidden=!on[l.__ev]||(!showC&&(byId[e.a].kind==='concept'||byId[e.b].kind==='concept'));l.style.display=hidden?'none':'';});}
document.querySelectorAll('#bar input[type=checkbox]').forEach(function(b){b.addEventListener('change',apply);});
document.getElementById('q').addEventListener('input',function(){var q=this.value.trim().toLowerCase();
dots.forEach(function(d){var hit=!q||d.__n.title.toLowerCase().indexOf(q)>=0||d.__n.slug.toLowerCase().indexOf(q)>=0;d.classList.toggle('dim',!hit);});
lines.forEach(function(l){l.classList.toggle('dim',!!q);});});
var xs=D.nodes.map(function(n){return n.x;}),ys=D.nodes.map(function(n){return n.y;});
var minX=Math.min.apply(null,xs.concat([0]))-40,maxX=Math.max.apply(null,xs.concat([0]))+40,minY=Math.min.apply(null,ys.concat([0]))-80,maxY=Math.max.apply(null,ys.concat([0]))+40;
var vb={x:minX,y:minY,w:maxX-minX,h:maxY-minY};function setVb(){svg.setAttribute('viewBox',vb.x+' '+vb.y+' '+vb.w+' '+vb.h);}setVb();
svg.addEventListener('wheel',function(ev){ev.preventDefault();var k=ev.deltaY>0?1.15:1/1.15;var r=svg.getBoundingClientRect();
var px=vb.x+(ev.clientX-r.left)/r.width*vb.w,py=vb.y+(ev.clientY-r.top)/r.height*vb.h;vb.w*=k;vb.h*=k;vb.x=px-(px-vb.x)*k;vb.y=py-(py-vb.y)*k;setVb();},{passive:false});
var drag=null;svg.addEventListener('pointerdown',function(ev){drag={x:ev.clientX,y:ev.clientY,vx:vb.x,vy:vb.y};});
window.addEventListener('pointermove',function(ev){if(!drag)return;var r=svg.getBoundingClientRect();vb.x=drag.vx-(ev.clientX-drag.x)/r.width*vb.w;vb.y=drag.vy-(ev.clientY-drag.y)/r.height*vb.h;setVb();});
window.addEventListener('pointerup',function(){drag=null;});
})();
</script></body></html>
`;
}
