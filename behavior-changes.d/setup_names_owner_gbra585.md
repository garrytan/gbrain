---
kind: default
---
gbrain setup <harness> --serves several (and gbrain access serves several --owner <id>) now names the brain owner when the brain has none: it adds a member from --owner <id>, or by default from your login name as a member id, and runs gbrain access owner set on it. The preview shows it first. An owner that is already set is kept, and no key or OAuth client is rebound: the receipt lists each live credential bound to no member with the gbrain auth rescope --token|--client <name> --member <owner> command that binds it. A script that ran setup --serves several on a brain with no owner now finds one more enabled member, the owner, in gbrain access member list. Pass --owner <id> to choose who it is.
