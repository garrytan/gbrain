# Connect MBrain to ChatGPT

**Status: Coming Soon**

ChatGPT requires OAuth 2.1 with Dynamic Client Registration for MCP connectors.
Bearer token authentication is not supported by ChatGPT's MCP integration.

MBrain now has the required HTTP transport foundation through
`mbrain serve --http`, but ChatGPT connection still needs OAuth 2.1 on top of
that transport.

## What's needed

- OAuth 2.1 authorization endpoint on the self-hosted HTTP MCP server
- Token endpoint with PKCE flow
- Dynamic Client Registration support
- ChatGPT Developer Mode (available on Pro/Team/Enterprise/Edu plans)

## Workaround

Until OAuth support ships, you can use MBrain with ChatGPT via a bridge:

1. Run `mbrain serve --http` locally or behind a tunnel
2. Use a tool like [mcp-remote](https://github.com/nichochar/mcp-remote) or a
   small OAuth proxy that can front an existing HTTP MCP server

## Timeline

Follow the [repository issue tracker](https://github.com/meghendra6/mbrain/issues) for updates on ChatGPT OAuth support.
