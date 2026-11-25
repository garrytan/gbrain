---
kind: default
---
gbrain google connect and setup now ask Google for exactly the read-only scopes they need and no longer merge earlier grants of the same OAuth client (include_granted_scopes=false). A consent, import or token refresh whose scopes include one that can change data (for example gmail.modify) is refused with the new code write_scope_refused and nothing is stored; a grant that already holds such a scope refreshes with only its read-only scopes, and keeps working when Google narrows the token. If you see write_scope_refused, run gbrain google connect --reauth <email>. The OAuth client is now saved only together with a finished consent, so an abandoned or failed consent leaves the previous client and connection in place.
