Optimizes AppFunction KDoc for AI agents and Model Context Protocol.

## Instructions

### Workflow: Agent-Centric Documentation

1. **Identify the Core Outcome** : Start the description with a strong, imperative verb (e.g., "Search", "Create", "Update"). Focus on the *user
   benefit*, not the code implementation.
2. **Workflow Dependencies** : Explicitly state if another function must be called first using the standard phrase: **Required workflow: Call "Function
   A" first to "Objective"**.
3. **Parameter Documentation** :
   - For **Functions** : Use specific `@param` tags. Isolate validation rules and default values here.
   - For **Serializables** : Use inline KDoc directly for each property declarations. KSP will **not** extract documentation from class-level tags.
4. **Error Surface Mapping** : Rewrite `@throws` descriptions to provide actionable recovery steps for the AI agent (e.g., "If "Error", suggest the user check their internet connection").

### Workflow: Global App Description (Server Instructions)

When writing the `appfn:description` for `app_metadata.xml`, follow these
instructions:

1. **Capture Cross-Function Relationships**: Explain dependencies or sequences between tools (e.g., "Always call 'authenticate' before fetching data").
2. **Document Operational Patterns**: Guide the LLM on token conserving usage (e.g., "Use 'batch_update' over multiple 'update' calls").
3. **Specify Constraints**: Define clear boundaries (e.g., "File operations limited to workspace", "Rate limit: 10 req/min").
4. **Anti-Patterns** :
   - DON'T repeat individual function descriptions.
   - DON'T include marketing claims or subjective praise.
   - DON'T attempt to prompt model personality or conversation style.

## Critical Constraints

### Descriptive, Not Imperative

Describe what the function *does* , not what the LLM *must* do. Avoid phrases
like "You must call this..." in favor of "This function provides...".

### No "Fluff"

Remove conversational padding like "This method is used to..." or "Helpful
for...". Be concise and technical.

### Inline KDoc for Serializables

**MANDATORY** : For `@AppFunctionSerializable` classes, documentation MUST be
inline For each property. KSP ignores class-level `@param` or `@property` tags
for these classes.

## Examples

### Example: MCP Refactoring

**Original**:

`/** This function helps you find people. */`

**Refined**:

    /**
      * Search for message recipients by name or email.
      * Required workflow: Call this before "sendMessage" to obtain valid recipient IDs.
      * @param query Search string for name/email. If null, returns 3 most recent contacts.
      * @return List of "Recipient" objects matching the query.
      */

### Example: Global App Description

**Refined**:

    This app provides functions for task management and team collaboration.

    Operational Patterns:
      - Always use 'searchUsers' to resolve user handles to internal IDs before calling 'assignTask'.
      - Prefer 'batchUpdateStatus' when modifying more than 3 tasks simultaneously to reduce
    latency.

    Constraints:
      - Task titles are limited to 100 characters.
      - Attachment uploads are limited to 5MB.