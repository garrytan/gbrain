---
kind: fix
---
Bundled skills now treat a model provider's refusal as the end of that step: the agent reports it to the user, naming the model, and does not rerun the request on another model. This replaces the earlier wording that let another model review a refused request when the user picked one. Nothing to do.
