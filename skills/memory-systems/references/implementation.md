# Memory Systems: Technical Reference

This document provides implementation details for memory system components.

## Vector Store Implementation

### Basic Vector Store

```python
import numpy as np
from typing import List, Dict, Any
import json


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


class VectorStore:
    def __init__(self, dimension=768):
        self.dimension = dimension
        self.vectors = []
        self.metadata = []
        self.texts = []

    def add(self, text: str, metadata: Dict[str, Any] = None):
        """Add document to store."""
        embedding = self._embed(text)
        self.vectors.append(embedding)
        self.metadata.append(metadata or {})
        self.texts.append(text)
        return len(self.vectors) - 1
    
    def search(self, query: str, limit: int = 5, 
               filters: Dict[str, Any] = None) -> List[Dict]:
        """Search for similar documents."""
        query_embedding = self._embed(query)
        
        scores = []
        for i, vec in enumerate(self.vectors):
            score = cosine_similarity(query_embedding, vec)
            
            # Apply filters
            if filters and not self._matches_filters(self.metadata[i], filters):
                score = -1  # Exclude
            
            scores.append((i, score))
        
        # Sort by score
        scores.sort(key=lambda x: x[1], reverse=True)
        
        # Return top k
        results = []
        for idx, score in scores[:limit]:
            if score > 0:  # Only include positive matches
                results.append({
                    "index": idx,
                    "score": score,
                    "text": self._get_text(idx),
                    "metadata": self.metadata[idx]
                })
        
        return results
    
    def _embed(self, text: str) -> np.ndarray:
        """Generate deterministic pseudo-embedding for demonstration.
        In production, replace with actual embedding model."""
        np.random.seed(hash(text) % (2**32))
        vec = np.random.randn(self.dimension)
        return vec / (np.linalg.norm(vec) + 1e-8)
    
    def _matches_filters(self, metadata: Dict, filters: Dict) -> bool:
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
    
    def _get_text(self, index: int) -> str:
        """Retrieve original text for index."""
        return self.texts[index] if index < len(self.texts) else ""
```

### Metadata-Enhanced Vector Store

```python
class MetadataVectorStore(VectorStore):
    def __init__(self, dimension=768):
        super().__init__(dimension)
        self.entity_index = {}  # entity -> [indices]
        self.time_index = {}    # time_range -> [indices]
    
    def add(self, text: str, metadata: Dict[str, Any] = None):
        """Add with enhanced indexing."""
        metadata = metadata or {}
        index = super().add(text, metadata)

        # Index by entity
        if "entity" in metadata:
            entity = metadata["entity"]
            if entity not in self.entity_index:
                self.entity_index[entity] = []
            self.entity_index[entity].append(index)
        
        # Index by time
        if "valid_from" in metadata:
            time_key = self._time_range_key(
                metadata.get("valid_from"),
                metadata.get("valid_until")
            )
            if time_key not in self.time_index:
                self.time_index[time_key] = []
            self.time_index[time_key].append(index)
        
        return index
    
    def search_by_entity(self, query: str, entity: str, limit: int = 5) -> List[Dict]:
        """Search within specific entity."""
        indices = self.entity_index.get(entity, [])
        filtered = [self.metadata[i] for i in indices]
        
        # Score and rank
        query_embedding = self._embed(query)
        scored = []
        for i, meta in zip(indices, filtered):
            vec = self.vectors[i]
            score = cosine_similarity(query_embedding, vec)
            scored.append((i, score, meta))
        
        scored.sort(key=lambda x: x[1], reverse=True)
        
        return [{
            "index": idx,
            "score": score,
            "metadata": meta
        } for idx, score, meta in scored[:limit]]
```

## Knowledge Graph Implementation

### Property Graph Storage

```python
from typing import Dict, List, Optional
import uuid

class PropertyGraph:
    def __init__(self):
        self.nodes = {}  # id -> properties
        self.edges = []  # list of edge dicts
        self.entity_registry = {}  # name -> node_id (maintains identity)
        self.indexes = {
            "node_label": {},  # label -> [node_ids]
            "edge_type": {}    # type -> [edge_ids]
        }

    def get_or_create_node(self, name: str, label: str, properties: Dict = None) -> str:
        """Get existing node by name, or create a new one.
        Uses entity_registry to ensure identity across interactions."""
        if name in self.entity_registry:
            return self.entity_registry[name]
        node_id = self.create_node(label, {**(properties or {}), "name": name})
        self.entity_registry[name] = node_id
        return node_id

    def create_node(self, label: str, properties: Dict = None) -> str:
        """Create node with label and properties."""
        node_id = str(uuid.uuid4())
        self.nodes[node_id] = {
            "label": label,
            "properties": properties or {}
        }

        # Index by label
        if label not in self.indexes["node_label"]:
            self.indexes["node_label"][label] = []
        self.indexes["node_label"][label].append(node_id)

        return node_id
    
    def create_relationship(self, source_id: str, rel_type: str, 
                           target_id: str, properties: Dict = None) -> str:
        """Create directed relationship between nodes."""
        edge_id = str(uuid.uuid4())
        self.edges.append({
            "id": edge_id,
            "source": source_id,
            "target": target_id,
            "type": rel_type,
            "properties": properties or {}
        })
        
        # Index by type
        if rel_type not in self.indexes["edge_type"]:
            self.indexes["edge_type"][rel_type] = []
        self.indexes["edge_type"][rel_type].append(edge_id)
        
        return edge_id
    
    def query(self, cypher_like: str, params: Dict = None) -> List[Dict]:
        """
        Simple query matching.
        
        Supports patterns like:
        MATCH (e)-[r]->(o) WHERE e.id = $id RETURN r
        """
        # In production, use actual graph database
        # This is a simplified pattern matcher
        results = []
        
        if cypher_like.startswith("MATCH"):
            # Parse basic pattern
            pattern = self._parse_pattern(cypher_like)
            results = self._match_pattern(pattern, params or {})
        
        return results
    
    def _parse_pattern(self, query: str) -> Dict:
        """Parse simplified MATCH pattern."""
        # Simplified parser for demonstration
        return {
            "source_label": self._extract_label(query, "source"),
            "rel_type": self._extract_type(query),
            "target_label": self._extract_label(query, "target"),
            "where": self._extract_where(query)
        }
    
    def _match_pattern(self, pattern: Dict, params: Dict) -> List[Dict]:
        """Match pattern against graph."""
        results = []
        
        for edge in self.edges:
            # Match relationship type
            if pattern["rel_type"] and edge["type"] != pattern["rel_type"]:
                continue
            
            source = self.nodes.get(edge["source"], {})
            target = self.nodes.get(edge["target"], {})
            
            # Match labels
            if pattern["source_label"] and source.get("label") != pattern["source_label"]:
                continue
            if pattern["target_label"] and target.get("label") != pattern["target_label"]:
                continue
            
            # Match where clause
            if pattern["where"] and not self._match_where(edge, source, target, params):
                continue
            
            results.append({
                "source": source,
                "relationship": edge,
                "target": target
            })
        
        return results
```

## Temporal Knowledge Graph

```python
from datetime import datetime
from typing import Optional

class TemporalKnowledgeGraph(PropertyGraph):
    def __init__(self):
        super().__init__()
        self.temporal_index = {}  # time_range -> [edge_ids]
    
    def create_temporal_relationship(
        self, 
        source_id: str, 
        rel_type: str, 
        target_id: str,
        valid_from: datetime,
        valid_until: Optional[datetime] = None,
        properties: Dict = None
    ) -> str:
        """Create relationship with temporal validity."""
        edge_id = super().create_relationship(
            source_id, rel_type, target_id, properties
        )
        
        # Index temporally
        time_key = self._time_range_key(valid_from, valid_until)
        if time_key not in self.temporal_index:
            self.temporal_index[time_key] = []
        self.temporal_index[time_key].append(edge_id)
        
        # Store validity on edge
        edge = self._get_edge(edge_id)
        edge["valid_from"] = valid_from.isoformat()
        edge["valid_until"] = valid_until.isoformat() if valid_until else None
        
        return edge_id
    
    def query_at_time(self, query: str, query_time: datetime) -> List[Dict]:
        """Query graph state at specific time."""
        # Find edges valid at query time
        valid_edges = []
        for edge in self.edges:
            valid_from = datetime.fromisoformat(edge.get("valid_from", "1970-01-01"))
            valid_until = edge.get("valid_until")
            
            if valid_from <= query_time:
                if valid_until is None or datetime.fromisoformat(valid_until) > query_time:
                    valid_edges.append(edge)
        
        # Match against pattern
        pattern = self._parse_pattern(query)
        results = []
        
        for edge in valid_edges:
            if pattern["rel_type"] and edge["type"] != pattern["rel_type"]:
                continue
            
            source = self.nodes.get(edge["source"], {})
            target = self.nodes.get(edge["target"], {})
            
            results.append({
                "source": source,
                "relationship": edge,
                "target": target
            })
        
        return results
    
    def _time_range_key(self, start: datetime, end: Optional[datetime]) -> str:
        """Create time range key for indexing."""
        start_str = start.isoformat()
        end_str = end.isoformat() if end else "infinity"
        return f"{start_str}::{end_str}"
```

## Memory Consolidation

```python
class MemoryConsolidator:
    def __init__(self, graph: PropertyGraph, vector_store: VectorStore):
        self.graph = graph
        self.vector_store = vector_store
        self.consolidation_threshold = 1000  # memories before consolidation
    
    def should_consolidate(self) -> bool:
        """Check if consolidation should trigger."""
        total_memories = len(self.graph.nodes) + len(self.graph.edges)
        return total_memories > self.consolidation_threshold
    
    def consolidate(self):
        """Run consolidation process."""
        # Step 1: Identify duplicate or merged facts
        duplicates = self.find_duplicates()
        
        # Step 2: Merge related facts
        for group in duplicates:
            self.merge_fact_group(group)
        
        # Step 3: Update validity periods
        self.update_validity_periods()
        
        # Step 4: Rebuild indexes
        self.rebuild_indexes()
    
    def find_duplicates(self) -> List[List]:
        """Find groups of potentially duplicate facts."""
        # Group by subject and predicate
        groups = {}
        
        for edge in self.graph.edges:
            key = (edge["source"], edge["type"])
            if key not in groups:
                groups[key] = []
            groups[key].append(edge)
        
        # Return groups with multiple edges
        return [edges for edges in groups.values() if len(edges) > 1]
    
    def merge_fact_group(self, edges: List[Dict]):
        """Merge group of duplicate edges."""
        if len(edges) == 1:
            return
        
        # Keep most recent/relevant
        keeper = max(edges, key=lambda e: e.get("properties", {}).get("confidence", 0))
        
        # Merge metadata
        for edge in edges:
            if edge["id"] != keeper["id"]:
                self.merge_properties(keeper, edge)
                self.graph.edges.remove(edge)
    
    def merge_properties(self, target: Dict, source: Dict):
        """Merge properties from source into target."""
        for key, value in source.get("properties", {}).items():
            if key not in target["properties"]:
                target["properties"][key] = value
            elif isinstance(value, list):
                target["properties"][key].extend(value)
```

## Memory-Context Integration

```python
class MemoryContextIntegrator:
    def __init__(self, memory_system, context_limit=100000):
        self.memory_system = memory_system
        self.context_limit = context_limit
    
    def build_context(self, task: str, current_context: str = "") -> str:
        """Build context including relevant memories."""
        # Extract entities from task
        entities = self._extract_entities(task)
        
        # Retrieve memories for each entity
        memories = []
        for entity in entities:
            entity_memories = self.memory_system.retrieve_entity(entity)
            memories.extend(entity_memories)
        
        # Format memories for context
        memory_section = self._format_memories(memories)
        
        # Combine with current context
        combined = current_context + "\n\n" + memory_section
        
        # Check limit and truncate if needed
        if self._token_count(combined) > self.context_limit:
            combined = self._truncate_context(combined, self.context_limit)
        
        return combined
    
    def _extract_entities(self, task: str) -> List[str]:
        """Extract entity mentions from task."""
        # In production, use NER or entity extraction
        import re
        pattern = r"\[([^\]]+)\]"  # [[entity_name]] convention
        return re.findall(pattern, task)
    
    def _format_memories(self, memories: List[Dict]) -> str:
        """Format memories for context injection."""
        sections = ["## Relevant Memories"]
        
        for memory in memories:
            formatted = f"- {memory.get('content', '')}"
            if "source" in memory:
                formatted += f" (Source: {memory['source']})"
            if "timestamp" in memory:
                formatted += f" [Time: {memory['timestamp']}]"
            sections.append(formatted)
        
        return "\n".join(sections)
    
    def _token_count(self, text: str) -> int:
        """Estimate token count."""
        return len(text) // 4  # Rough approximation
    
    def _truncate_context(self, context: str, limit: int) -> str:
        """Truncate context to fit limit."""
        tokens = context.split()
        truncated = []
        count = 0

        for token in tokens:
            if count + 1 > limit:
                break
            truncated.append(token)
            count += 1

        return " ".join(truncated)
```

## Framework Integration Examples

### Mem0 Quick Start

```python
from mem0 import Memory

# Initialize with default config (uses local storage)
m = Memory()

# Store memories with user scoping
m.add("Prefers Python 3.12 with type hints", user_id="dev-alice")
m.add("Working on microservices migration", user_id="dev-alice")

# Search with natural language
results = m.search("What language does the user prefer?", user_id="dev-alice")

# Batch operations
m.add([
    "Sprint goal: complete auth service",
    "Blocked on database schema review"
], user_id="dev-alice")
```

### Graphiti (Zep's Open-Source Temporal KG Engine)

```python
from graphiti_core import Graphiti
from graphiti_core.nodes import EpisodeType

# Initialize with Neo4j backend
graphiti = Graphiti("bolt://localhost:7687", "neo4j", "password")

# Add episodes (conversations, events)
await graphiti.add_episode(
    name="user_conversation_42",
    episode_body="Alice mentioned she moved to Berlin in January.",
    source=EpisodeType.message,
    source_description="Chat with Alice"
)

# Search combines semantic, keyword, and graph traversal
results = await graphiti.search("Where does Alice live?")
```

### Cognee (Open-Source Knowledge Engine for AI Memory)

```python
import cognee
from cognee.modules.search.types import SearchType

# ECL pipeline: add → cognify → memify → search
await cognee.add("./docs/")
await cognee.add("any-data")
await cognee.cognify()
await cognee.memify()

# Graph-aware retrieval (default: GRAPH_COMPLETION)
results = await cognee.search(
    query_text="any query to search in memory",
    query_type=SearchType.GRAPH_COMPLETION,
)

# Raw chunks when agent reasons over text itself
chunks = await cognee.search(
    query_text="any query to search in memory",
    query_type=SearchType.CHUNKS,
)
```

