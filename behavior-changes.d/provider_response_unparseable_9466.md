---
kind: fix
---
A model provider that answers with a success status and a body that is not one JSON document (a route that streams when a request omits stream is the common cause) now fails with the non-retryable code provider_response_unparseable instead of a transient error. A facts job that hits it ends on its first attempt instead of retrying the same paid call, gbrain facts retry-dead does not resubmit it, and its recorded error reads cause=AIConfigError provider_response_unparseable. No response text is kept. Fix the route, for example with gbrain config set provider_chat_options.<provider>:<model> '{"stream": false}', then retry the job.
