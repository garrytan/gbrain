---
kind: fix
---
gbrain frontmatter validate now checks every path it is given. With several paths it used to check only the last one, so a bad file named earlier could pass with exit 0. It now checks all of them, exits 1 if any fails, and refuses before checking anything when a path does not exist. With --json and more than one path, the output adds a targets list.
