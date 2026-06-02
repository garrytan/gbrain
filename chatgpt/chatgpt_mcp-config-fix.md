---
title: "MCP config fix"
type: note
created: 2025-12-31
updated: 2025-12-31
source: chatgpt-export
conversation_id: 6954aefb-d588-8330-8cbe-cc8c9dae805c
message_count: 2
tags: [chatgpt, import, code]
---
# MCP config fix

**Related:** [[coding_troubleshoot]]

> Conversation ID: 6954aefb-d588-8330-8cbe-cc8c9dae805c
> Created: 2025-12-31T05:05:04Z
> Updated: 2025-12-31T05:07:37Z
> Messages: 2

---

## User

FIX THIS MCP CONFIG

{
  "mcpServers": {
    "linear-mcp-server": {
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.linear.app/sse"
      ],
      "command": "npx",
      "disabled": false,
      "env": {}
    },
    "mcp-playwright": {
      "args": [
        "-y",
        "@playwright/mcp@latest"
      ],
      "command": "npx",
      "env": {}
    },
    "mcp-server-neon": {
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.neon.tech/sse"
      ],
      "command": "npx",
      "disabled": false,
      "env": {}
    },
    "puppeteer": {
      "args": [
        "-y",
        "@modelcontextprotocol/server-puppeteer"
      ],
      "command": "npx",
      "disabled": false,
      "env": {}
    },
    "sonarqube": {
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "SONARQUBE_TOKEN",
        "-e",
        "SONARQUBE_ORG",
        "-e",
        "SONARQUBE_CLOUD_URL",
        "-e",
        "SONARQUBE_IDE_PORT",
        "mcp/sonarqube"
      ],
      "command": "docker",
      "env": {
        "SONARQUBE_CLOUD_URL": "https://sonarcloud.io",
        "SONARQUBE_IDE_PORT": "64120",
        "SONARQUBE_ORG": "jovieinc",
        "SONARQUBE_TOKEN": "c470514b4429aa9a0ed1dd9afcc1ecdad238efff"
      }
    },
    "statsig": {
      "args": [
        "mcp-remote",
        "https://api.statsig.com/v1/mcp",
        "--header",
        "statsig-api-key:${AUTH_TOKEN}"
      ],
      "command": "npx",
      "disabled": false,
      "env": {
        "AUTH_TOKEN": "console-CdyF0KNNvR4U78KCeGAfQJeZaYLJsd9CAAGYLLtWjfh"
      }
    },
    "stripe": {
      "args": [
        "-y",
        "@stripe/mcp",
        "--tools=all",
        "--api-key=sk_test_51Se29rAAI1NrDqJSZiTSy7gXos6LjIAXH8CqDL2T9HEtpEmIKCjAeemNeiq0JSXDlqtXjr7JVy3rSpVW3QEMbWmO00OTzaX2R5"
      ],
      "command": "npx",
      "disabled": false,
      "env": {}
    },
    "vercel": {
      "disabledTools": [],
      "serverUrl": "https://mcp.vercel.com"
    }
  }
}

---

## Assistant

Mr. White — **you’ve got multiple leaked secrets in this file** (Sonar token, Stripe secret key, Statsig token). **Rotate/revoke them now** and don’t commit keys into `mcp.json`. (Stripe explicitly recommends restricted keys for agents.) citeturn11search0

Here’s a **fixed + safer** config (same servers, but:
- uses `--yes` consistently for `npx`
- pins `mcp-remote@latest`
- switches **Statsig** to the official remote URL (OAuth; no header/key needed) citeturn10view0
- moves secrets to env placeholders

```json
{
  "mcpServers": {
    "linear-mcp-server": {
      "command": "npx",
      "args": ["--yes", "mcp-remote@latest", "https://mcp.linear.app/sse"],
      "disabled": false,
      "env": {}
    },

    "mcp-playwright": {
      "command": "npx",
      "args": ["--yes", "@playwright/mcp@latest"],
      "disabled": false,
      "env": {}
    },

    "mcp-server-neon": {
      "command": "npx",
      "args": ["--yes", "mcp-remote@latest", "https://mcp.neon.tech/sse"],
      "disabled": false,
      "env": {}
    },

    "puppeteer": {
      "command": "npx",
      "args": ["--yes", "@modelcontextprotocol/server-puppeteer@latest"],
      "disabled": false,
      "env": {}
    },

    "sonarqube": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "SONARQUBE_TOKEN",
        "-e",
        "SONARQUBE_ORG",
        "-e",
        "SONARQUBE_CLOUD_URL",
        "-e",
        "SONARQUBE_IDE_PORT",
        "mcp/sonarqube"
      ],
      "disabled": false,
      "env": {
        "SONARQUBE_CLOUD_URL": "https://sonarcloud.io",
        "SONARQUBE_IDE_PORT": "64120",
        "SONARQUBE_ORG": "jovieinc",
        "SONARQUBE_TOKEN": "${SONARQUBE_TOKEN}"
      }
    },

    "statsig": {
      "serverUrl": "https://api.statsig.com/v1/mcp",
      "disabled": false
    },

    "stripe": {
      "command": "npx",
      "args": ["--yes", "@stripe/mcp", "--tools=all"],
      "disabled": false,
      "env": {
        "STRIPE_SECRET_KEY": "${STRIPE_SECRET_KEY}"
      }
    },

    "vercel": {
      "serverUrl": "https://mcp.vercel.com",
      "disabled": false,
      "disabledTools": []
    }
  }
}
```

Notes:
- **Statsig**: the recommended Cursor-style config is just the URL; OAuth is handled on first connect. citeturn10view0  
- **Vercel endpoint** is `https://mcp.vercel.com`. citeturn5search6turn5search2  
- **Stripe**: set `STRIPE_SECRET_KEY` via environment; avoid baking keys into args/files. citeturn11search13turn11search0  

If your MCP host prefers `url` instead of `serverUrl`, change those two fields (`statsig`, `vercel`) to `url` (everything else stays the same).


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
