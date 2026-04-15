> **DEPRECATED:** See [google-tools-mcp](../../recipes/google-tools-mcp.md) for
> the recommended Google Workspace setup.

# Credential Gateway (ClawVisor / Hermes)


Three integrations that make the agent real. Without these, the brain is a static
database. With them, it's alive.

### 14a. Credential Gateway (ClawVisor / Hermes Gateway)

The EA workflow needs Gmail, Calendar, Contacts, and messaging access. The agent
should never hold API keys directly. Use a credential gateway that enforces policies
and injects credentials at request time.

**OpenClaw: ClawVisor.** [ClawVisor](https://clawvisor.com) is a credential vaulting
and authorization gateway with task-scoped authorization.

**Services:** Gmail (list, read, send, draft), Google Calendar (CRUD), Google Drive
(list, search, read), Google Contacts (list, search), Apple iMessage (list, read,
search, send), GitHub, Slack.

**Task-scoped authorization:** Every request must include a `task_id` from an approved
standing task. Tasks declare: purpose (verbose, 2-3 sentences), authorized actions with
expected use patterns, auto-execute flag, lifetime (standing vs ephemeral).

**Why this matters for GBrain:** The EA workflow needs Gmail (sender lookup before
triage), Calendar (meeting prep, attendee pages), Contacts (enrichment trigger), and
iMessage (direct instructions). ClawVisor gives the agent access without giving it
raw credentials.

**Setup:**

1. Create agent in ClawVisor dashboard, copy agent token
2. Set `CLAWVISOR_URL` and `CLAWVISOR_AGENT_TOKEN` in env
3. Activate services (Google, iMessage, etc.) in the dashboard
4. Create standing tasks with expansive scopes (narrow purposes cause false blocks)
5. Store standing task IDs in agent memory for reuse

**Critical scoping rule:** Be expansive in task purposes. "Full executive assistant
email management including inbox triage, searching by any criteria, reading emails,
tracking threads" works. "Email triage" gets rejected. The intent verification model
uses the purpose to judge whether each request is consistent -- if your purpose is
narrow, legitimate requests fail verification.

**Hermes Agent: Built-in gateway.** Hermes has multi-platform messaging (Telegram,
Discord, Slack, WhatsApp, Signal, Email) and tool access built into its gateway. Use
`config.yaml` to configure API credentials. The gateway daemon manages connections
and routes webhooks to agent sessions. For Google services, configure OAuth credentials
in the gateway config. Hermes's scheduled automations can run the same EA workflows
(email triage, calendar prep, contact enrichment) through the gateway's tool system.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md). See also: [Getting Data In](README.md)*
