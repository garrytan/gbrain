---
kind: add
---
gbrain setup hermes now registers gbrain's MCP server in Hermes itself, by running Hermes's own hermes mcp add (answering its prompts with yes) and then hermes mcp test gbrain, where it used to print the registration step for you to run. Hermes writes the entry into its config.yaml. An mcp_servers.gbrain entry gbrain did not write, such as a hosted URL, is left as it is. With no hermes command on PATH or where Hermes's installer puts it, setup prints the command instead. gbrain setup hermes --instructions-only still leaves MCP alone, and gbrain setup hermes --remove now also runs hermes mcp remove gbrain.
