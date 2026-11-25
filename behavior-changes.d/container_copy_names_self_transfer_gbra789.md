---
kind: fix
---
A prebuilt brain copied into a container (its checkout and the ownership reservation beside it, now on another filesystem device) used to refuse its first write with a generic recovery_required and no way out. It now refuses with detail physical_root_directory_changed and names the relocated-root self-transfer (writer transfer prepare and accept with --self-transfer --confirm-relocated-root), which re-stamps the path once per container. A stamp that disagrees with its reservation, or a malformed device, still gets the generic refusal.
