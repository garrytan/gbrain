"""Memory System Implementation.

Provides composable building blocks for agent memory: vector stores with
metadata indexing, property graphs for entity relationships, and temporal
knowledge graphs for facts that change over time.

Use when:
    - Building a memory persistence layer for an agent that must retain
      knowledge across sessions.
    - Prototyping memory architectures before committing to a production
      framework (Mem0, Zep/Graphiti, Letta, Cognee).
    - Combining semantic search with graph-based entity retrieval in a
      single integrated system.

Typical usage::

    from memory_store import IntegratedMemorySystem
    mem = IntegratedMemorySystem()
    mem.start_session("session-001")
    mem.store_fact("Alice prefers dark mode", entity="Alice")
    results = mem.retrieve_memories("theme preference")
"""

import hashlib
import json
from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np

__all__ = [
    "VectorStore",
    "PropertyGraph",
    "TemporalKnowledgeGraph",
    "IntegratedMemorySystem",
]


class VectorStore:
    """Simple vector store with metadata indexing.

    Use when: the agent needs semantic similarity search over stored facts
    with optional entity and temporal filtering.
    """

    def __init__(self, dimension: int = 768) -> None:
        self.dimension: int = dimension
        self.vectors: List[np.ndarray] = []
        self.metadata: List[Dict[str, Any]] = []
        self.entity_index: Dict[str, List[int]] = {}
        self.time_index: Dict[str, List[int]] = {}

    def add(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> int:
        """Add document to store.

        Use when: persisting a new fact or observation that the agent should
        be able to retrieve later via semantic search.
        """
        metadata = metadata or {}
        embedding: np.ndarray = self._embed(text)
        index: int = len(self.vectors)

        self.vectors.append(embedding)
        self.metadata.append(metadata)

        # Index by entity
        if "entity" in metadata:
            entity: str = metadata["entity"]
            if entity not in self.entity_index:
                self.entity_index[entity] = []
            self.entity_index[entity].append(index)

        # Index by time
        if "valid_from" in metadata:
            time_key: str = self._time_key(metadata["valid_from"])
            if time_key not in self.time_index:
                self.time_index[time_key] = []
            self.time_index[time_key].append(index)

        return index

    def search(
        self,
        query: str,
        limit: int = 5,
        filters: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """Search for similar documents.

        Use when: retrieving memories relevant to a query, optionally
        narrowed by metadata filters (entity, session, time range).
        """
        query_embedding: np.ndarray = self._embed(query)

        scores: List[tuple[int, float]] = []
        for i, vec in enumerate(self.vectors):
            score: float = float(
                np.dot(query_embedding, vec)
                / (np.linalg.norm(query_embedding) * np.linalg.norm(vec) + 1e-8)
            )

            # Apply filters
            if filters and not self._matches_filters(self.metadata[i], filters):
                score = -1.0

            scores.append((i, score))

        scores.sort(key=lambda x: x[1], reverse=True)

        results: List[Dict[str, Any]] = []
        for idx, score in scores[:limit]:
            if score > 0:
                results.append(
                    {
                        "index": idx,
                        "score": score,
                        "text": self.metadata[idx].get("text", ""),
                        "metadata": self.metadata[idx],
                    }
                )

        return results

    def search_by_entity(
        self, entity: str, query: str = "", limit: int = 5
    ) -> List[Dict[str, Any]]:
        """Search within specific entity.

        Use when: the agent needs all memories associated with a known
        entity, optionally ranked by relevance to a query.
        """
        indices: List[int] = self.entity_index.get(entity, [])

        if not indices:
            return []

        if query:
            query_embedding: np.ndarray = self._embed(query)
            scored: List[tuple[int, float, Dict[str, Any]]] = []
            for i in indices:
                vec: np.ndarray = self.vectors[i]
                score: float = float(
                    np.dot(query_embedding, vec)
                    / (np.linalg.norm(query_embedding) * np.linalg.norm(vec) + 1e-8)
                )
                scored.append((i, score, self.metadata[i]))

            scored.sort(key=lambda x: x[1], reverse=True)
            return [
                {"index": i, "score": s, "metadata": m}
                for i, s, m in scored[:limit]
            ]
        else:
            return [
                {"index": i, "score": 1.0, "metadata": self.metadata[i]}
                for i in indices[:limit]
            ]

    def _embed(self, text: str) -> np.ndarray:
        """Generate embedding for text.

        In production, replace with an actual embedding model. This
        deterministic stub uses the text hash as a random seed so that
        identical texts always produce identical vectors. Uses a local
        RNG to avoid corrupting global numpy random state.
        """
        rng = np.random.default_rng(hash(text) % (2**32))
        return rng.standard_normal(self.dimension)

    def _time_key(self, timestamp: Any) -> str:
        """Create time key for indexing."""
        if isinstance(timestamp, datetime):
            return timestamp.strftime("%Y-%m")
        return str(timestamp)

    def _matches_filters(self, metadata: Dict[str, Any], filters: Dict[str, Any]) -> bool:
        """Check if metadata matches filters."""
        for key, value in filters.items():
            if key not in metadata:
                return False
            if isinstance(value, list):
                if metadata[key] not in value:
                    return False
            elif metadata[key] != value:
                return False
        return True


class PropertyGraph:
    """Simple property graph storage.

    Use when: the agent needs to maintain entity relationships and
    traverse connections between nodes (e.g., "find all projects
    associated with this user").
    """

    def __init__(self) -> None:
        self.nodes: Dict[str, Dict[str, Any]] = {}
        self.edges: Dict[str, Dict[str, Any]] = {}
        self.entity_registry: Dict[str, str] = {}  # name -> node_id
        self.node_index: Dict[str, List[str]] = {}  # label -> node_ids
        self.edge_index: Dict[str, List[str]] = {}  # type -> edge_ids

    def get_or_create_node(
        self, name: str, label: str = "Entity", properties: Optional[Dict[str, Any]] = None
    ) -> str:
        """Get existing node by name, or create a new one.

        Use when: storing an entity that may already exist. The entity
        registry ensures identity is maintained across interactions
        ("John Doe" always maps to the same node).
        """
        if name in self.entity_registry:
            node_id: str = self.entity_registry[name]
            if properties:
                self.nodes[node_id]["properties"].update(properties)
            return node_id
        node_id = self.create_node(label, {**(properties or {}), "name": name})
        self.entity_registry[name] = node_id
        return node_id

    def create_node(self, label: str, properties: Optional[Dict[str, Any]] = None) -> str:
        """Create node with label and properties.

        Use when: adding a new entity to the graph that does not need
        identity deduplication (prefer get_or_create_node otherwise).
        """
        node_id: str = hashlib.md5(f"{label}{datetime.now().isoformat()}".encode()).hexdigest()[:16]

        self.nodes[node_id] = {
            "id": node_id,
            "label": label,
            "properties": properties or {},
            "created_at": datetime.now().isoformat(),
        }

        if label not in self.node_index:
            self.node_index[label] = []
        self.node_index[label].append(node_id)

        return node_id

    def create_relationship(
        self,
        source_id: str,
        rel_type: str,
        target_id: str,
        properties: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Create directed relationship between nodes.

        Use when: recording a connection between two entities (e.g.,
        WORKS_AT, LIVES_IN, DEPENDS_ON).
        """
        if source_id not in self.nodes:
            raise ValueError(f"Unknown source node: {source_id}")
        if target_id not in self.nodes:
            raise ValueError(f"Unknown target node: {target_id}")

        edge_id: str = hashlib.md5(
            f"{source_id}{rel_type}{target_id}{datetime.now().isoformat()}".encode()
        ).hexdigest()[:16]

        self.edges[edge_id] = {
            "id": edge_id,
            "source": source_id,
            "target": target_id,
            "type": rel_type,
            "properties": properties or {},
            "created_at": datetime.now().isoformat(),
        }

        if rel_type not in self.edge_index:
            self.edge_index[rel_type] = []
        self.edge_index[rel_type].append(edge_id)

        return edge_id

    def query(self, pattern: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Query graph with simple pattern matching.

        Use when: finding relationships that match a structural pattern
        (e.g., all WORKS_AT edges from Person nodes).
        """
        results: List[Dict[str, Any]] = []

        # Match by edge type
        if "type" in pattern:
            edge_ids: List[str] = self.edge_index.get(pattern["type"], [])
            for eid in edge_ids:
                edge: Dict[str, Any] = self.edges[eid]
                source: Dict[str, Any] = self.nodes.get(edge["source"], {})
                target: Dict[str, Any] = self.nodes.get(edge["target"], {})

                # Match source label
                if "source_label" in pattern:
                    if source.get("label") != pattern["source_label"]:
                        continue

                # Match target label
                if "target_label" in pattern:
                    if target.get("label") != pattern["target_label"]:
                        continue

                results.append({"source": source, "edge": edge, "target": target})

        return results

    def get_node(self, node_id: str) -> Optional[Dict[str, Any]]:
        """Get node by ID."""
        return self.nodes.get(node_id)

    def get_relationships(
        self, node_id: str, direction: str = "both"
    ) -> List[Dict[str, Any]]:
        """Get relationships for a node.

        Use when: retrieving all connections for a given entity to build
        a complete entity context.
        """
        relationships: List[Dict[str, Any]] = []

        for edge in self.edges.values():
            if direction in ["outgoing", "both"] and edge["source"] == node_id:
                relationships.append(
                    {
                        "edge": edge,
                        "target": self.nodes.get(edge["target"]),
                        "direction": "outgoing",
                    }
                )
            if direction in ["incoming", "both"] and edge["target"] == node_id:
                relationships.append(
                    {
                        "edge": edge,
                        "source": self.nodes.get(edge["source"]),
                        "direction": "incoming",
                    }
                )

        return relationships


class TemporalKnowledgeGraph(PropertyGraph):
    """Property graph with temporal validity for facts.

    Use when: the agent must track facts that change over time and
    answer time-scoped queries (e.g., "where did the user live in
    March 2024?").
    """

    def create_temporal_relationship(
        self,
        source_id: str,
        rel_type: str,
        target_id: str,
        valid_from: datetime,
        valid_until: Optional[datetime] = None,
        properties: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Create relationship with temporal validity.

        Use when: recording a fact that has a known start time and
        may expire (e.g., employment, address, subscription status).
        """
        edge_id: str = super().create_relationship(
            source_id, rel_type, target_id, properties
        )

        # Add temporal properties
        self.edges[edge_id]["valid_from"] = valid_from.isoformat()
        self.edges[edge_id]["valid_until"] = (
            valid_until.isoformat() if valid_until else None
        )

        return edge_id

    def query_at_time(
        self, query: Dict[str, Any], query_time: datetime
    ) -> List[Dict[str, Any]]:
        """Query graph state at specific time.

        Use when: answering point-in-time questions about entities
        (e.g., "what was true on date X?").
        """
        results: List[Dict[str, Any]] = []

        # Get base query results
        base_results: List[Dict[str, Any]] = self.query(query)

        for result in base_results:
            edge: Dict[str, Any] = result["edge"]
            valid_from: datetime = datetime.fromisoformat(
                edge.get("valid_from", "1970-01-01")
            )
            valid_until: Optional[str] = edge.get("valid_until")

            # Check temporal validity
            if valid_from <= query_time:
                if valid_until is None or datetime.fromisoformat(valid_until) > query_time:
                    results.append(
                        {
                            **result,
                            "valid_from": valid_from,
                            "valid_until": valid_until,
                        }
                    )

        return results

    def query_time_range(
        self,
        query: Dict[str, Any],
        start_time: datetime,
        end_time: datetime,
    ) -> List[Dict[str, Any]]:
        """Query facts valid during time range.

        Use when: retrieving all facts that overlap with a given time
        window (e.g., "what changed between January and June?").
        """
        results: List[Dict[str, Any]] = []

        base_results: List[Dict[str, Any]] = self.query(query)

        for result in base_results:
            edge: Dict[str, Any] = result["edge"]
            valid_from: datetime = datetime.fromisoformat(
                edge.get("valid_from", "1970-01-01")
            )
            valid_until: Optional[str] = edge.get("valid_until")

            # Check if overlaps with query range
            until_dt: datetime = (
                datetime.fromisoformat(valid_until) if valid_until else datetime.max
            )

            if until_dt >= start_time and valid_from <= end_time:
                results.append(
                    {
                        **result,
                        "valid_from": valid_from,
                        "valid_until": valid_until,
                    }
                )

        return results


# ---------------------------------------------------------------------------
# Memory System Integration
# ---------------------------------------------------------------------------


class IntegratedMemorySystem:
    """Integrated memory system combining vector store and graph.

    Use when: the agent needs both semantic search over facts and
    graph-based entity relationship traversal in a single unified
    interface. This class composes VectorStore and TemporalKnowledgeGraph,
    enriching vector search results with graph context.
    """

    def __init__(self) -> None:
        self.vector_store: VectorStore = VectorStore()
        self.graph: TemporalKnowledgeGraph = TemporalKnowledgeGraph()
        self.session_id: str = ""

    def start_session(self, session_id: str) -> None:
        """Start a new memory session.

        Use when: beginning a new conversation or task that should
        scope its memories to a distinct session identifier.
        """
        self.session_id = session_id

    def store_fact(
        self,
        fact: str,
        entity: str,
        timestamp: Optional[datetime] = None,
        relationships: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        """Store a fact with entity and relationships.

        Use when: the agent observes a new piece of information that
        should be persisted for future retrieval. Stores in both the
        vector store (for semantic search) and the graph (for entity
        traversal).
        """
        # Store in vector store
        self.vector_store.add(
            fact,
            {
                "text": fact,
                "entity": entity,
                "valid_from": (timestamp or datetime.now()).isoformat(),
                "session_id": self.session_id,
            },
        )

        # Get or create entity node (uses registry for identity)
        entity_node_id: str = self.graph.get_or_create_node(entity)

        # Create relationships
        if relationships:
            for rel in relationships:
                target_node_id: str = self.graph.get_or_create_node(rel["target"])
                self.graph.create_relationship(
                    entity_node_id,
                    rel["type"],
                    target_node_id,
                    properties=rel.get("properties", {}),
                )

    def retrieve_memories(
        self,
        query: str,
        entity_filter: Optional[str] = None,
        time_filter: Optional[Dict[str, Any]] = None,
        limit: int = 5,
    ) -> List[Dict[str, Any]]:
        """Retrieve memories matching query.

        Use when: the agent needs to recall previously stored facts,
        optionally filtered by entity or time. Results are enriched
        with graph relationships for each matched entity.
        """
        # Vector search
        filters: Dict[str, Any] = {"session_id": self.session_id}
        if entity_filter:
            filters["entity"] = entity_filter

        results: List[Dict[str, Any]] = self.vector_store.search(
            query, limit=limit, filters=filters
        )

        # Enrich with graph relationships
        for result in results:
            entity: Optional[str] = result["metadata"].get("entity")
            if entity:
                node_id: Optional[str] = self.graph.entity_registry.get(entity)
                if node_id:
                    result["relationships"] = self.graph.get_relationships(node_id)

        return results

    def retrieve_entity_context(self, entity: str) -> Dict[str, Any]:
        """Retrieve complete context for an entity.

        Use when: the agent needs a full picture of a single entity
        including its properties, all relationships, and associated
        vector memories.
        """
        node_id: Optional[str] = self.graph.entity_registry.get(entity)

        # Get entity node
        entity_node: Optional[Dict[str, Any]] = (
            self.graph.get_node(node_id) if node_id else None
        )

        # Get relationships
        relationships: List[Dict[str, Any]] = (
            self.graph.get_relationships(node_id) if node_id else []
        )

        # Get vector memories
        memories: List[Dict[str, Any]] = self.vector_store.search_by_entity(
            entity, limit=10
        )

        return {
            "entity": entity_node,
            "relationships": relationships,
            "memories": memories,
        }

    def consolidate(self) -> None:
        """Consolidate memories and remove outdated information.

        Use when: memory count exceeds a threshold, retrieval quality
        degrades, or on a scheduled interval. In production, implement:
        - Merge related facts into summaries
        - Update validity periods on stale entries
        - Archive obsolete facts (invalidate, do not discard)
        """
        pass


if __name__ == "__main__":
    # Quick smoke test demonstrating the integrated memory system.
    mem = IntegratedMemorySystem()
    mem.start_session("demo-session")

    # Store facts with entity relationships
    mem.store_fact(
        "Alice prefers dark mode",
        entity="Alice",
        relationships=[{"target": "dark mode", "type": "PREFERS"}],
    )
    mem.store_fact(
        "Alice works at Acme Corp",
        entity="Alice",
        relationships=[{"target": "Acme Corp", "type": "WORKS_AT"}],
    )

    # Semantic retrieval
    results = mem.retrieve_memories("theme preference")
    print(f"Search results: {len(results)} memories found")
    for r in results:
        print(f"  score={r['score']:.3f}  text={r['text']}")

    # Entity context
    context = mem.retrieve_entity_context("Alice")
    print(f"\nAlice context: {len(context['relationships'])} relationships, "
          f"{len(context['memories'])} memories")
