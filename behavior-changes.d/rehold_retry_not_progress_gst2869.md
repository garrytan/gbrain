---
kind: fix
---
A stopped sync pass no longer counts as progress when the only holds it rewrote were re-checked because gbrain sync unblock or gbrain sources retry-held asked and kept their code and file bytes (the hold is now marked retry_only; a retry that changed either restarts the hold and still counts once), or when the rewrite brought a transient hold (preparation_stalled, write_interrupted, or a page write that failed while frozen) to its attempt cap. Before, such a re-hold reset the abandoned-pass count once per retry round, so a source could stay pass_interrupted instead of reaching pass_abandoned.
