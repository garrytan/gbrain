---
kind: fix
---
Atom extraction now reads each page as a remote reader sees it, so withdrawn claims and facts rows held from world readers no longer reach the model. On a source without managed atom maintenance, a page with a world withdrawal recorded after its last extraction is offered again until one extraction of it succeeds, and an edit that leaves this input unchanged reuses the page's atoms without a model call. There, a page renamed and made private has the atoms still named after its old slug retired on its next extraction, unless another page now holds that slug.
