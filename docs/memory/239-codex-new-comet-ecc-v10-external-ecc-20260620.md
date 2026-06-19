# 239-codex-new comet-ecc V10 external ECC dependency rule

Recorded: 2026-06-20 China time
Owner/prefix: `239-codex-new-`
Marker: `239-codex-new-comet-ecc-v10-external-ecc-20260620`

## Decision

`G:\codex-project\comet-ecc` should target full V10 completion. The scope is not limited to V4 smart routing.

ECC must remain a separate, safely managed external dependency because upstream ECC changes frequently. comet-ecc must not copy, vendor, or package the whole ECC source tree into its own repo.

## Required architecture

1. Safe ECC dependency manager.
2. ECC path/version/commit detection before use.
3. Bridge/adapter layer that calls or reads ECC capabilities without vendoring ECC.
4. Compatibility validation after ECC refresh.
5. Tests for missing, dirty, outdated, or incompatible ECC.

## Non-goal

Do not hide ECC source updates inside comet-ecc commits. comet-ecc owns the bridge and compatibility logic, not ECC source packaging.
