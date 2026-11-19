---
kind: fix
---
When no brain.audience is declared, gbrain now decides whether a brain is shared by counting the people behind its active MCP clients, not the clients. Clients bound to the same member count once, a client bound to nobody counts by itself, and the brain reads as shared at 2 members or 3 people. Two kinds of brain can change on upgrade. A brain that read as shared only because one person used three or more clients now reads as personal; before, the owner's own clients made it look shared. A brain whose active clients are bound to two different members now reads as shared; before, it needed three clients. A brain with brain.audience set is unchanged. gbrain doctor shows the count in audience_reasons, and gbrain config set brain.audience personal|shared declares the answer.
