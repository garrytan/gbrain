---
kind: breaking
exception: security
---
OAuth refresh tokens issued by gbrain serve --http now belong to a sign-in family (migration v338). For 60 seconds after a refresh token is rotated, the same client sending it again gets back the pair that already replaced it instead of invalid_grant, so parallel refreshes and a retry after a lost answer keep the sign-in. Any other reuse of a rotated refresh token (after 60 seconds, from a different client, or a token older than the one just replaced) is treated as theft: every access and refresh token of that sign-in is deleted and the client must reconnect and get owner approval again. Other sign-ins of the same client are not touched. Tokens issued before the upgrade start a family on their next refresh.
