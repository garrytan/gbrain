# Post-install hint

When `gbrain integrations install retrieval-reflex --target <repo>` completes,
print this to stdout (or to the install agent's conversation surface) so the
operator knows what to do next.

---

✓ Retrieval-reflex policy skill installed to `<target-repo>/skills/retrieval-reflex/`.

**Three follow-up steps:**

### 1. Confirm the deterministic pointer layer is healthy

```bash
gbrain doctor --json | jq '.checks[] | select(.name=="retrieval_reflex_health")'
```

The pointer layer lives in the gbrain context engine (zero-LLM, on by
default) — nothing to install. If the check reports it disabled, the policy
skill alone still carries the behavior; the check output says which.

### 2. Review the appended resolver row

This install appended one row to your `<target>/RESOLVER.md` (or `AGENTS.md`):

```
retrieval-reflex | a named person/company/project/place becomes the subject mid-conversation; ...
```

The row is deliberately REFLEX-ONLY. Explicit lookup questions ("who is X",
"tell me about Y", "what do we know about Z") belong to your query/search
skill — do not add those phrases to this row, or the two skills will contend
for the same requests and routing becomes ambiguous.

### 3. Update later

When gbrain ships a new retrieval-reflex policy, refresh your local copy:

```bash
gbrain integrations install retrieval-reflex --target <target-repo> --refresh
```

Local edits are preserved by default; pass `--auto take-theirs` to take
upstream everywhere, or `--dry-run` to preview.
