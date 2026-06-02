---
title: "Uninstall pnpm Steps"
type: note
created: 2025-03-13
updated: 2025-03-13
source: chatgpt-export
conversation_id: 67d32412-8314-8007-aeaf-95b666364775
message_count: 2
tags: [chatgpt, import, code]
---
# Uninstall pnpm Steps

> Conversation ID: 67d32412-8314-8007-aeaf-95b666364775
> Created: 2025-03-13T18:29:38Z
> Updated: 2025-03-13T18:29:50Z
> Messages: 2

---

## User

pnpm uninstall

---

## Assistant

Mr. White,

To uninstall `pnpm` from your system, follow these steps:

1. **Remove Global Packages Installed by `pnpm`:**

   Before uninstalling `pnpm`, it's advisable to remove any global packages it installed:

   - List all globally installed packages:

     ```bash
     pnpm ls -g
     ```

   - Remove each global package:

     ```bash
     pnpm rm -g <package_name>
     ```

   Alternatively, you can locate the global package directory and remove it entirely:

   ```bash
   pnpm root -g
   rm -rf <global_package_directory>
   ```


   citeturn0search0

2. **Uninstall the `pnpm` CLI:**

   The uninstallation method depends on how you initially installed `pnpm`:

   - **If Installed via Standalone Script:**

     Remove the `pnpm` home directory:

     ```bash
     rm -rf "$PNPM_HOME"
     ```

     Additionally, clear the `PNPM_HOME` environment variable from your shell configuration file (`~/.bashrc`, `~/.zshrc`, or `~/.config/fish/config.fish`).

   - **If Installed via `npm`:**

     Use `npm` to uninstall `pnpm`:

     ```bash
     npm rm -g pnpm
     ```

   citeturn0search0

3. **Remove the Global Content-Addressable Store:**

   `pnpm` stores packages in a global content-addressable store. To remove it:

   ```bash
   rm -rf "$(pnpm store path)"
   ```


   If you've used `pnpm` across multiple disks, execute the above command on each disk where `pnpm` was utilized, as it creates one store per disk.

   citeturn0search0

By following these steps, you should successfully uninstall `pnpm` from your system. 


## See Also
- [[chatgpt/chatgpt_corepack-pnpm-fixes]]
- [[chatgpt/chatgpt_doppler-pnpm-setup]]
- [[chatgpt/chatgpt_force-pnpm-on-vercel]]
- [[chatgpt/chatgpt_npx-vs-pnpm-comparison]]
- [[chatgpt/chatgpt_pnpm-in-ci]]
