# Multi-Agent Patterns: Technical Reference

This document provides implementation details for multi-agent architectures across different frameworks.

## Supervisor Pattern

### LangGraph Supervisor Implementation

Implement a supervisor that routes to worker nodes:

```python
from typing import TypedDict, Union
from langgraph.graph import StateGraph, END

class AgentState(TypedDict):
    task: str
    current_agent: str
    task_output: dict
    messages: list

def supervisor_node(state: AgentState) -> AgentState:
    """
    Supervisor decides which worker to invoke next.
    
    Returns routing decision and updates state.
    """
    task = state["task"]
    messages = state.get("messages", [])
    
    # Determine next agent based on task and history
    if "research" in task.lower():
        next_agent = "researcher"
    elif "write" in task.lower() or "create" in task.lower():
        next_agent = "writer"
    elif "review" in task.lower() or "analyze" in task.lower():
        next_agent = "reviewer"
    else:
        next_agent = "coordinator"
    
    return {
        "task": task,
        "current_agent": next_agent,
        "task_output": {},
        "messages": messages + [{"supervisor": f"Routing to {next_agent}"}]
    }

def researcher_node(state: AgentState) -> AgentState:
    """Research worker that gathers information."""
    # Perform research task
    output = perform_research(state["task"])
    
    return {
        "task": state["task"],
        "current_agent": "researcher",
        "task_output": output,
        "messages": state["messages"] + [{"researcher": "Research complete"}]
    }

def writer_node(state: AgentState) -> AgentState:
    """Writer worker that creates content based on research."""
    output = create_content(state["task"], state["task_output"])
    
    return {
        "task": state["task"],
        "current_agent": "writer",
        "task_output": output,
        "messages": state["messages"] + [{"writer": "Content created"}]
    }

def build_supervisor_graph():
    """Build the supervisor workflow graph."""
    workflow = StateGraph(AgentState)
    
    # Add nodes
    workflow.add_node("supervisor", supervisor_node)
    workflow.add_node("researcher", researcher_node)
    workflow.add_node("writer", writer_node)
    
    # Add edges
    workflow.add_edge("supervisor", "researcher")
    workflow.add_edge("researcher", "supervisor")
    workflow.add_edge("supervisor", "writer")
    workflow.add_edge("writer", "supervisor")
    
    # Set entry point
    workflow.set_entry_point("supervisor")
    
    return workflow.compile()
```

### AutoGen Supervisor

Implement supervisor using GroupChat pattern:

```python
from autogen import AssistantAgent, UserProxyAgent, GroupChat

# Define specialized agents
researcher = AssistantAgent(
    name="researcher",
    system_message="""You are a research specialist.
    Your goal is to gather accurate, comprehensive information
    on topics assigned by the supervisor. Always cite sources
    and note confidence levels.""",
    llm_config=llm_config
)

writer = AssistantAgent(
    name="writer",
    system_message="""You are a content creation specialist.
    Your goal is to create well-structured content based on
    research provided by the supervisor. Follow style guidelines
    and ensure factual accuracy.""",
    llm_config=llm_config
)

# Define supervisor
supervisor = AssistantAgent(
    name="supervisor",
    system_message="""You are the project supervisor.
    Your goal is to coordinate researchers and writers to
    complete tasks efficiently.
    
    Process:
    1. Break down the task into research and writing phases
    2. Route to appropriate specialists
    3. Synthesize results into final output
    4. Ensure quality before completing""",
    llm_config=llm_config
)

# Configure group chat
group_chat = GroupChat(
    agents=[supervisor, researcher, writer],
    messages=[],
    max_round=20
)

manager = GroupChatManager(
    groupchat=group_chat,
    llm_config=llm_config
)
```

## Swarm Pattern Implementation

### LangGraph Swarms

Implement peer-to-peer handoffs:

```python
def create_agent(name, system_prompt, tools):
    """Create an agent node for the swarm."""
    
    def agent_node(state):
        # Process current state with agent
        response = invoke_agent(name, system_prompt, state["input"], tools)
        
        # Check for handoff
        if "handoff" in response:
            return {"next_agent": response["handoff"], "output": response["output"]}
        else:
            return {"next_agent": END, "output": response["output"]}
    
    return agent_node

def build_swarm():
    """Build a peer-to-peer agent swarm."""
    workflow = StateGraph(State)
    
    # Create agents
    triage = create_agent("triage", TRIAGE_PROMPT, [search, read])
    research = create_agent("research", RESEARCH_PROMPT, [search, browse, read])
    analysis = create_agent("analysis", ANALYSIS_PROMPT, [calculate, compare])
    writing = create_agent("writing", WRITING_PROMPT, [write, edit])
    
    # Add to graph
    workflow.add_node("triage", triage)
    workflow.add_node("research", research)
    workflow.add_node("analysis", analysis)
    workflow.add_node("writing", writing)
    
    # Define handoff edges
    workflow.add_edge("triage", "research")
    workflow.add_edge("triage", "analysis")
    workflow.add_edge("research", "writing")
    workflow.add_edge("analysis", "writing")
    
    workflow.set_entry_point("triage")
    
    return workflow.compile()
```

## Hierarchical Pattern Implementation

### CrewAI-Style Hierarchy

```python
class ManagerAgent:
    def __init__(self, name, system_prompt, llm):
        self.name = name
        self.system_prompt = system_prompt
        self.llm = llm
        self.workers = []
    
    def add_worker(self, worker):
        """Add a worker agent to the team."""
        self.workers.append(worker)
    
    def delegate(self, task):
        """
        Analyze task and delegate to appropriate worker.
        
        Returns work assignment and expected output format.
        """
        # Analyze task requirements
        requirements = analyze_task_requirements(task)
        
        # Select best worker
        best_worker = select_worker(self.workers, requirements)
        
        # Create assignment
        assignment = {
            "worker": best_worker.name,
            "task": task,
            "context": self.get_relevant_context(task),
            "output_format": requirements.output_format,
            "deadline": requirements.deadline
        }
        
        return assignment
    
    def review_output(self, worker_output, requirements):
        """
        Review worker output against requirements.
        
        Returns approval or revision request.
        """
        quality_score = assess_quality(worker_output, requirements)
        
        if quality_score >= requirements.threshold:
            return {"status": "approved", "output": worker_output}
        else:
            return {
                "status": "revision_requested",
                "feedback": generate_feedback(worker_output, requirements),
                "revise_worker": requirements.revise_worker
            }
```

## Context Isolation Patterns

### Full Context Delegation

```python
def delegate_with_full_context(planner_state, subagent):
    """
    Pass entire planner context to subagent.
    
    Use for complex tasks requiring complete understanding.
    """
    return {
        "context": planner_state,
        "subagent": subagent,
        "isolation_mode": "full"
    }
```

### Instruction Passing

```python
def delegate_with_instructions(task_spec, subagent):
    """
    Pass only instructions to subagent.
    
    Use for simple, well-defined subtasks.
    """
    return {
        "instructions": {
            "objective": task_spec.objective,
            "constraints": task_spec.constraints,
            "inputs": task_spec.inputs,
            "outputs": task_spec.output_schema
        },
        "subagent": subagent,
        "isolation_mode": "minimal"
    }
```

### File System Coordination

```python
class FileSystemCoordination:
    def __init__(self, workspace_path):
        self.workspace = workspace_path
    
    def write_shared_state(self, key, value):
        """Write state accessible to all agents."""
        path = f"{self.workspace}/{key}.json"
        with open(path, 'w') as f:
            json.dump(value, f)
        return path
    
    def read_shared_state(self, key):
        """Read state written by any agent."""
        path = f"{self.workspace}/{key}.json"
        with open(path, 'r') as f:
            return json.load(f)
    
    def acquire_lock(self, resource, agent_id):
        """Prevent concurrent access to shared resources."""
        lock_path = f"{self.workspace}/locks/{resource}.lock"
        if os.path.exists(lock_path):
            return False
        with open(lock_path, 'w') as f:
            f.write(agent_id)
        return True
```

## Consensus Mechanisms

### Weighted Voting

```python
def weighted_consensus(agent_outputs, weights):
    """
    Calculate weighted consensus from agent outputs.
    
    Weight = verbalized_confidence * domain_expertise
    """
    weighted_sum = sum(
        output.vote * weights[output.agent_id]
        for output in agent_outputs
    )
    total_weight = sum(weights[output.agent_id] for output in agent_outputs)
    
    return weighted_sum / total_weight
```

### Debate Protocol

```python
class DebateProtocol:
    def __init__(self, agents, max_rounds=5):
        self.agents = agents
        self.max_rounds = max_rounds
        self.history = []
    
    def run_debate(self, topic):
        """Execute structured debate on topic."""
        # Initial statements
        statements = {agent.name: agent.initial_statement(topic) 
                      for agent in self.agents}
        
        for round_num in range(self.max_rounds):
            # Generate critiques
            critiques = {}
            for agent in self.agents:
                critiques[agent.name] = agent.critique(
                    topic, 
                    statements,
                    exclude=[agent.name]
                )
            
            # Update statements with critique integration
            for agent in self.agents:
                statements[agent.name] = agent.integrate_critique(
                    statements[agent.name],
                    critiques
                )
            
            # Check for convergence
            if self.check_convergence(statements):
                break
        
        # Final evaluation
        return self.evaluate_final(statements)
```

## Failure Recovery

### Circuit Breaker

```python
class AgentCircuitBreaker:
    def __init__(self, failure_threshold=3, timeout_seconds=60):
        self.failure_count = {}
        self.failure_threshold = failure_threshold
        self.timeout_seconds = timeout_seconds
    
    def call(self, agent, task):
        """Execute agent task with circuit breaker protection."""
        if self.is_open(agent.name):
            raise CircuitBreakerOpen(f"Agent {agent.name} temporarily unavailable")
        
        try:
            result = agent.execute(task)
            self.record_success(agent.name)
            return result
        except Exception as e:
            self.record_failure(agent.name)
            if self.failure_count[agent.name] >= self.failure_threshold:
                self.open_circuit(agent.name)
            raise
```

### Checkpoint and Resume

```python
class CheckpointManager:
    def __init__(self, checkpoint_dir):
        self.checkpoint_dir = checkpoint_dir
        os.makedirs(checkpoint_dir, exist_ok=True)
    
    def save_checkpoint(self, workflow_id, step, state):
        """Save workflow state for potential resume."""
        checkpoint = {
            "workflow_id": workflow_id,
            "step": step,
            "state": state,
            "timestamp": time.time()
        }
        path = f"{self.checkpoint_dir}/{workflow_id}.json"
        with open(path, 'w') as f:
            json.dump(checkpoint, f)
    
    def load_checkpoint(self, workflow_id):
        """Load last saved checkpoint for workflow."""
        path = f"{self.checkpoint_dir}/{workflow_id}.json"
        with open(path, 'r') as f:
            return json.load(f)
```

