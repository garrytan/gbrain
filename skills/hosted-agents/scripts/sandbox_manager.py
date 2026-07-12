"""
Sandbox Manager for Hosted Agent Infrastructure.

Use when: building background coding agents that need sandboxed execution
environments with pre-built images, warm pools, and session snapshots.

This module provides composable building blocks for sandbox lifecycle
management. Each class handles one concern (image building, warm pools,
session coordination) and can be used independently or combined via
SandboxManager.

Note: This is pseudocode demonstrating architectural patterns.
Adapt for your specific infrastructure (Modal, Fly.io, etc.).
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional, Callable, Any
from enum import Enum
import asyncio

__all__ = [
    "SandboxState",
    "UserIdentity",
    "SandboxConfig",
    "Sandbox",
    "RepositoryImage",
    "ImageBuilder",
    "WarmSandbox",
    "WarmPoolManager",
    "SandboxManager",
    "AgentSession",
]


class SandboxState(Enum):
    """Sandbox lifecycle states."""
    CREATING = "creating"
    SYNCING = "syncing"
    READY = "ready"
    EXECUTING = "executing"
    SNAPSHOTTING = "snapshotting"
    TERMINATED = "terminated"


@dataclass
class UserIdentity:
    """User identity for commit attribution.

    Use when: configuring sandbox git identity so commits are
    attributed to the prompting user, not the app.
    """
    id: str
    name: str
    email: str
    github_token: str


@dataclass
class SandboxConfig:
    """Configuration for sandbox creation.

    Use when: defining resource limits and timeouts for a new sandbox
    to prevent cost runaway and resource exhaustion.
    """
    repo_url: str
    base_image: str
    memory_mb: int = 4096
    cpu_cores: int = 2
    disk_gb: int = 10
    timeout_hours: int = 4


@dataclass
class Sandbox:
    """Represents a sandboxed execution environment.

    Use when: interacting with a running sandbox to execute commands,
    read/write files, or take snapshots for session continuity.
    """
    id: str
    config: SandboxConfig
    state: SandboxState
    created_at: datetime
    snapshot_id: Optional[str] = None
    current_user: Optional[UserIdentity] = None

    # Event handlers
    on_state_change: Optional[Callable[[SandboxState], None]] = None

    async def execute_command(self, command: str) -> dict[str, Any]:
        """Execute a command in the sandbox.

        Use when: running shell commands (git, build tools, tests)
        inside the isolated environment.

        Returns:
            dict with keys "stdout", "stderr", "exit_code".
        """
        # Implementation depends on infrastructure
        pass

    async def read_file(self, path: str) -> str:
        """Read a file from the sandbox filesystem.

        Use when: agent needs to inspect source code or config files.
        Safe to call before git sync completes.
        """
        pass

    async def write_file(self, path: str, content: str) -> None:
        """Write a file to the sandbox filesystem.

        Use when: agent needs to modify source code. Block this
        until git sync completes to avoid write conflicts.
        """
        pass

    async def snapshot(self) -> str:
        """Create a snapshot of current filesystem state.

        Use when: preserving session state before sandbox termination
        so follow-up prompts can restore instantly.
        """
        self.state = SandboxState.SNAPSHOTTING
        snapshot_id = await self._create_snapshot()
        self.snapshot_id = snapshot_id
        self.state = SandboxState.READY
        return snapshot_id

    async def _create_snapshot(self) -> str:
        """Create snapshot (infrastructure-specific)."""
        pass

    async def restore(self, snapshot_id: str) -> None:
        """Restore sandbox to a previous snapshot."""
        pass

    async def terminate(self) -> None:
        """Terminate the sandbox."""
        self.state = SandboxState.TERMINATED


@dataclass
class RepositoryImage:
    """Pre-built image for a repository.

    Use when: checking whether a cached environment image exists
    and whether it is recent enough to use.
    """
    repo_url: str
    image_id: str
    commit_sha: str
    built_at: datetime

    def is_stale(self, max_age: timedelta = timedelta(minutes=30)) -> bool:
        """Check if image is older than max age."""
        return datetime.utcnow() - self.built_at > max_age


class ImageBuilder:
    """Builds and manages repository images.

    Use when: setting up the periodic image build loop that
    pre-bakes development environments for fast sandbox spin-up.
    """

    def __init__(self, github_app_token_provider: Callable[[], str]) -> None:
        self.token_provider = github_app_token_provider
        self.images: dict[str, RepositoryImage] = {}

    async def build_image(self, repo_url: str) -> RepositoryImage:
        """Build a new image for a repository.

        Use when: the current image is stale or no image exists yet.
        Runs clone, dependency install, build, and cache warming.
        """
        print(f"Building image for {repo_url}...")

        # Get fresh token for clone
        token = self.token_provider()

        # These operations run in build environment
        build_steps: list[str] = [
            # Clone repository
            f"git clone https://x-access-token:{token}@github.com/{repo_url} /workspace",

            # Install dependencies
            "cd /workspace && npm install",

            # Run build
            "cd /workspace && npm run build",

            # Warm caches by running once
            "cd /workspace && npm run dev &",
            "sleep 5",  # Let dev server start
            "cd /workspace && npm test -- --run || true",  # Run tests to warm cache
        ]

        # Execute build steps (infrastructure-specific)
        for step in build_steps:
            await self._execute_build_step(step)

        # Get current commit
        commit_sha: str = await self._get_commit_sha()

        # Create and store image
        image = RepositoryImage(
            repo_url=repo_url,
            image_id=await self._finalize_image(),
            commit_sha=commit_sha,
            built_at=datetime.utcnow()
        )

        self.images[repo_url] = image
        return image

    def get_latest_image(self, repo_url: str) -> Optional[RepositoryImage]:
        """Get the most recent image for a repository."""
        return self.images.get(repo_url)

    async def _execute_build_step(self, command: str) -> None:
        """Execute a build step (infrastructure-specific)."""
        pass

    async def _get_commit_sha(self) -> str:
        """Get current HEAD commit SHA."""
        pass

    async def _finalize_image(self) -> str:
        """Finalize and store the image, return image ID."""
        pass


@dataclass
class WarmSandbox:
    """A pre-warmed sandbox ready for use.

    Use when: tracking warm pool inventory and claiming a sandbox
    for an incoming user session.
    """
    sandbox: Sandbox
    repo_url: str
    created_at: datetime
    image_version: str
    is_claimed: bool = False
    sync_complete: bool = False


class WarmPoolManager:
    """Manages pools of pre-warmed sandboxes.

    Use when: reducing cold start latency by maintaining ready-to-use
    sandboxes that are pre-synced to the latest code.
    """

    def __init__(
        self,
        image_builder: ImageBuilder,
        target_pool_size: int = 3,
        max_age: timedelta = timedelta(minutes=25)
    ) -> None:
        self.image_builder = image_builder
        self.target_size = target_pool_size
        self.max_age = max_age
        self.pools: dict[str, list[WarmSandbox]] = {}

    async def get_warm_sandbox(self, repo_url: str) -> Optional[WarmSandbox]:
        """Get a pre-warmed sandbox if available.

        Use when: a user submits a prompt and needs a sandbox immediately.
        Returns None if no valid warm sandbox is available.
        """
        if repo_url not in self.pools:
            return None

        for warm in self.pools[repo_url]:
            if not warm.is_claimed and self._is_valid(warm):
                warm.is_claimed = True
                return warm

        return None

    def _is_valid(self, warm: WarmSandbox) -> bool:
        """Check if a warm sandbox is still valid."""
        age: timedelta = datetime.utcnow() - warm.created_at
        if age > self.max_age:
            return False

        # Check if image is still current
        current = self.image_builder.get_latest_image(warm.repo_url)
        if not current or current.image_id != warm.image_version:
            return False

        return True

    async def maintain_pool(self, repo_url: str) -> None:
        """Ensure pool has target number of warm sandboxes.

        Use when: called periodically or after an image rebuild to
        keep the warm pool populated.
        """
        if repo_url not in self.pools:
            self.pools[repo_url] = []

        # Remove invalid sandboxes
        valid: list[WarmSandbox] = [w for w in self.pools[repo_url] if self._is_valid(w)]
        self.pools[repo_url] = valid

        # Count available (unclaimed) sandboxes
        available: int = len([w for w in valid if not w.is_claimed])
        needed: int = self.target_size - available

        # Create new warm sandboxes
        for _ in range(max(0, needed)):
            warm = await self._create_warm_sandbox(repo_url)
            self.pools[repo_url].append(warm)

    async def _create_warm_sandbox(self, repo_url: str) -> WarmSandbox:
        """Create a new warm sandbox."""
        image: Optional[RepositoryImage] = self.image_builder.get_latest_image(repo_url)
        if not image:
            raise ValueError(f"No image available for {repo_url}")

        # Create sandbox from image
        sandbox: Sandbox = await self._create_sandbox_from_image(image)

        warm = WarmSandbox(
            sandbox=sandbox,
            repo_url=repo_url,
            created_at=datetime.utcnow(),
            image_version=image.image_id,
            sync_complete=False
        )

        # Start syncing to latest in background
        asyncio.create_task(self._sync_to_latest(warm))

        return warm

    async def _sync_to_latest(self, warm: WarmSandbox) -> None:
        """Sync sandbox to latest commit on base branch."""
        await warm.sandbox.execute_command("git fetch origin main")
        await warm.sandbox.execute_command("git reset --hard origin/main")
        warm.sync_complete = True

    async def _create_sandbox_from_image(self, image: RepositoryImage) -> Sandbox:
        """Create a sandbox from an image (infrastructure-specific)."""
        pass


class SandboxManager:
    """Main manager for sandbox lifecycle.

    Use when: orchestrating the full sandbox lifecycle including
    image building, warm pools, and session management. This is the
    top-level entry point that composes ImageBuilder and WarmPoolManager.
    """

    def __init__(
        self,
        repositories: list[str],
        github_app_token_provider: Callable[[], str],
        build_interval: timedelta = timedelta(minutes=30)
    ) -> None:
        self.repositories = repositories
        self.image_builder = ImageBuilder(github_app_token_provider)
        self.warm_pool = WarmPoolManager(self.image_builder)
        self.build_interval = build_interval
        self.active_sessions: dict[str, Sandbox] = {}

    async def start_build_loop(self) -> None:
        """Start the background image build loop.

        Use when: initializing the system. Runs indefinitely, rebuilding
        images every build_interval to keep environments fresh.
        """
        while True:
            for repo in self.repositories:
                try:
                    await self.image_builder.build_image(repo)
                    await self.warm_pool.maintain_pool(repo)
                except Exception as e:
                    print(f"Failed to build {repo}: {e}")

            await asyncio.sleep(self.build_interval.total_seconds())

    async def start_session(
        self,
        repo_url: str,
        user: UserIdentity,
        snapshot_id: Optional[str] = None
    ) -> Sandbox:
        """Start a new session for a user.

        Use when: a user submits a prompt. Tries warm pool first,
        then snapshot restore, then cold start as fallback.
        """
        # Try to get from warm pool first
        warm: Optional[WarmSandbox] = await self.warm_pool.get_warm_sandbox(repo_url)

        if warm:
            sandbox = warm.sandbox
            # Wait for sync if not complete
            if not warm.sync_complete:
                await self._wait_for_sync(warm)
        elif snapshot_id:
            # Restore from previous session snapshot
            sandbox = await self._restore_from_snapshot(snapshot_id)
        else:
            # Cold start from latest image
            sandbox = await self._cold_start(repo_url)

        # Configure for user
        await self._configure_for_user(sandbox, user)

        # Track session
        session_id: str = f"{user.id}_{datetime.utcnow().isoformat()}"
        self.active_sessions[session_id] = sandbox

        return sandbox

    async def on_user_typing(self, user: UserIdentity, repo_url: str) -> None:
        """Called when user starts typing a prompt.

        Use when: implementing predictive warm-up. Starts preparing a
        sandbox so it is ready by the time the user submits.
        """
        warm: Optional[WarmSandbox] = await self.warm_pool.get_warm_sandbox(repo_url)

        if not warm:
            # Start warming one now
            asyncio.create_task(self.warm_pool.maintain_pool(repo_url))

    async def end_session(self, session_id: str) -> Optional[str]:
        """End a session and return snapshot ID for potential follow-up.

        Use when: a session completes. Always snapshots before termination
        to prevent state loss.
        """
        if session_id not in self.active_sessions:
            return None

        sandbox: Sandbox = self.active_sessions[session_id]

        # Create snapshot before terminating
        snapshot_id: str = await sandbox.snapshot()

        # Terminate sandbox
        await sandbox.terminate()

        del self.active_sessions[session_id]

        return snapshot_id

    async def _configure_for_user(
        self,
        sandbox: Sandbox,
        user: UserIdentity
    ) -> None:
        """Configure sandbox for a specific user."""
        sandbox.current_user = user

        # Set git identity
        await sandbox.execute_command(
            f'git config user.name "{user.name}"'
        )
        await sandbox.execute_command(
            f'git config user.email "{user.email}"'
        )

    async def _wait_for_sync(self, warm: WarmSandbox) -> None:
        """Wait for sync to complete."""
        while not warm.sync_complete:
            await asyncio.sleep(0.1)

    async def _restore_from_snapshot(self, snapshot_id: str) -> Sandbox:
        """Restore a sandbox from a snapshot."""
        pass

    async def _cold_start(self, repo_url: str) -> Sandbox:
        """Start a sandbox from cold (no warm pool available)."""
        pass


class AgentSession:
    """Agent session with file read/write coordination.

    Use when: wrapping a Sandbox to enforce the pattern where reads
    are allowed before sync completes but writes are blocked until
    sync finishes, preventing write conflicts.
    """

    def __init__(self, sandbox: Sandbox) -> None:
        self.sandbox = sandbox
        self.sync_complete: bool = False
        self.pending_writes: list[tuple[str, str]] = []

    async def read_file(self, path: str) -> str:
        """Read a file -- allowed even before sync completes.

        Use when: agent needs to research code immediately. Safe because
        in large repos, files being worked on are unlikely to have
        changed in the last 30 minutes since image build.
        """
        return await self.sandbox.read_file(path)

    async def write_file(self, path: str, content: str) -> None:
        """Write a file -- blocks until sync is complete.

        Use when: agent needs to modify source code. Queues the write
        and waits for git sync to finish to prevent conflicts.
        """
        if not self.sync_complete:
            # Queue the write
            self.pending_writes.append((path, content))
            await self._wait_for_sync()

        await self.sandbox.write_file(path, content)

    def mark_sync_complete(self) -> None:
        """Called when git sync is complete."""
        self.sync_complete = True

    async def _wait_for_sync(self) -> None:
        """Wait for sync to complete, then flush pending writes."""
        while not self.sync_complete:
            await asyncio.sleep(0.1)

        # Flush pending writes
        for path, content in self.pending_writes:
            await self.sandbox.write_file(path, content)
        self.pending_writes.clear()


if __name__ == "__main__":
    async def _demo() -> None:
        """Demonstrate sandbox manager usage end-to-end."""

        def get_github_token() -> str:
            """Get GitHub App installation token."""
            # Implementation: call GitHub API to get installation token
            return "ghs_xxxx"

        # Initialize manager with target repositories
        manager = SandboxManager(
            repositories=[
                "myorg/frontend",
                "myorg/backend",
                "myorg/shared-libs"
            ],
            github_app_token_provider=get_github_token
        )

        # Start background build loop
        asyncio.create_task(manager.start_build_loop())

        # Simulate user session
        user = UserIdentity(
            id="user123",
            name="Alice Developer",
            email="alice@example.com",
            github_token="gho_user_token"
        )

        # User starts typing -- predictively warm a sandbox
        await manager.on_user_typing(user, "myorg/frontend")

        # User submits prompt -- get sandbox
        sandbox: Sandbox = await manager.start_session("myorg/frontend", user)

        # Create session wrapper for read/write coordination
        session = AgentSession(sandbox)

        # Agent can read immediately (before sync completes)
        readme: str = await session.read_file("/workspace/README.md")

        # Agent work happens here...

        # End session and get snapshot for follow-up
        # Find the session_id that was generated during start_session
        active_ids = list(manager.active_sessions.keys())
        if active_ids:
            session_id = active_ids[0]
            snapshot_id: Optional[str] = await manager.end_session(session_id)
            print(f"Session ended, snapshot: {snapshot_id}")
        else:
            print("No active session found")

    asyncio.run(_demo())
