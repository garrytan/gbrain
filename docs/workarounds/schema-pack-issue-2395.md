# Schema Pack Workaround for Issue #2395

## Problem

Since v0.42.52.0, `gbrain schema use gbrain-base` fails with "Unknown pack" even though `gbrain schema list` shows it as bundled. Same for `gbrain-recommended`. This is a regression from v0.42.40.0 where schema packs worked correctly.

Upstream issue: https://github.com/garrytan/gbrain/issues/2395

The bug blocks:
- `extract_atoms` phase (gated on schema pack)
- `type_proliferation` doctor check
- Expert routing via `find_experts`

## Workaround

`gbrain schema init` works correctly for user-created packs. The bundled pack loader is broken, but the user-pack system is functional.

**Steps to work around:**

1. Create a custom pack:
```bash
gbrain schema init my-pack
```

2. Populate it with your page types. Use `gbrain schema detect` to discover types by directory structure, then manually map them to valid primitives (`entity`, `media`, `temporal`, `concept`, `annotation`).

3. Activate:
```bash
gbrain schema validate my-pack
gbrain schema use my-pack
```

4. Verify:
```bash
gbrain schema stats  # Should show 100% typed coverage
```

The custom pack can be deleted once #2395 is fixed upstream and `gbrain schema use gbrain-base` works again.

## Verification

Tested on gbrain 0.42.53.0 (bun global install). The workaround restores schema pack functionality: 1303/1303 pages typed, 50 page types declared.
