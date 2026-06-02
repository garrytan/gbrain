---
conversation_id: 68b89605-12b0-8321-b2e2-b5045bdd2852
created: 2025-09-03
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Github MCP Docker requirement
type: note
updated: 2025-09-03
---

# Github MCP Docker requirement

> Conversation ID: 68b89605-12b0-8321-b2e2-b5045bdd2852
> Created: 2025-09-03T19:25:04Z
> Updated: 2025-09-03T19:25:21Z
> Messages: 2

---

## User

Why does github mcp in windsurf require docker

---

## Assistant

Windsurf’s GitHub MCP (Model Context Protocol) integration needs **Docker** because the MCP server for GitHub is packaged and distributed as a container image.  

Here’s why:  

### 1. **Isolation & Dependencies**
The GitHub MCP server has its own runtime environment, dependencies, and network access requirements. Docker ensures it runs in a consistent sandbox without polluting your local machine or conflicting with other tools.

### 2. **Security**
MCP servers often need sensitive tokens (e.g., GitHub PAT). Running them in a container isolates access and makes it easier to enforce strict permission boundaries.

### 3. **Portability**
The Docker image guarantees the same MCP server will run identically across macOS, Linux, and Windows. Without Docker, you’d need to manually install the right runtime (Node, Bun, or Rust depending on the MCP server).

### 4. **Windsurf’s Design**
Windsurf treats MCP servers as micro-services. Docker is the “lowest common denominator” way to run them locally with minimal setup—just pull and run the container, no manual build/install required.

---

⚡ In short: Docker is used because MCP servers like `github-mcp` are distributed as containers for **ease of setup, consistency, and isolation**.  

Would you like me to walk you through running `github-mcp` without Docker (building from source), or are you mainly trying to understand why Windsurf forces Docker?


**Topic:** [[chatgpt-clusters/coding_devops]]
