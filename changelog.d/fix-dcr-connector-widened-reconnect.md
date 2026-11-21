**A self-registered connector such as claude.ai gets the wider access the owner gives it with `gbrain auth rescope` the next time it connects.**

### Fixed
- A browser connector that registered itself asking only for `read` stayed read-only after the owner widened it with `gbrain auth rescope --client <id> --scopes read,write`: it asks for `read` again every time it connects, and the owner's approval granted only what it asked for. Now the owner's approval of a self-registered connector grants its whole current scope, shown on the approval page, whenever the request names any scope it holds. The scope the owner set stays the ceiling, a connector asking for more gets no more, and a request naming nothing it holds still gets nothing. Tokens already issued and their refreshes keep the scope approved for them, and narrowing a connector still takes effect at once on its existing tokens. Clients the operator registered are unchanged. Reported and first fixed by Devin McNulty (overtonxyz/gbrain#2770).

<!-- behavior-change: dcr_connector_takes_widened_grant_gst3334 -->
