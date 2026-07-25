---
kind: external_dependency
name: Model Context Protocol (MCP) SDK
slug: modelcontextprotocol-sdk
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### MCP SDK
- 角色：gbrain 通过 MCP 协议向 Claude Code、Cursor、ChatGPT、Perplexity、Cowork 等客户端暴露 30+ 工具。
- 服务端：`@modelcontextprotocol/sdk/server/index.js` + `StreamableHTTPServerTransport`，Express 5 HTTP MCP 服务器含 OAuth 2.1、admin dashboard、SSE 活动流。
- 客户端：`@modelcontextprotocol/sdk/client/index.js` + `StreamableHTTPClientTransport`，用于 thin-client 模式和 connect probe。
- 认证：OAuth 2.1 with PKCE（ChatGPT 强制），Bearer Token（Claude Code/Cursor），DCR 风格客户端注册，scope-gated 访问（read/write/admin）。