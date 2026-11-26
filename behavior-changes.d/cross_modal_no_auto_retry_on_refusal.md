---
kind: fix
---
The cross-modal-review skill no longer retries a refused review on other models by itself. The refusal_routing.behavior value next_in_chain and the chain list are removed from skills/conventions/cross-modal.yaml; a refusal is reported to the user, naming the model, and another model reviews only when the user picks one. A copy that still says next_in_chain is treated as report, and the agent says once that the option was removed. Nothing to do.
