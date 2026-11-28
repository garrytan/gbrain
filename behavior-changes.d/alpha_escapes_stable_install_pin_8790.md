---
kind: fix
---
A Bun global install saved as the upstream #stable or #latest-stable Git ref now honors gbrain upgrade --channel alpha (and its latest alias), including the configured channel and automatic target-version path. Instead of updating the saved stable ref, it installs the selected published release tag through the existing remove-before-add, Bun-floor and recovery checks. If no newer published release exists, the install is unchanged; if release evidence cannot be read, the command refuses without removing the installed package. Stable-channel evidence validation, exact commit/version pins, ordinary branch refs and other repositories keep their existing behavior.
