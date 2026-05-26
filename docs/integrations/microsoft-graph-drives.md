# Microsoft Graph Drives

GBrain can register OneDrive and SharePoint document libraries as source-scoped
Microsoft Graph drives.

## Why this connector exists

OneDrive and SharePoint expose the same Microsoft Graph file model:

- A `drive` is a user's OneDrive or a SharePoint document library.
- A `driveItem` is a file or folder inside that drive.
- Delta sync tracks creates, updates, renames, and deletes without re-walking
  every file on each run.

References:

- Microsoft Graph delta API: https://learn.microsoft.com/en-us/graph/api/driveitem-delta
- Working with files in Microsoft Graph: https://learn.microsoft.com/en-us/graph/api/resources/onedrive
- Microsoft Graph permissions reference: https://learn.microsoft.com/en-us/graph/permissions-reference

## Authentication

Set a Microsoft Graph bearer token in one of these environment variables:

```sh
export MICROSOFT_GRAPH_TOKEN=...
```

Aliases also supported: `MS_GRAPH_TOKEN`, `GRAPH_ACCESS_TOKEN`.

Least-privilege delegated permissions are:

- OneDrive: `Files.Read`
- SharePoint libraries: `Files.Read` for files the signed-in user can access,
  or `Sites.Read.All` / `Files.Read.All` when the tenant policy requires it.

The token is never written into `sources.config`; only drive/site ids and delta
cursors are stored.

## Register Sources

Register the signed-in user's default OneDrive:

```sh
gbrain microsoft-drives add-onedrive onedrive
```

Register a specific OneDrive drive id:

```sh
gbrain microsoft-drives add-onedrive onedrive-work --drive-id <drive-id>
```

Discover SharePoint document libraries for a site:

```sh
gbrain microsoft-drives list-sharepoint-drives --site-url https://contoso.sharepoint.com/sites/team
```

Register a SharePoint document library:

```sh
gbrain microsoft-drives add-sharepoint sp-team \
  --site-url https://contoso.sharepoint.com/sites/team \
  --drive-name Documents
```

## Sync

Initial sync defaults to metadata/text import without inline embeddings:

```sh
gbrain microsoft-drives sync sp-team
gbrain embed --stale
```

Use `--embed` for inline embedding on small drives:

```sh
gbrain microsoft-drives sync sp-team --embed
```

Use `--limit` for bounded passes:

```sh
gbrain microsoft-drives sync sp-team --limit 500
```

If a pass stops with a continuation cursor, rerun the same command. Once the
delta is complete, GBrain stores `delta_link` and subsequent runs only request
new changes.

## Current Extraction Behavior

Text-like files (`.md`, `.txt`, `.csv`, `.json`, source code, HTML, SQL, logs,
and other `text/*` MIME types) are downloaded and imported as searchable pages.

Office files, PDFs, and other binary formats are imported as metadata-only pages
with Microsoft 365 links, item ids, MIME type, size, and modified-by metadata.
This avoids corrupting the brain with binary bytes while leaving a stable page
to enrich later when document text extraction is added.
