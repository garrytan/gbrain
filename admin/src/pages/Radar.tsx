import React, { useEffect, useMemo, useState } from 'react';

type Manifest = {
  snapshot_id: string;
  generated_at: string;
  mode: string;
  counts?: Record<string, number>;
  validation?: { status?: string };
  warnings?: string[];
};

type PageIndexRow = {
  page_key: string;
  source_id: string;
  slug: string;
  title: string;
  page_path: string;
  source_path?: string | null;
  folder?: string | null;
  type?: string | null;
  status?: string | null;
  scope?: string | null;
  privacy?: string | null;
  authority?: string | null;
  tags?: string[];
  updated_at?: string | null;
  headings_count?: number;
  inlinks_count?: number;
  outlinks_count?: number;
  flags?: Record<string, boolean>;
};

type Graph = {
  nodes: Array<{ page_key: string; title: string; slug: string; folder?: string | null }>;
  edges: Array<{ from_key: string; to_key?: string | null; slug?: string; resolved?: boolean }>;
};

type Recent = { pages: PageIndexRow[] };

type PageDetail = {
  page_key: string;
  title: string;
  slug: string;
  markdown?: string;
  body?: string;
  headings?: Array<{ level: number; text: string }>;
  outlinks?: Array<{ page_key?: string | null; slug?: string; resolved?: boolean }>;
  backlinks?: Array<{ page_key?: string | null; slug?: string; title?: string; context?: string }>;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
};

const SNAPSHOT_BASE = `${import.meta.env.BASE_URL}radar-snapshot`.replace(/\/$/, '');

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${SNAPSHOT_BASE}/${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
  return res.json() as Promise<T>;
}

function fmtDate(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function markdownBlocks(markdown: string) {
  return markdown.split('\n').map((line, idx) => {
    if (line.startsWith('### ')) return <h3 key={idx}>{line.slice(4)}</h3>;
    if (line.startsWith('## ')) return <h2 key={idx}>{line.slice(3)}</h2>;
    if (line.startsWith('# ')) return <h1 key={idx}>{line.slice(2)}</h1>;
    if (line.startsWith('- ')) return <li key={idx}>{line.slice(2)}</li>;
    if (!line.trim()) return <br key={idx} />;
    return <p key={idx}>{line}</p>;
  });
}

function folderName(row: PageIndexRow) {
  return row.folder || '(raiz)';
}

export function RadarPage() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [pages, setPages] = useState<PageIndexRow[]>([]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [recent, setRecent] = useState<PageIndexRow[]>([]);
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState<string>('all');
  const [selected, setSelected] = useState<PageIndexRow | null>(null);
  const [detail, setDetail] = useState<PageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      getJson<Manifest>('manifest.json'),
      getJson<{ pages: PageIndexRow[] }>('pages-index.json'),
      getJson<Graph>('graph.json'),
      getJson<Recent>('views/recent.json'),
    ]).then(([m, p, g, r]) => {
      setManifest(m);
      setPages(p.pages || []);
      setGraph(g);
      setRecent(r.pages || []);
      setSelected((p.pages || [])[0] || null);
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setDetail(null);
    getJson<PageDetail>(selected.page_path).then(setDetail).catch((e) => {
      setError(`Falha ao carregar ${selected.title}: ${e.message}`);
    });
  }, [selected]);

  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of pages) counts.set(folderName(p), (counts.get(folderName(p)) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [pages]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pages.filter((p) => {
      if (folder !== 'all' && folderName(p) !== folder) return false;
      if (!q) return true;
      return [p.title, p.slug, p.source_path, p.type, p.status, ...(p.tags || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [pages, query, folder]);

  const hubs = useMemo(() => {
    return [...pages]
      .sort((a, b) => ((b.inlinks_count || 0) + (b.outlinks_count || 0)) - ((a.inlinks_count || 0) + (a.outlinks_count || 0)))
      .slice(0, 8);
  }, [pages]);

  const topFolders = folders.slice(0, 8);
  const danglingEdges = graph?.edges.filter((e) => !e.to_key).length || 0;
  const privatePages = pages.filter((p) => p.privacy === 'private' || p.flags?.private).length;

  if (error) {
    return <div className="radar-page"><h1>GBrain Radar</h1><div className="radar-error">{error}</div></div>;
  }

  return (
    <div className="radar-page">
      <header className="radar-hero">
        <div>
          <div className="radar-kicker">Visual mirror · read-only snapshot</div>
          <h1>GBrain Radar</h1>
          <p>Espelho visual do estado atual do GBrain: estrutura, páginas, links, busca leve e leitura.</p>
        </div>
        <div className="radar-status-card">
          <span className={`status-dot ${manifest?.validation?.status === 'ok' ? 'status-active' : 'status-warning'}`} />
          <strong>{manifest?.validation?.status || 'loading'}</strong>
          <small>{manifest ? `snapshot ${manifest.snapshot_id}` : 'carregando snapshot'}</small>
          <small>{manifest ? fmtDate(manifest.generated_at) : '—'}</small>
        </div>
      </header>

      <section className="radar-grid radar-metrics-grid">
        <div className="radar-card"><span>Páginas</span><strong>{manifest?.counts?.pages ?? pages.length}</strong></div>
        <div className="radar-card"><span>Links</span><strong>{manifest?.counts?.edges ?? graph?.edges.length ?? 0}</strong></div>
        <div className="radar-card"><span>Resolvidos</span><strong>{manifest?.counts?.edges_resolved ?? 0}</strong></div>
        <div className="radar-card"><span>Dangling</span><strong>{manifest?.counts?.edges_dangling ?? danglingEdges}</strong></div>
        <div className="radar-card"><span>Pastas</span><strong>{folders.length}</strong></div>
        <div className="radar-card"><span>Privadas no snapshot</span><strong>{privatePages}</strong></div>
      </section>

      {manifest?.warnings?.length ? (
        <section className="radar-warning"><strong>Warnings:</strong> {manifest.warnings.join(' · ')}</section>
      ) : null}

      <section className="radar-search-panel">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por título, slug, tag, tipo…" />
        <select value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="all">Todas as pastas</option>
          {folders.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}
        </select>
      </section>

      <section className="radar-split">
        <div>
          <h2>Áreas reais do snapshot</h2>
          <div className="radar-folder-grid">
            {topFolders.map(([name, count]) => (
              <button key={name} className="radar-folder-card" onClick={() => setFolder(name)}>
                <strong>{name}</strong>
                <span>{count} páginas</span>
              </button>
            ))}
          </div>

          <h2>Resultados ({filtered.length})</h2>
          <div className="radar-list">
            {filtered.slice(0, 80).map((p) => (
              <button key={p.page_key} className={`radar-row ${selected?.page_key === p.page_key ? 'active' : ''}`} onClick={() => setSelected(p)}>
                <strong>{p.title}</strong>
                <span>{p.slug}</span>
                <small>{folderName(p)} · {p.type || 'type?'} · {p.inlinks_count || 0} in / {p.outlinks_count || 0} out · {fmtDate(p.updated_at)}</small>
              </button>
            ))}
          </div>
        </div>

        <aside>
          <h2>Hubs</h2>
          <div className="radar-mini-list">
            {hubs.map((p) => <button key={p.page_key} onClick={() => setSelected(p)}>{p.title}<span>{(p.inlinks_count || 0) + (p.outlinks_count || 0)} conexões</span></button>)}
          </div>
          <h2>Recentes</h2>
          <div className="radar-mini-list">
            {recent.slice(0, 8).map((p) => <button key={p.page_key} onClick={() => setSelected(p)}>{p.title}<span>{fmtDate(p.updated_at)}</span></button>)}
          </div>
        </aside>
      </section>

      <section className="radar-reader">
        <div className="radar-reader-main">
          <div className="radar-kicker">Leitor read-only</div>
          <h1>{selected?.title || 'Selecione uma página'}</h1>
          {selected ? <p className="radar-path">{selected.source_id}::{selected.slug}</p> : null}
          <article className="radar-markdown">
            {detail ? markdownBlocks(detail.body || detail.markdown || '') : <p>Carregando página…</p>}
          </article>
        </div>
        <aside className="radar-reader-side">
          <h3>Outline</h3>
          {(detail?.headings || []).map((h, idx) => <div key={idx} style={{ paddingLeft: (h.level - 1) * 10 }}>{h.text}</div>)}
          <h3>Outlinks</h3>
          {(detail?.outlinks || []).slice(0, 20).map((l, idx) => <div key={idx} className={l.resolved ? 'radar-link-ok' : 'radar-link-warn'}>{l.slug || l.page_key}</div>)}
          <h3>Frontmatter</h3>
          <pre>{detail?.frontmatter ? JSON.stringify(detail.frontmatter, null, 2) : '—'}</pre>
        </aside>
      </section>
    </div>
  );
}
