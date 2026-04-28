# Storage Tiering: git-tracked vs supabase-only directories

## Overview

GBrain supports storage tiering to separate version-controlled content from bulk machine-generated data. This prevents git repositories from becoming bloated with large amounts of automatically generated content while still preserving it in the database.

## Configuration

Add a `storage` section to your `gbrain.yml` file in the brain repository root:

```yaml
storage:
  # Directories that are git-tracked (version controlled, human-edited)
  git_tracked:
    - people/
    - companies/
    - deals/
    - concepts/
    - yc/
    - ideas/
    - projects/
    
  # Directories persisted via Supabase only (bulk ingest, machine-generated)
  # These are written to disk as a local cache but not committed to git.
  # `gbrain export` restores them from Supabase when missing.
  supabase_only:
    - media/x/
    - media/articles/
    - meetings/transcripts/
```

## Behavior Changes

### 1. `gbrain sync` - Automatic .gitignore Management

When storage configuration is present, `sync` automatically manages `.gitignore` entries:

- Adds missing `supabase_only` directory patterns to `.gitignore`
- Prevents duplicate entries
- Adds a comment section for auto-managed entries
- Only runs when not in `--dry-run` mode

Example `.gitignore` addition:
```gitignore
# Auto-managed by gbrain (supabase-only directories)
media/x/
media/articles/
meetings/transcripts/
```

### 2. `gbrain export` - Enhanced Restore Capabilities

New flags for targeted export:

```bash
# Restore only missing supabase-only files from database
gbrain export --restore-only --repo /path/to/brain

# Filter by page type
gbrain export --restore-only --type media --repo /path/to/brain

# Filter by slug prefix
gbrain export --restore-only --slug-prefix media/x/ --repo /path/to/brain

# Combine filters
gbrain export --restore-only --type media --slug-prefix media/x/ --repo /path/to/brain
```

The `--restore-only` flag:
- Only exports pages that match `supabase_only` patterns
- Only includes pages where the file is missing from disk
- Ideal for container restart recovery scenarios

### 3. `gbrain storage status` - Storage Health Dashboard

New command to inspect storage tier configuration and health:

```bash
# Human-readable status
gbrain storage status --repo /path/to/brain

# JSON output for scripts
gbrain storage status --repo /path/to/brain --json
```

Output includes:
- Total page counts by storage tier
- Disk usage breakdown
- Missing files that need restoration
- Configuration validation warnings
- Current storage tier directory listing

Example output:
```
Storage Status
==============

Repository: /data/brain
Total pages: 15,243

Storage Tiers:
─────────────
Git tracked:    2,156 pages
Supabase only:  12,887 pages
Unspecified:    200 pages

Disk Usage:
──────────
Git tracked:    45.2 MB
Supabase only:  2.1 GB

Missing Files (need restore):
────────────────────────────
  media/x/tweet-1234567890
  media/x/tweet-0987654321
  ... and 47 more

Use: gbrain export --restore-only --repo "/data/brain"

Configuration:
─────────────
Git tracked directories:
  • people/
  • companies/
  • deals/

Supabase-only directories:
  • media/x/
  • media/articles/
  • meetings/transcripts/
```

## Validation

The system validates storage configuration and warns about:

- Directories appearing in both `git_tracked` and `supabase_only`
- Directory paths not ending with `/` (consistency recommendation)
- `supabase_only` directories not present in `.gitignore`

## Use Cases

### 1. Brain Repository Scaling

Perfect for brain repositories approaching 100K+ files where:
- Core knowledge (people, companies, deals) remains git-tracked
- Bulk data (tweets, articles, transcripts) moves to supabase-only
- Development stays fast with smaller git repos
- Full data remains available via database

### 2. Container-based Deployments

Essential for ephemeral container environments:
- Git repo contains only essential files
- Container restarts don't lose supabase-only data
- `gbrain export --restore-only` quickly restores bulk files when needed
- Local disk acts as cache layer

### 3. Multi-Environment Consistency

Enables consistent data access across environments:
- Development: small git clone, restore bulk data on demand
- Production: full dataset via database, selective local caching
- CI/CD: fast tests with git-tracked data only

## Migration Strategy

1. **Assess current repository**: Use `gbrain storage status` to understand current distribution
2. **Plan directory structure**: Identify which directories should be git-tracked vs supabase-only
3. **Create gbrain.yml**: Add storage configuration to repository root
4. **Test with dry-run**: Use `gbrain sync --dry-run` to verify behavior
5. **Update .gitignore**: Let `gbrain sync` auto-manage entries
6. **Verify exports**: Test `gbrain export --restore-only` for container scenarios

## Best Practices

- **Directory naming**: Always end storage paths with `/` for consistency
- **Start small**: Begin with clearly machine-generated directories in `supabase_only`
- **Monitor warnings**: Address configuration validation warnings promptly
- **Test restore**: Regularly test `--restore-only` in staging environments
- **Document decisions**: Comment your `gbrain.yml` to explain tier choices

## Compatibility

- **Backward compatible**: Systems without `gbrain.yml` work unchanged
- **Progressive enhancement**: Add configuration when needed
- **Database unchanged**: All data remains in Supabase regardless of tier
- **Existing workflows**: All existing `sync` and `export` behavior preserved
