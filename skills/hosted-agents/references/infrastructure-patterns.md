# Infrastructure Patterns for Hosted Agents

This reference provides detailed implementation patterns for building hosted agent infrastructure. These patterns are derived from production systems at scale.

## Sandbox Architecture

### Modal Integration Pattern

Modal provides the sandbox infrastructure with near-instant startup and filesystem snapshots.

```python
import modal

# Define the base image with all dependencies
image = modal.Image.debian_slim().pip_install([
    "opencode",
    "gitpython",
    "psycopg2-binary",
])

# Create the app
app = modal.App("coding-agent")

# Sandbox class with snapshot support
@app.cls(image=image, timeout=3600)
class AgentSandbox:
    def __init__(self, repo_url: str, snapshot_id: str = None):
        self.repo_url = repo_url
        self.snapshot_id = snapshot_id
    
    @modal.enter()
    def setup(self):
        if self.snapshot_id:
            # Restore from snapshot
            modal.Sandbox.restore(self.snapshot_id)
        else:
            # Fresh setup from image
            self._clone_and_setup()
    
    def _clone_and_setup(self):
        """Clone repo and run initial setup."""
        token = self._get_github_app_token()
        os.system(f"git clone https://x-access-token:{token}@github.com/{self.repo_url}")
        os.system("npm install")
        os.system("npm run build")
    
    @modal.method()
    def execute_prompt(self, prompt: str, user_identity: dict) -> dict:
        """Execute a prompt in the sandbox."""
        # Update git config for this user
        os.system(f'git config user.name "{user_identity["name"]}"')
        os.system(f'git config user.email "{user_identity["email"]}"')
        
        # Run the agent
        result = self.agent.run(prompt)
        
        return {
            "result": result,
            "snapshot_id": modal.Sandbox.snapshot()
        }
```

### Image Build Pipeline

Build images on a schedule to keep them fresh:

```python
import schedule
import time
from datetime import datetime

class ImageBuilder:
    def __init__(self, repositories: list[str]):
        self.repositories = repositories
        self.images = {}
    
    def build_all_images(self):
        """Build images for all repositories."""
        for repo in self.repositories:
            try:
                image = self._build_image(repo)
                self.images[repo] = {
                    "image": image,
                    "built_at": datetime.utcnow(),
                    "commit": self._get_latest_commit(repo)
                }
            except Exception as e:
                # Log but continue with other repos
                log.error(f"Failed to build image for {repo}: {e}")
    
    def _build_image(self, repo: str) -> str:
        """Build a single repository image."""
        sandbox = modal.Sandbox.create()
        
        # Clone with app token
        token = get_app_installation_token(repo)
        sandbox.exec(f"git clone https://x-access-token:{token}@github.com/{repo} /workspace")
        
        # Install dependencies
        sandbox.exec("cd /workspace && npm install")
        
        # Run build
        sandbox.exec("cd /workspace && npm run build")
        
        # Warm caches
        sandbox.exec("cd /workspace && npm run dev &")
        time.sleep(5)  # Let dev server start
        sandbox.exec("cd /workspace && npm test -- --run")
        
        # Create snapshot
        return sandbox.snapshot()
    
    def get_latest_image(self, repo: str) -> str:
        """Get the most recent image for a repository."""
        if repo not in self.images:
            raise ValueError(f"No image available for {repo}")
        return self.images[repo]["image"]

# Schedule builds every 30 minutes
builder = ImageBuilder(["org/frontend", "org/backend", "org/shared"])
schedule.every(30).minutes.do(builder.build_all_images)
```

### Warm Pool Management

Maintain pre-warmed sandboxes for instant session starts:

```python
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta

@dataclass
class WarmSandbox:
    sandbox_id: str
    repo: str
    created_at: datetime
    image_version: str
    is_claimed: bool = False

class WarmPoolManager:
    def __init__(self, target_pool_size: int = 3):
        self.target_size = target_pool_size
        self.pools = defaultdict(list)  # repo -> [WarmSandbox]
        self.max_age = timedelta(minutes=25)  # Expire before next image build
    
    def get_warm_sandbox(self, repo: str) -> WarmSandbox | None:
        """Get a pre-warmed sandbox if available."""
        pool = self.pools[repo]
        
        for sandbox in pool:
            if not sandbox.is_claimed and self._is_valid(sandbox):
                sandbox.is_claimed = True
                return sandbox
        
        return None
    
    def _is_valid(self, sandbox: WarmSandbox) -> bool:
        """Check if sandbox is still valid."""
        age = datetime.utcnow() - sandbox.created_at
        current_image = self.image_builder.get_latest_image(sandbox.repo)
        
        return (
            age < self.max_age and
            sandbox.image_version == current_image
        )
    
    def maintain_pool(self, repo: str):
        """Ensure pool has target number of warm sandboxes."""
        # Remove expired sandboxes
        self.pools[repo] = [s for s in self.pools[repo] if self._is_valid(s)]
        
        # Add new sandboxes to reach target
        current_count = len([s for s in self.pools[repo] if not s.is_claimed])
        needed = self.target_size - current_count
        
        for _ in range(needed):
            sandbox = self._create_warm_sandbox(repo)
            self.pools[repo].append(sandbox)
    
    def _create_warm_sandbox(self, repo: str) -> WarmSandbox:
        """Create a new warm sandbox from latest image."""
        image = self.image_builder.get_latest_image(repo)
        sandbox_id = modal.Sandbox.create(image=image)
        
        # Sync to latest (runs in background)
        self._sync_to_latest(sandbox_id, repo)
        
        return WarmSandbox(
            sandbox_id=sandbox_id,
            repo=repo,
            created_at=datetime.utcnow(),
            image_version=image
        )
```

## API Layer Patterns

### Cloudflare Durable Objects for Session State

Each session gets its own Durable Object with isolated SQLite:

```typescript
// Session Durable Object
export class SessionDO implements DurableObject {
  private storage: DurableObjectStorage;
  private sql: SqlStorage;
  private connections: Map<string, WebSocket> = new Map();

  constructor(ctx: DurableObjectState) {
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.initializeSchema();
  }

  private initializeSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        path TEXT,
        content TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        data TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    switch (url.pathname) {
      case "/message":
        return this.handleMessage(request);
      case "/status":
        return this.getStatus();
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  private handleWebSocket(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const connectionId = crypto.randomUUID();
    this.connections.set(connectionId, server);

    server.accept();
    server.addEventListener("close", () => {
      this.connections.delete(connectionId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(message: object) {
    const data = JSON.stringify(message);
    for (const ws of this.connections.values()) {
      ws.send(data);
    }
  }

  async handleMessage(request: Request): Promise<Response> {
    const { content, author } = await request.json();

    // Store message
    this.sql.exec(
      `INSERT INTO messages (role, content, author_id, author_name) VALUES (?, ?, ?, ?)`,
      ["user", content, author.id, author.name]
    );

    // Broadcast to all connected clients
    this.broadcast({
      type: "message",
      role: "user",
      content,
      author,
    });

    // Forward to sandbox for processing
    const result = await this.forwardToSandbox(content, author);

    return Response.json(result);
  }
}
```

### Real-Time Event Streaming

Stream events from sandbox to all connected clients:

```typescript
class EventStream {
  private sessionDO: DurableObjectStub;

  async streamFromSandbox(sandboxId: string, sessionId: string) {
    const sandbox = await modal.Sandbox.get(sandboxId);

    // Subscribe to sandbox events
    for await (const event of sandbox.events()) {
      // Forward to Durable Object for broadcast
      await this.sessionDO.fetch(
        new Request(`https://internal/event`, {
          method: "POST",
          body: JSON.stringify({
            type: event.type,
            data: event.data,
          }),
        })
      );
    }
  }
}
```

## Client Integration Patterns

### Slack Bot with Repository Classification

```python
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

app = App(token=os.environ["SLACK_BOT_TOKEN"])

# Repository descriptions for classification
REPO_DESCRIPTIONS = [
    {
        "name": "frontend-monorepo",
        "description": "React frontend application with dashboard, user portal, and admin interfaces",
        "hints": ["dashboard", "UI", "component", "page", "frontend"]
    },
    {
        "name": "backend-services",
        "description": "Node.js API services including auth, payments, and core business logic",
        "hints": ["API", "endpoint", "service", "backend", "database"]
    },
    {
        "name": "mobile-app",
        "description": "React Native mobile application for iOS and Android",
        "hints": ["mobile", "app", "iOS", "Android", "native"]
    }
]

async def classify_repository(message: str, channel: str, thread: list[str]) -> str:
    """Use fast model to classify which repo the message refers to."""
    prompt = f"""Classify which repository this message is about.

Message: {message}
Channel: #{channel}
Thread context: {' | '.join(thread[-3:])}

Repositories:
{json.dumps(REPO_DESCRIPTIONS, indent=2)}

Return ONLY the repository name, or "unknown" if unclear."""

    response = await openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=50
    )
    
    return response.choices[0].message.content.strip()

@app.event("app_mention")
async def handle_mention(event, say, client):
    """Handle @mentions of the bot."""
    channel = event["channel"]
    message = event["text"]
    thread_ts = event.get("thread_ts", event["ts"])
    
    # Get thread context if in a thread
    thread_messages = []
    if "thread_ts" in event:
        result = await client.conversations_replies(
            channel=channel,
            ts=thread_ts
        )
        thread_messages = [m["text"] for m in result["messages"]]
    
    # Get channel info for context
    channel_info = await client.conversations_info(channel=channel)
    channel_name = channel_info["channel"]["name"]
    
    # Classify repository
    repo = await classify_repository(message, channel_name, thread_messages)
    
    if repo == "unknown":
        await say(
            text="I'm not sure which repository you're referring to. Could you specify?",
            thread_ts=thread_ts
        )
        return
    
    # Start session and process
    session = await start_session(repo, event["user"])
    
    await say(
        text=f":robot_face: Starting work in `{repo}`...",
        thread_ts=thread_ts
    )
    
    result = await session.process(message)
    
    # Post result with Block Kit formatting
    await say(
        blocks=format_result_blocks(result),
        thread_ts=thread_ts
    )
```

### Chrome Extension DOM Extraction

Extract DOM structure instead of sending screenshots:

```typescript
// content-script.ts
interface ElementInfo {
  tag: string;
  classes: string[];
  id?: string;
  text?: string;
  rect: DOMRect;
  reactComponent?: string;
}

function extractDOMInfo(element: Element): ElementInfo {
  // Get React component name if available
  let reactComponent: string | undefined;
  const fiberKey = Object.keys(element).find((key) =>
    key.startsWith("__reactFiber")
  );
  if (fiberKey) {
    const fiber = (element as any)[fiberKey];
    reactComponent = fiber?.type?.name || fiber?.type?.displayName;
  }

  return {
    tag: element.tagName.toLowerCase(),
    classes: Array.from(element.classList),
    id: element.id || undefined,
    text: element.textContent?.slice(0, 100),
    rect: element.getBoundingClientRect(),
    reactComponent,
  };
}

function extractSelectedArea(selection: DOMRect): ElementInfo[] {
  const elements: ElementInfo[] = [];

  // Find all elements within selection bounds
  document.querySelectorAll("*").forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (
      rect.top >= selection.top &&
      rect.left >= selection.left &&
      rect.bottom <= selection.bottom &&
      rect.right <= selection.right
    ) {
      elements.push(extractDOMInfo(el));
    }
  });

  return elements;
}

// Message handler for sidebar
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "EXTRACT_SELECTION") {
    const elements = extractSelectedArea(request.selection);
    sendResponse({ elements });
  }
});
```

## Multiplayer Implementation

### Authorship Tracking

Track which user made each change:

```python
@dataclass
class PromptContext:
    content: str
    author: Author
    session_id: str
    timestamp: datetime

@dataclass
class Author:
    id: str
    name: str
    email: str
    github_token: str  # For PR creation

class MultiplayerSession:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.participants: dict[str, Author] = {}
        self.prompt_queue: list[PromptContext] = []
    
    def add_participant(self, author: Author):
        """Add a participant to the session."""
        self.participants[author.id] = author
        self.broadcast_event("participant_joined", author)
    
    async def process_prompt(self, prompt: PromptContext):
        """Process prompt with author attribution."""
        # Update git config for this author
        await self.sandbox.exec(
            f'git config user.name "{prompt.author.name}"'
        )
        await self.sandbox.exec(
            f'git config user.email "{prompt.author.email}"'
        )
        
        # Run agent
        result = await self.agent.run(prompt.content)
        
        # If changes were made, create PR with author's token
        if result.has_changes:
            await self.create_pr(
                branch=result.branch,
                author=prompt.author
            )
        
        return result
    
    async def create_pr(self, branch: str, author: Author):
        """Create PR using the author's GitHub token."""
        async with aiohttp.ClientSession() as session:
            headers = {
                "Authorization": f"Bearer {author.github_token}",
                "Accept": "application/vnd.github.v3+json"
            }
            
            await session.post(
                f"https://api.github.com/repos/{self.repo}/pulls",
                headers=headers,
                json={
                    "title": self.generate_pr_title(),
                    "body": self.generate_pr_body(),
                    "head": branch,
                    "base": "main"
                }
            )
```

## Metrics and Monitoring

### Key Metrics to Track

```python
from dataclasses import dataclass
from datetime import datetime, timedelta

@dataclass
class SessionMetrics:
    session_id: str
    started_at: datetime
    first_token_at: datetime | None
    completed_at: datetime | None
    pr_created: bool
    pr_merged: bool
    prompts_count: int
    participants_count: int
    
    @property
    def time_to_first_token(self) -> timedelta | None:
        if self.first_token_at:
            return self.first_token_at - self.started_at
        return None

class MetricsAggregator:
    def get_adoption_metrics(self, period: timedelta) -> dict:
        """Get adoption metrics for a time period."""
        sessions = self.get_sessions_in_period(period)
        
        total_prs = sum(1 for s in sessions if s.pr_created)
        merged_prs = sum(1 for s in sessions if s.pr_merged)
        
        return {
            "total_sessions": len(sessions),
            "prs_created": total_prs,
            "prs_merged": merged_prs,
            "merge_rate": merged_prs / total_prs if total_prs > 0 else 0,
            "avg_time_to_first_token": self._avg_ttft(sessions),
            "unique_users": len(set(s.author_id for s in sessions)),
            "multiplayer_sessions": sum(
                1 for s in sessions if s.participants_count > 1
            )
        }
    
    def get_repository_metrics(self) -> dict[str, dict]:
        """Get metrics broken down by repository."""
        metrics = {}
        
        for repo in self.repositories:
            repo_sessions = self.get_sessions_for_repo(repo)
            total_prs = self.get_total_prs(repo)
            agent_prs = sum(1 for s in repo_sessions if s.pr_merged)
            
            metrics[repo] = {
                "agent_pr_percentage": agent_prs / total_prs * 100,
                "session_count": len(repo_sessions),
                "avg_prompts_per_session": sum(
                    s.prompts_count for s in repo_sessions
                ) / len(repo_sessions)
            }
        
        return metrics
```

## Security Considerations

### Sandbox Isolation

```python
class SandboxSecurityConfig:
    """Security configuration for sandboxes."""
    
    # Network restrictions
    allowed_hosts = [
        "github.com",
        "api.github.com",
        "registry.npmjs.org",
        "pypi.org",
    ]
    
    # Resource limits
    max_memory_mb = 4096
    max_cpu_cores = 2
    max_disk_gb = 10
    max_runtime_hours = 4
    
    # Secrets handling
    secrets_to_inject = [
        "GITHUB_APP_TOKEN",
        "NPM_TOKEN",
    ]
    
    # Blocked operations
    blocked_commands = [
        "curl",  # Use fetch tools instead
        "wget",
        "ssh",
    ]
```

### Token Handling

```python
class TokenManager:
    """Manage tokens for GitHub operations."""
    
    def get_app_installation_token(self, repo: str) -> str:
        """Get short-lived token for repo access."""
        # Token expires in 1 hour
        return github_app.create_installation_token(
            installation_id=self.get_installation_id(repo),
            permissions={"contents": "write", "pull_requests": "write"}
        )
    
    def get_user_token(self, user_id: str) -> str:
        """Get user's OAuth token for PR creation."""
        # Stored encrypted, decrypted at runtime
        encrypted = self.storage.get(f"user_token:{user_id}")
        return self.decrypt(encrypted)
```

## References

- [Modal Documentation](https://modal.com/docs)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/)
- [GitHub Apps Authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [Slack Bolt for Python](https://slack.dev/bolt-python/)
- [Chrome Extension APIs](https://developer.chrome.com/docs/extensions/)
