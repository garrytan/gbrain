import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods, LinkObject, NodeObject } from 'react-force-graph-2d';
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, CircleDot, Expand, ExternalLink,
  LocateFixed, Maximize2, Minimize2, MousePointer2, Network, Search, X,
} from 'lucide-react';
import { api } from '../api';
import { formatDate, pageTypeLabel } from '../lib/shared';
import {
  KNOWLEDGE_GRAPH_EXPAND_LIMIT,
  KNOWLEDGE_GRAPH_MAX_VISIBLE_NODES,
  mergeKnowledgeGraphData,
  type KnowledgeGraphData,
} from '../lib/knowledge-graph';
import { useOverview } from './console-shared';
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphMissingLink,
  KnowledgeGraphNode,
} from '../../../shared/contracts/brain.ts';

type CanvasNode = KnowledgeGraphNode & NodeObject<KnowledgeGraphNode>;
type CanvasLink = KnowledgeGraphEdge & LinkObject<KnowledgeGraphNode, KnowledgeGraphEdge>;
type GraphViewMode = 'local' | 'global' | 'isolated' | 'missing';

const EMPTY_GRAPH: KnowledgeGraphData = { nodes: [], edges: [] };

function requestedViewMode(): GraphViewMode {
  const query = window.location.hash.split('?')[1] ?? '';
  const requested = new URLSearchParams(query).get('view');
  return requested === 'global' || requested === 'isolated' || requested === 'missing' ? requested : 'local';
}

function requestedEdgeId(): number | null {
  const id = Number(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('edge'));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]!));
}

function plainPreview(value: string): string {
  return value
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/[#>*_`\[\]]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

function shortTitle(value: string, max = 18): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function linkEndpointId(value: CanvasLink['source'] | CanvasLink['target']): number {
  return typeof value === 'object' && value !== null ? Number(value.id) : Number(value);
}

export function KnowledgeGraphPage() {
  const { overview } = useOverview();
  const pageRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<CanvasNode, CanvasLink> | undefined>(undefined);
  const stageRef = useRef<HTMLDivElement>(null);
  const requestEpoch = useRef(0);
  const animationFrame = useRef<number | null>(null);
  const globalFitPending = useRef(false);
  const pendingLocalStart = useRef<KnowledgeGraphNode | null>(null);
  const [viewport, setViewport] = useState({ width: 840, height: 680 });
  const [graph, setGraph] = useState<KnowledgeGraphData>(EMPTY_GRAPH);
  const [rootId, setRootId] = useState<number | null>(null);
  const [selectedNode, setSelectedNode] = useState<KnowledgeGraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<KnowledgeGraphEdge | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());
  const [loadingIds, setLoadingIds] = useState<Set<number>>(() => new Set());
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<KnowledgeGraphNode[]>([]);
  const [searching, setSearching] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('all');
  const [relationFilter, setRelationFilter] = useState('all');
  const [relationTypes, setRelationTypes] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<GraphViewMode>(requestedViewMode);
  const [requestedEdge, setRequestedEdge] = useState<number | null>(requestedEdgeId);
  const changeView = (view: GraphViewMode) => {
    setRequestedEdge(null); setViewMode(view);
    if (requestedEdge) window.history.replaceState(null, '', `#graph?view=${view}`);
  };
  const [globalTotals, setGlobalTotals] = useState<{ nodes: number; edges: number } | null>(null);
  const [missingLinks, setMissingLinks] = useState<KnowledgeGraphMissingLink[]>([]);
  const [missingTotal, setMissingTotal] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<number | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<number | null>(null);
  const [showArrows, setShowArrows] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const prefersReducedMotion = useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  useEffect(() => {
    const syncRequestedView = () => { setViewMode(requestedViewMode()); setRequestedEdge(requestedEdgeId()); };
    window.addEventListener('hashchange', syncRequestedView);
    return () => window.removeEventListener('hashchange', syncRequestedView);
  }, []);

  const canvasData = useMemo(() => ({
    nodes: graph.nodes as CanvasNode[],
    links: graph.edges.map(edge => ({ ...edge, source: edge.from_page_id, target: edge.to_page_id })) as CanvasLink[],
  }), [graph]);
  const nodeById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes]);
  const activeNodeId = hoveredNodeId ?? selectedNode?.id ?? null;
  const activeNeighborIds = useMemo(() => {
    const ids = new Set<number>();
    if (activeNodeId === null) return ids;
    ids.add(activeNodeId);
    for (const edge of graph.edges) {
      if (edge.from_page_id === activeNodeId) ids.add(edge.to_page_id);
      if (edge.to_page_id === activeNodeId) ids.add(edge.from_page_id);
    }
    return ids;
  }, [activeNodeId, graph.edges]);
  const visibleRelations = useMemo(() => {
    if (!selectedNode) return { outgoing: [] as KnowledgeGraphEdge[], incoming: [] as KnowledgeGraphEdge[] };
    return {
      outgoing: graph.edges.filter(edge => edge.from_page_id === selectedNode.id),
      incoming: graph.edges.filter(edge => edge.to_page_id === selectedNode.id),
    };
  }, [graph.edges, selectedNode]);

  const reheat = useCallback(() => {
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    animationFrame.current = requestAnimationFrame(() => {
      graphRef.current?.resumeAnimation();
      graphRef.current?.d3ReheatSimulation();
      animationFrame.current = null;
    });
  }, []);

  const loadNeighborhood = useCallback(async (
    node: KnowledgeGraphNode,
    reset: boolean,
    relationType = relationFilter,
    showDetails = true,
  ) => {
    const epoch = requestEpoch.current;
    setError('');
    setNotice('');
    setLoadingIds(current => new Set(current).add(node.id));
    try {
      const neighborhood = await api.knowledgeGraphNeighborhood(
        node.source_id,
        node.slug,
        relationType,
        KNOWLEDGE_GRAPH_EXPAND_LIMIT,
      );
      if (epoch !== requestEpoch.current) return;
      setGraph(current => mergeKnowledgeGraphData(reset ? EMPTY_GRAPH : current, neighborhood));
      setExpandedIds(current => new Set(current).add(node.id));
      const freshCenter = neighborhood.nodes.find(item => item.id === node.id) ?? node;
      setSelectedNode(showDetails ? freshCenter : null);
      setSelectedEdge(null);
      if (reset) setRootId(node.id);
      if (neighborhood.truncated) {
        setNotice(`这个知识的关系较多，本次展示前 ${neighborhood.limit} 条；可沿节点继续探索。`);
      }
      reheat();
    } catch (caught) {
      if (epoch === requestEpoch.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (epoch === requestEpoch.current) {
        setLoadingIds(current => {
          const next = new Set(current);
          next.delete(node.id);
          return next;
        });
      }
    }
  }, [relationFilter, reheat]);

  const startFromNode = useCallback((
    node: KnowledgeGraphNode,
    relationType = relationFilter,
    showDetails = true,
  ) => {
    requestEpoch.current += 1;
    setLoadingIds(new Set());
    setGraph({ nodes: [node], edges: [] });
    setExpandedIds(new Set());
    setRootId(node.id);
    setSelectedNode(showDetails ? node : null);
    setSelectedEdge(null);
    setSearchResults([]);
    void loadNeighborhood(node, true, relationType, showDetails);
  }, [loadNeighborhood, relationFilter]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () => setViewport({
      width: Math.max(320, element.clientWidth),
      height: Math.max(480, element.clientHeight),
    });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === pageRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement === pageRef.current) {
      await document.exitFullscreen();
      return;
    }
    await pageRef.current?.requestFullscreen();
  }, []);

  useEffect(() => {
    const forceGraph = graphRef.current as (ForceGraphMethods<CanvasNode, CanvasLink> & {
      d3Force: (name: string) => unknown;
    }) | undefined;
    const charge = forceGraph?.d3Force('charge') as { strength?: (value: number) => unknown } | undefined;
    const link = forceGraph?.d3Force('link') as {
      distance?: (value: number) => unknown;
      strength?: (value: number) => unknown;
    } | undefined;
    charge?.strength?.(viewMode === 'local' ? -58 : -16);
    link?.distance?.(viewMode === 'global' ? 18 : 48);
    link?.strength?.(viewMode === 'global' ? .12 : .24);
  }, [graph.nodes.length, viewMode]);

  useEffect(() => {
    let active = true;
    requestEpoch.current += 1;
    setError('');
    setNotice('');
    setGraph(EMPTY_GRAPH);
    setSelectedNode(null);
    setSelectedEdge(null);
    setExpandedIds(new Set());
    setLoadingIds(new Set());
    setMissingLinks([]);
    setMissingTotal(0);
    setRelationFilter('all');
    const metaRequest = api.knowledgeGraphMeta(sourceFilter);
    if (requestedEdge) {
      void Promise.all([metaRequest, api.knowledgeGraphEdge(requestedEdge)]).then(([meta, focused]) => {
        if (!active) return;
        setRelationTypes(meta.relation_types);
        setGraph(focused); setSelectedEdge(focused.edges[0] ?? null); setGlobalTotals(null);
        if (!focused.edges.length) setNotice('这条关联已清理或对应知识已移出知识库。');
        globalFitPending.current = true; reheat();
      }).catch(caught => active && setError(caught instanceof Error ? caught.message : String(caught)));
      return () => { active = false; };
    }
    if (viewMode === 'missing') {
      void Promise.all([metaRequest, api.knowledgeGraphMissing(sourceFilter)])
        .then(([meta, missing]) => {
          if (!active) return;
          setRelationTypes(meta.relation_types);
          setMissingLinks(missing.rows);
          setMissingTotal(missing.total);
          if (missing.truncated) setNotice(`缺失链接较多，当前展示前 ${missing.limit} 条。`);
        })
        .catch(caught => active && setError(caught instanceof Error ? caught.message : String(caught)));
      return () => { active = false; };
    }
    if (viewMode !== 'local') {
      const graphRequest = viewMode === 'global'
        ? api.knowledgeGraphGlobal(sourceFilter, 'all')
        : api.knowledgeGraphIsolated(sourceFilter);
      void Promise.all([metaRequest, graphRequest])
        .then(([meta, global]) => {
          if (!active) return;
          setRelationTypes(meta.relation_types);
          setGraph({ nodes: global.nodes, edges: global.edges });
          setGlobalTotals({ nodes: global.total_nodes, edges: global.total_edges });
          globalFitPending.current = true;
          if (global.truncated) {
            setNotice(`${viewMode === 'isolated' ? '孤立页' : '全局图谱'}较多，当前展示 ${global.nodes.length} 个知识。`);
          }
          reheat();
        })
        .catch(caught => active && setError(caught instanceof Error ? caught.message : String(caught)));
    } else {
      setGlobalTotals(null);
      void metaRequest.then(meta => {
        if (!active) return;
        setRelationTypes(meta.relation_types);
        const requestedNode = pendingLocalStart.current;
        pendingLocalStart.current = null;
        if (requestedNode) startFromNode(requestedNode, 'all', false);
        else if (meta.seed) startFromNode(meta.seed, 'all', false);
      })
      .catch(caught => active && setError(caught instanceof Error ? caught.message : String(caught)));
    }
    return () => { active = false; };
  }, [sourceFilter, viewMode, requestedEdge]);

  useEffect(() => {
    const query = searchText.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void api.knowledgeGraphSearch(query, sourceFilter)
        .then(result => active && setSearchResults(result.rows))
        .catch(caught => active && setError(caught instanceof Error ? caught.message : String(caught)))
        .finally(() => active && setSearching(false));
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [searchText, sourceFilter]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') graphRef.current?.pauseAnimation();
      else graphRef.current?.resumeAnimation();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      graphRef.current?.pauseAnimation();
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    };
  }, []);

  const resetAroundCurrent = useCallback((nextRelation: string) => {
    setRelationFilter(nextRelation);
    if (viewMode === 'global') {
      requestEpoch.current += 1;
      const epoch = requestEpoch.current;
      setError('');
      setNotice('');
      setSelectedNode(null);
      setSelectedEdge(null);
      void api.knowledgeGraphGlobal(sourceFilter, nextRelation)
        .then(global => {
          if (epoch !== requestEpoch.current) return;
          setGraph({ nodes: global.nodes, edges: global.edges });
          setGlobalTotals({ nodes: global.total_nodes, edges: global.total_edges });
          globalFitPending.current = true;
          if (global.truncated) {
            setNotice(`全局图谱较大，当前展示 ${global.nodes.length} 个知识和 ${global.edges.length} 条关系。`);
          }
          reheat();
        })
        .catch(caught => epoch === requestEpoch.current && setError(caught instanceof Error ? caught.message : String(caught)));
      return;
    }
    if (viewMode === 'isolated') return;
    const center = selectedNode ?? (rootId ? nodeById.get(rootId) ?? null : null);
    if (!center) return;
    requestEpoch.current += 1;
    setGraph({ nodes: [center], edges: [] });
    setExpandedIds(new Set());
    setRootId(center.id);
    setSelectedEdge(null);
    const epoch = requestEpoch.current;
    setLoadingIds(new Set([center.id]));
    void api.knowledgeGraphNeighborhood(center.source_id, center.slug, nextRelation, KNOWLEDGE_GRAPH_EXPAND_LIMIT)
      .then(neighborhood => {
        if (epoch !== requestEpoch.current) return;
        setGraph(mergeKnowledgeGraphData(EMPTY_GRAPH, neighborhood));
        setExpandedIds(new Set([center.id]));
        setSelectedNode(neighborhood.nodes.find(node => node.id === center.id) ?? center);
        if (neighborhood.truncated) setNotice(`这个知识的关系较多，本次展示前 ${neighborhood.limit} 条；可沿节点继续探索。`);
        reheat();
      })
      .catch(caught => epoch === requestEpoch.current && setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => epoch === requestEpoch.current && setLoadingIds(new Set()));
  }, [nodeById, reheat, rootId, selectedNode, sourceFilter, viewMode]);

  const drawNode = useCallback((node: CanvasNode, context: CanvasRenderingContext2D, globalScale: number) => {
    if (node.x === undefined || node.y === undefined) return;
    const isRoot = node.id === rootId;
    const isSelected = node.id === selectedNode?.id;
    const isHovered = node.id === hoveredNodeId;
    const isActive = isSelected || isHovered;
    const isNeighbor = activeNeighborIds.has(Number(node.id));
    const isDimmed = activeNodeId !== null && !isNeighbor;
    const radius = Math.min(7.2, 2.15 + Math.log2(Math.max(0, node.relation_count) + 1) * .72 + (isRoot ? .45 : 0));
    context.save();
    context.globalAlpha = isDimmed ? .14 : activeNodeId !== null && !isActive ? .7 : 1;
    if (isActive) {
      context.beginPath();
      context.arc(node.x, node.y, radius + 3 / globalScale, 0, Math.PI * 2);
      context.strokeStyle = 'rgba(184, 176, 255, .82)';
      context.lineWidth = 1 / globalScale;
      context.stroke();
    }
    context.shadowBlur = isActive ? 9 / globalScale : 0;
    context.shadowColor = '#9c91ff';
    context.fillStyle = isActive ? '#aaa0ff' : isRoot ? '#e1e2e6' : isNeighbor ? '#c9cbd1' : '#a6a8ad';
    context.beginPath();
    context.arc(node.x, node.y, radius, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
    if (isActive || (globalScale >= 2.2 && (globalScale >= 3.4 || node.relation_count >= 4))) {
      const label = shortTitle(node.title, globalScale >= 3.4 ? 28 : 18);
      const fontSize = 11 / globalScale;
      context.font = `${isActive ? 600 : 450} ${fontSize}px ui-sans-serif, system-ui`;
      context.textAlign = 'center';
      context.textBaseline = 'top';
      context.fillStyle = isActive ? '#f1efff' : 'rgba(218, 219, 224, .8)';
      context.fillText(label, node.x, node.y + radius + 4 / globalScale);
    }
    context.restore();
  }, [activeNeighborIds, activeNodeId, hoveredNodeId, rootId, selectedNode?.id]);

  const isActiveLink = useCallback((link: CanvasLink) => {
    if (selectedEdge?.id === link.id || hoveredEdgeId === Number(link.id)) return true;
    if (activeNodeId === null) return false;
    return linkEndpointId(link.source) === activeNodeId || linkEndpointId(link.target) === activeNodeId;
  }, [activeNodeId, hoveredEdgeId, selectedEdge?.id]);

  const nodeTooltip = useCallback((node: CanvasNode) => [
    `<div class="stargraph-tooltip"><b>${escapeHtml(node.title)}</b>`,
    `<span>${escapeHtml(node.source_name || node.source_id)} · ${node.relation_count} 个关联</span>`,
    node.tags.length ? `<small>${node.tags.slice(0, 4).map(tag => `#${escapeHtml(tag)}`).join(' ')}</small>` : '',
    '</div>',
  ].join(''), []);

  const linkTooltip = useCallback((link: CanvasLink) => {
    const source = nodeById.get(linkEndpointId(link.source));
    const target = nodeById.get(linkEndpointId(link.target));
    return [
      '<div class="stargraph-tooltip stargraph-link-tooltip">',
      `<b>${escapeHtml(source?.title ?? '未知知识')} → ${escapeHtml(target?.title ?? '未知知识')}</b>`,
      `<span>${escapeHtml(link.link_type || '未标注关系')}</span>`,
      link.context ? `<small>${escapeHtml(link.context.slice(0, 120))}</small>` : '',
      link.link_source ? `<small>来源：${escapeHtml(link.link_source)}</small>` : '',
      '</div>',
    ].join('');
  }, [nodeById]);

  const handleNodeClick = useCallback((canvasNode: CanvasNode) => {
    const node = nodeById.get(Number(canvasNode.id));
    if (!node) return;
    setSelectedNode(node);
    setSelectedEdge(null);
    if (viewMode === 'local' && !expandedIds.has(node.id) && !loadingIds.has(node.id)) void loadNeighborhood(node, false);
  }, [expandedIds, loadNeighborhood, loadingIds, nodeById, viewMode]);

  const selectRelatedNode = (id: number) => {
    const node = nodeById.get(id);
    if (node) handleNodeClick(node as CanvasNode);
  };

  const openFullKnowledge = (node: KnowledgeGraphNode) => {
    window.location.hash = `data?source=${encodeURIComponent(node.source_id)}&slug=${encodeURIComponent(node.slug)}`;
  };

  const selectSearchResult = (node: KnowledgeGraphNode) => {
    setSearchText(node.title);
    setSearchResults([]);
    if (viewMode !== 'local') {
      const visible = nodeById.get(node.id) as CanvasNode | undefined;
      if (visible) {
        setSelectedNode(visible);
        setSelectedEdge(null);
        if (visible.x !== undefined && visible.y !== undefined) {
          graphRef.current?.centerAt(visible.x, visible.y, 420);
          graphRef.current?.zoom(2.2, 420);
        }
        return;
      }
      pendingLocalStart.current = node;
      setViewMode('local');
      return;
    }
    startFromNode(node);
  };

  return (
    <div className="pm-page knowledge-graph-page" ref={pageRef}>
      <div className="knowledge-graph-head">
        <div>
          <h1>知识图谱</h1>
          <p>从一个知识出发，沿现有关系逐层展开。只读展示，不会生成或修改关系。</p>
        </div>
      </div>

      <div className="knowledge-graph-toolbar">
        <form className="graph-search" onSubmit={event => {
          event.preventDefault();
          if (searchResults[0]) selectSearchResult(searchResults[0]);
        }}>
          <Search aria-hidden="true" />
          <input
            value={searchText}
            onChange={event => setSearchText(event.target.value)}
            placeholder="搜索知识……"
            aria-label="搜索知识"
            autoComplete="off"
          />
          {searchText && <button type="button" aria-label="清空搜索" onClick={() => setSearchText('')}><X /></button>}
          {(searching || searchResults.length > 0) && (
            <div className="graph-search-results">
              {searching && <div className="graph-search-state">正在搜索…</div>}
              {!searching && searchResults.map(result => (
                <button type="button" key={result.id} onClick={() => selectSearchResult(result)}>
                  <span><b>{result.title}</b><small>{result.source_name || result.source_id} · {result.slug}</small></span>
                  <em>{result.relation_count} 个关联</em>
                </button>
              ))}
              {!searching && searchText.trim().length >= 2 && searchResults.length === 0 && <div className="graph-search-state">没有找到匹配知识</div>}
            </div>
          )}
        </form>
        <div className="graph-view-switch" role="group" aria-label="图谱范围">
          <button type="button" className={viewMode === 'local' ? 'active' : ''} onClick={() => changeView('local')}>局部图谱</button>
          <button type="button" className={viewMode === 'global' ? 'active' : ''} onClick={() => changeView('global')}>全局图谱</button>
          <button type="button" className={viewMode === 'isolated' ? 'active' : ''} onClick={() => changeView('isolated')}>孤立页</button>
          <button type="button" className={viewMode === 'missing' ? 'active' : ''} onClick={() => changeView('missing')}>缺失链接</button>
        </div>
        <label>
          <span>Source</span>
          <select value={sourceFilter} onChange={event => { changeView(viewMode); setSourceFilter(event.target.value); }}>
            <option value="all">全部 Source</option>
            {overview?.sources.filter(source => !source.archived).map(source => (
              <option key={source.id} value={source.id}>{source.name || source.id}</option>
            ))}
          </select>
        </label>
        <label className={viewMode === 'isolated' || viewMode === 'missing' ? 'is-disabled' : ''}>
          <span>关系</span>
          <select disabled={viewMode === 'isolated' || viewMode === 'missing'} value={relationFilter} onChange={event => resetAroundCurrent(event.target.value)}>
            <option value="all">全部关系</option>
            {relationTypes.map(type => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        {viewMode !== 'missing' && <button type="button" className="graph-reset-button" onClick={() => graphRef.current?.zoomToFit(520, 64)}>
          <LocateFixed aria-hidden="true" />重置视图
        </button>}
        {viewMode !== 'missing' && <button
          type="button"
          className="graph-direction-toggle"
          aria-pressed={showArrows}
          onClick={() => setShowArrows(value => !value)}
        >
          <ArrowRight aria-hidden="true" />{showArrows ? '隐藏方向' : '显示方向'}
        </button>}
        <button type="button" className="graph-fullscreen-button" onClick={() => void toggleFullscreen()}>
          {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          {isFullscreen ? '退出全屏' : '全屏查看'}
        </button>
      </div>

      {(error || notice) && <div className={error ? 'graph-message error' : 'graph-message'}>{error || notice}</div>}

      <div className="knowledge-graph-shell">
        <div className="knowledge-graph-stage" ref={stageRef} role="region" aria-label="可拖拽和缩放的知识星图">
          {viewMode === 'missing' ? (
            <div className="graph-missing-view">
              <div className="graph-missing-summary">
                <strong>{missingTotal} 条缺失链接</strong>
                <span>这里只读展示。请核对来源知识，再恢复目标知识或修改原始关系。</span>
              </div>
              {missingLinks.length === 0 && !error ? (
                <div className="graph-empty">
                  <Network aria-hidden="true" />
                  <h2>没有缺失链接</h2>
                  <p>当前范围内的关系都能找到目标知识。</p>
                </div>
              ) : (
                <div className="graph-missing-list">
                  {missingLinks.map(link => (
                    <article key={link.id}>
                      <div>
                        <b>{link.from_title || link.from_slug || `来源页面 #${link.from_page_id}`}</b>
                        <small>{link.from_source_name || link.from_source_id || '来源 Source 不存在'} · {link.from_slug || `页面 #${link.from_page_id}`}</small>
                      </div>
                      <span>{link.link_type || '关联'} → 缺失页面 #{link.missing_page_id}</span>
                      <p>{link.context || '这条关系没有记录上下文。'}</p>
                      {link.from_source_id && link.from_slug ? (
                        <button type="button" onClick={() => { window.location.hash = `data?source=${encodeURIComponent(link.from_source_id!)}&slug=${encodeURIComponent(link.from_slug!)}`; }}>
                          查看来源知识
                        </button>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </div>
          ) : <>
          <div className="graph-stage-chrome">
            <span><CircleDot />{viewMode !== 'local'
              ? `${graph.nodes.length}${globalTotals && globalTotals.nodes !== graph.nodes.length ? ` / ${globalTotals.nodes}` : ''} 个知识`
              : `${graph.nodes.length} / ${KNOWLEDGE_GRAPH_MAX_VISIBLE_NODES} 个知识`}</span>
            <span><Network />{graph.edges.length}{globalTotals && globalTotals.edges !== graph.edges.length ? ` / ${globalTotals.edges}` : ''} 条关系</span>
            <span><MousePointer2 />{viewMode === 'global' ? '悬停聚焦 · 搜索定位' : viewMode === 'isolated' ? '点击查看 · 搜索定位' : '悬停聚焦 · 点击展开'}</span>
          </div>
          {graph.nodes.length === 0 && !error && (
            <div className="graph-empty">
              <Network aria-hidden="true" />
              <h2>{viewMode === 'isolated' ? '没有孤立页' : '选择一个知识'}</h2>
              <p>{viewMode === 'isolated' ? '这个范围内的知识都至少有一条有效关系。' : '搜索知识，或选择有内容的 Source 开始探索。'}</p>
            </div>
          )}
          <ForceGraph2D<CanvasNode, CanvasLink>
            ref={graphRef}
            width={viewport.width}
            height={viewport.height}
            graphData={canvasData}
            nodeId="id"
            backgroundColor="#181818"
            nodeCanvasObject={drawNode}
            nodePointerAreaPaint={(node, color, context) => {
              if (node.x === undefined || node.y === undefined) return;
              context.fillStyle = color;
              context.beginPath();
              context.arc(node.x, node.y, 11, 0, Math.PI * 2);
              context.fill();
            }}
            nodeLabel={nodeTooltip}
            linkLabel={linkTooltip}
            linkColor={link => isActiveLink(link)
              ? 'rgba(178, 171, 245, .72)'
              : activeNodeId !== null ? 'rgba(190, 193, 201, .055)' : 'rgba(190, 193, 201, .18)'}
            linkWidth={link => isActiveLink(link) ? 1.15 : .55}
            linkDirectionalArrowLength={showArrows ? 3.6 : 0}
            linkDirectionalArrowRelPos={0.93}
            linkDirectionalArrowColor={link => isActiveLink(link) ? '#aaa0ff' : 'rgba(190, 193, 201, .4)'}
            linkHoverPrecision={7}
            onNodeHover={node => setHoveredNodeId(node ? Number(node.id) : null)}
            onLinkHover={link => setHoveredEdgeId(link ? Number(link.id) : null)}
            onNodeClick={handleNodeClick}
            onLinkClick={link => {
              const edge = graph.edges.find(item => item.id === link.id);
              if (edge) {
                setSelectedEdge(edge);
                setSelectedNode(null);
              }
            }}
            onBackgroundClick={() => {
              setSelectedEdge(null);
              setSelectedNode(null);
            }}
            onNodeDragEnd={() => reheat()}
            enableNodeDrag
            enableZoomInteraction
            enablePanInteraction
            minZoom={viewMode === 'local' ? 0.45 : 0.02}
            maxZoom={6}
            warmupTicks={prefersReducedMotion || viewMode !== 'local' ? 0 : 12}
            cooldownTicks={prefersReducedMotion ? 1 : viewMode !== 'local' ? 45 : 80}
            d3AlphaDecay={0.045}
            d3VelocityDecay={0.32}
            onEngineStop={() => {
              if (!globalFitPending.current) return;
              globalFitPending.current = false;
              graphRef.current?.zoomToFit(500, 38);
            }}
            autoPauseRedraw
          />
          </>}
        </div>

        <aside className={`knowledge-graph-detail${selectedEdge || selectedNode ? ' is-open' : ''}`} aria-hidden={!selectedEdge && !selectedNode}>
          {(selectedEdge || selectedNode) && (
            <button
              type="button"
              className="graph-detail-close"
              aria-label="关闭详情"
              onClick={() => { setSelectedEdge(null); setSelectedNode(null); }}
            ><X /></button>
          )}
          {selectedEdge ? (
            <>
              <div className="graph-detail-kicker">RELATION</div>
              <h2>{selectedEdge.link_type || '未标注关系'}</h2>
              <div className="graph-edge-route">
                <button type="button" onClick={() => selectRelatedNode(selectedEdge.from_page_id)}>{nodeById.get(selectedEdge.from_page_id)?.title ?? '未知知识'}</button>
                <ArrowUpRight aria-hidden="true" />
                <button type="button" onClick={() => selectRelatedNode(selectedEdge.to_page_id)}>{nodeById.get(selectedEdge.to_page_id)?.title ?? '未知知识'}</button>
              </div>
              <dl className="graph-relation-meta">
                <div><dt>关系类型</dt><dd>{selectedEdge.link_type || '未标注'}</dd></div>
                <div><dt>关系来源</dt><dd>{selectedEdge.link_source || '未知'}</dd></div>
              </dl>
              <section className="graph-detail-section">
                <h3>关系上下文</h3>
                <p>{selectedEdge.context || '这条关系没有记录上下文。'}</p>
              </section>
            </>
          ) : selectedNode ? (
            <>
              <div className="graph-detail-kicker">{selectedNode.source_name || selectedNode.source_id} · {pageTypeLabel(selectedNode.type)}</div>
              <h2>{selectedNode.title}</h2>
              <div className="graph-detail-slug">{selectedNode.slug}</div>
              <div className="graph-detail-metrics">
                <div><b>{selectedNode.relation_count}</b><span>关联知识</span></div>
                <div><b>{selectedNode.incoming_count}</b><span>反向引用</span></div>
                <div><b>{selectedNode.outgoing_count}</b><span>指向知识</span></div>
              </div>
              <section className="graph-detail-section">
                <h3>知识片段</h3>
                <p>{plainPreview(selectedNode.preview) || '暂无正文片段。'}</p>
              </section>
              <section className="graph-detail-section graph-detail-facts">
                <div><span>Source</span><b>{selectedNode.source_name || selectedNode.source_id}</b></div>
                <div><span>更新时间</span><b>{formatDate(selectedNode.updated_at)}</b></div>
                <div><span>标签</span><b>{selectedNode.tags.length ? selectedNode.tags.map(tag => `#${tag}`).join(' ') : '暂无标签'}</b></div>
              </section>
              <section className="graph-detail-section graph-relation-list">
                <h3><ArrowUpRight />这个知识指向谁</h3>
                {visibleRelations.outgoing.length ? visibleRelations.outgoing.map(edge => (
                  <button type="button" key={edge.id} onClick={() => selectRelatedNode(edge.to_page_id)}>
                    <span>{nodeById.get(edge.to_page_id)?.title}</span><em>{edge.link_type || '关联'}</em>
                  </button>
                )) : <p>当前星图里没有出链。</p>}
              </section>
              <section className="graph-detail-section graph-relation-list">
                <h3><ArrowDownLeft />哪些知识引用了它</h3>
                {visibleRelations.incoming.length ? visibleRelations.incoming.map(edge => (
                  <button type="button" key={edge.id} onClick={() => selectRelatedNode(edge.from_page_id)}>
                    <span>{nodeById.get(edge.from_page_id)?.title}</span><em>{edge.link_type || '关联'}</em>
                  </button>
                )) : <p>当前星图里没有反向引用。</p>}
              </section>
              <div className="graph-detail-actions">
                {viewMode === 'local' ? (
                  <button
                    type="button"
                    className="graph-expand-button"
                    disabled={loadingIds.has(selectedNode.id)}
                    onClick={() => void loadNeighborhood(selectedNode, false)}
                  >
                    <Expand aria-hidden="true" />
                    {loadingIds.has(selectedNode.id) ? '正在展开…' : expandedIds.has(selectedNode.id) ? '刷新关系' : '展开关系'}
                  </button>
                ) : null}
                <button type="button" className="graph-open-button" onClick={() => openFullKnowledge(selectedNode)}>
                  <ExternalLink aria-hidden="true" />查看完整知识
                </button>
              </div>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
