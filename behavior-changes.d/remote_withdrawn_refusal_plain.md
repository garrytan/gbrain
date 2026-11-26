---
kind: fix
---
A remote caller (MCP, HTTP or a thin client) that saves a claim someone explicitly forgot now always gets the plain fact_withdrawn refusal, with no withdrawn object (no forget date, subject or visibility), and a remote reader's write receipts and replays leave that object out as well. Before, it got the object when it could read the forgotten rows and a page-not-found answer when it could not. A save onto the caller's own member page still names a withdrawal of that page's rows. Callers on the brain's own machine keep the object; to see when and how a claim was forgotten, run the same command on the brain host.
