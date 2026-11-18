---
kind: fix
---
The automatic purges (the cycle's purge phase, gbrain maintain and the purge job) no longer hard-delete a concept page that was hidden only because one of its input pages was purged and is still waiting to be rebuilt. Before, such a concept was removed about 72 hours after it was hidden, with its history and incoming links, and nothing rebuilt it (#9653). A concept a person or a sync deleted still expires on time, and gbrain pages purge-deleted --yes or gbrain delete --purge still removes a kept concept.
