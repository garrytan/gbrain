---
kind: fix
---
Approving a self-registered connector (one that registered through the brain's open registration endpoint, such as claude.ai) now grants its whole current scope whenever its request names any scope it holds, so a connector you widened with gbrain auth rescope --client <id> --scopes read,write gets write the next time it connects and you approve it, even though it still asks for read. The approval page shows the scope you are granting. Its scope is still the ceiling, existing tokens and their refreshes keep the scope approved for them, and narrowing still applies at once. Clients you registered yourself keep getting only the scopes they ask for.
