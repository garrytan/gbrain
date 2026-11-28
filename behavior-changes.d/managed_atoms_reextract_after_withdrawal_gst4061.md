---
kind: fix
---
extract_atoms on a managed source now offers a page again when a world withdrawal naming that page, or a source-wide withdrawal (subject '*', which forgetting a fact with no entity records), was recorded after its last extraction, as unmanaged sources already did, and a page renamed into a restricted folder is offered again while world atoms still carry its old slug. Each such page costs one model call, and a source-wide withdrawal offers every managed page in the source again each time one is recorded. The extract_atoms backlog in gbrain doctor counts them. Doctor's atom_provenance_drift now reports ok when the only drifted atoms belong to edited pages waiting for extraction, and lists them as awaiting_reextraction.
