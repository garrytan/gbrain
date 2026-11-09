# Share GBrain workflows through an account plugin

An already connected GBrain App can reach one central brain while an account
plugin supplies its workflows to supported ChatGPT and Codex clients. A plugin
that contains only an App reference can expose tools without distributing the
GBrain skills. Add the skills to that existing account package, then verify each
intended client.

**Say to your agent:** *"Make my existing GBrain workflows available through my
account plugin, keeping the same brain and connection."*

This is a packaging and migration recipe for an existing connection. It does not
publish a server, create a new brain, grant permissions or make every upstream
workflow executable in a cloud host. For a new connection, use
[ChatGPT setup](../mcp/CHATGPT.md) and [remote MCP](remote-mcp.md). A private
transport must already be supported by the host and connected App; adding skills
does not make an unreachable server reachable.

## Keep the three components separate

| Component | What it supplies | What to preserve |
| --- | --- | --- |
| Account plugin | Skill discovery, workflow text and an App reference | Existing plugin identity and presentation; upstream license and provenance |
| Connected App | Authenticated tools reaching the central brain | App identity, existing grant, source restrictions and transport |
| Device configuration | Local MCP entries, wrappers and agent routing instructions | Unrelated configuration; a verified recovery path for any retired entry |

A direct MCP server configured on a device is separate from the account App.
For example, a Codex startup failure naming a required server `gbrain` can occur
before the agent starts and before the account App is called. It does not prove
the cloud App lost authorization. Inspect the effective configuration and
connection source before asking the user to authenticate, replacing an identity,
or changing a required-server setting.

## Update the existing account package

Use the host's supported owner/editor workflow. Consult the current
[OpenAI plugin packaging documentation](https://developers.openai.com/plugins/build/plugins)
for the package format and editing rights. If editing tools are unavailable but
the official UI supports downloading the current ZIP and uploading a new
version, use that workflow. Do not treat a device cache as the authoritative
editable account source, and do not create a second plugin to work around missing
editing rights.

1. Download or inspect the actual current account package. Record its version,
   plugin/App mapping, manifests and file hashes. Keep a private original backup.
2. Preserve the complete App binding and existing presentation fields, including
   null values. Add skills through the supported manifest field. Where the
   package has `.app.json`, retain that binding rather than constructing another
   App. An account-specific binding belongs in the private package, not in a
   public example or upstream pull request.
3. Pin an upstream commit or release. Collect the intended workflows and their
   referenced conventions/assets with the license and provenance. Do not assume
   that copying only `SKILL.md` makes its relative references available. Respect
   the upstream [skill reference](skill-reference.md) and plugin lane exclusions.
4. Add a connection skill and an explicit transport instruction to every copied
   workflow. Preserve the workflow's original frontmatter. The instruction must
   load the connection skill from this package before following CLI examples.
   Merely adding a connection skill does not prove other skills invoke it.
5. Exclude local MCP launchers and shell hooks from an App-only adaptation. Do not
   accidentally distribute device credentials, service configuration or personal
   memory. Keep an executable or filesystem step only when that host supports it
   and the user separately authorized it.
6. Publish a new version of the same account plugin through the supported flow.
   Download/read the saved version again, verify expected assets and App identity,
   and compare any backend manifest normalization semantically. A successful
   upload is not client activation evidence.

An illustrative layout is:

```text
existing-account-plugin/
  plugin.json                 # preserve the host's current manifest format
  .app.json                   # preserve the existing binding, if present
  LICENSE
  PROVENANCE.json             # pinned upstream revision + adaptation description
  skills/
    remote-connection/
      SKILL.md
    query/
      SKILL.md
    conventions/              # referenced assets needed by selected workflows
```

Use the manifests returned by the actual account editor. This layout does not
authorize inventing an App ID or replacing an existing compatibility manifest.

## What the connection instruction must say

Keep the instruction specific enough to prevent accidental local setup:

- Use the already connected GBrain App and the current host's actual tool
  schemas. Verify identity with `whoami` and `get_brain_identity`; resolve the
  intended brain and granted source. A matching display name alone is insufficient.
- CLI examples describe operations. Translate only operations the App exposes,
  retaining the operation's parameters, authorization and concurrency checks.
  Do not run `init`, start a local service, create another connection or expose a
  public endpoint to satisfy a workflow.
- Missing tools or assets stop the affected step. Local repair, upgrade,
  filesystem, hooks, other connectors, and paid model steps require their own
  capabilities and authorization. Skill installation does not provide them.
- Preserve the existing grant and operation catalog. A safe admin read can test
  an existing admin capability; do not execute destructive operations merely to
  demonstrate a scope label. OAuth admin scope is not owner-dashboard authority.
- Before authorized writes, read the user's existing writeback policy and target.
  Make the smallest intended change with the operation's current preconditions,
  a stable request ID, a committed receipt and independent readback. Synthetic
  tests are tool observations, not statements by the user.

For general memory and source boundaries, use
[memory boundaries](memory-boundaries.md) and
[brain/source routing](../../skills/conventions/brain-routing.md).

## Migrate each device's routing instructions

Inspect the device's actual project, account skill catalog, local wrappers and
direct MCP entries. With the user's authorization, update only the obsolete
connection-routing portions of its global agent instructions or memory. Retain
unrelated instructions and identity. Record the account connection skill's
discovery name and how to verify the live source; avoid copying credentials or
hard-coding private endpoints into instructions.

The migration should tell a fresh session to use the account App and account
skills, distinguish the brain's shared-skill catalog from account-distributed
skills, and report a missing capability instead of falling back to another brain.
If a required old direct MCP prevents startup, establish its exact identity and
dependencies and prepare a supported recovery path before changing it. Do not
disable a required connection just to hide an authentication failure.

## Verify the actual client, then retire a duplicate

Use a fresh ordinary session in each intended device's original project. Record
the client/interface and account version, then check:

| Check | Required evidence |
| --- | --- |
| Skill source | Actual connection/query/reference reads from the account package; a Codex materialized account cache is distinct from a locally installed wrapper |
| Connection | Native App calls return the intended identity, brain and granted source; no local CLI or alternate MCP substituted |
| Capabilities | Existing grant/catalog retained; an appropriate safe admin read when admin was already granted |
| Authorized write | One unique synthetic delta to a dedicated test page, current concurrency preconditions, committed receipt |
| Readback | Independent native read matches source, target, revision and unique delta; original content, source and trust preserved |
| Replacement | Backed-up duplicate is absent/disabled, then normal fresh startup works without temporary overrides or injected plugin paths |

An invocation-only local-wrapper override can establish isolation for that
invocation. It is not proof of ordinary startup after permanent removal. Remove
one precisely identified local wrapper at a time through supported plugin
management, keep the registered recovery source/backup, and restore it if the
normal replacement check fails. Keep the account plugin, App, transport, grant
and brain data. A wrapper may share an App with other clients; do not uninstall
that shared App as part of local cleanup.

Preserve original timeline rows when testing. A dated source citation or a
timeline append may intentionally produce an additional structured timeline
entry; distinguish that from loss or modification of an existing entry. Caller
receipt IDs and internal journal attribution IDs can differ. Check the actual
association before declaring corruption, and never delete records to make an
assertion pass. See [write receipts](../protocol/AGENT_OPERATOR_v1.md) for pending
and retry handling.

Record explicitly requested invocation separately from automatic skill routing.
Report untested clients, unavailable local workflows, renewal and upgrade
compatibility as unverified. A passing desktop conversation does not certify
every browser, mobile client or upstream skill.

### Implementation experience and limits

A private adaptation pinned to GBrain `0.60.613.0` distributed 71 upstream
workflows plus one connection skill through an existing account plugin. Four
device-specific Codex environments (three macOS computers and one Windows
computer), plus user-tested computer and mobile ChatGPT conversations, completed
native App writes, committed receipts and independent readbacks against the
same granted source. Account skill/reference reads were recorded per host;
the company macOS acceptance read the connection skill and contract but did not
separately demonstrate the query skill. A later macOS test corrected an initial
citation-lint failure and produced a zero-error, zero-warning receipt. Separate
reads and bounded read-only journal/timeline joins verified the reported caller
and internal attribution IDs where available.

After supported removal of one backed-up local skill wrapper, an ordinary fresh
macOS Codex session also loaded the account package and completed the native
write/receipt/readback cycle, with no temporary disable override or injected
plugin path. The Windows isolation test initially used an invocation-only
override; that evidence alone does not establish permanent duplicate-free
startup on Windows or other computers. Other historical packages with unresolved
dependencies were retained.

That experience establishes the tested connection and core memory workflow. It
does not establish all 71 workflows, automatic routing, future token renewal,
every client version or equivalent access to auxiliary knowledge sources. Read
the current writeback policy before every new write; a local memory entry should
point to the live policy rather than freeze its full text or old tool/path/size
limits. Publish only sanitized steps and these explicit limits, never private
App IDs, tunnel details, credentials, local paths, transcripts or production-page
contents.
