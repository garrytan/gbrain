//! The store as an addon class. `Brain` owns at most one open brain and runs every call on the
//! worker pool it was built with, so the JavaScript thread only queues work and settles results.
//!
//! Rules every method follows (the contract is documented in `rust/README.md`):
//! - arguments are plain JSON-shaped values; results are plain JSON-shaped values, with `null`
//!   where PGLite returns null;
//! - the call returns a promise; a failure rejects with an `Error` whose `code` is one of the
//!   store codes in the README;
//! - a call made while the brain is closed rejects with `store_closed`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gbrain_store::{OpenOptions, Store, StoreError};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::binding::{Pool, spawn};
use crate::error::TaskError;
use crate::pool;

type Slot = Arc<Mutex<Option<Arc<Store>>>>;

/// How long `close` waits for calls already running before it reports `store_io`.
const CLOSE_WAIT: Duration = Duration::from_secs(30);

pub(crate) fn task_error(error: StoreError) -> TaskError {
    TaskError::new(error.code, error.message)
}

/// Decodes a JSON argument. `null` and a missing argument are the same thing.
fn arg<T: DeserializeOwned + Default>(value: Option<Value>, what: &str) -> Result<T, StoreError> {
    match value {
        None | Some(Value::Null) => Ok(T::default()),
        Some(value) => {
            serde_json::from_value(value).map_err(|e| StoreError::invalid(format!("{what}: {e}")))
        }
    }
}

/// Like `arg`, for an argument that must be given.
fn required<T: DeserializeOwned>(value: Value, what: &str) -> Result<T, StoreError> {
    serde_json::from_value(value).map_err(|e| StoreError::invalid(format!("{what}: {e}")))
}

/// Options for `Brain#open`.
#[napi(object)]
pub struct BrainOpenOptions {
    /// What a fresh brain stores as config `version` (the TypeScript `LATEST_SCHEMA_VERSION`).
    pub schema_version: Option<u32>,
    /// Recorded in `FORMAT` when the brain is created.
    pub created_by: Option<String>,
}

#[napi]
pub struct Brain {
    pool: pool::Pool,
    slot: Slot,
}

impl Brain {
    /// Runs `work` on the pool against the open store. The store handle is taken now, on the
    /// calling thread, so calls run against the brain that was open when they were made.
    fn run<'env, T: Serialize + Send + 'static>(
        &self,
        env: &'env Env,
        work: impl FnOnce(&Store) -> Result<T, StoreError> + Send + 'static,
    ) -> napi::Result<Object<'env>> {
        let store = self.slot.lock().unwrap_or_else(|e| e.into_inner()).clone();
        spawn(env, &self.pool, move || {
            let store = store.ok_or_else(|| {
                TaskError::new(gbrain_store::error::STORE_CLOSED, "the brain is not open")
            })?;
            let value = work(&store).map_err(task_error)?;
            serde_json::to_value(value).map_err(|e| {
                TaskError::new(
                    gbrain_store::error::STORE_CORRUPT,
                    format!("a result could not be encoded: {e}"),
                )
            })
        })
    }
}

#[napi]
impl Brain {
    /// `new Brain(pool)`. The brain is closed until `open` resolves.
    #[napi(constructor)]
    pub fn new(pool: &Pool) -> Self {
        Self {
            pool: pool.pool.clone(),
            slot: Arc::new(Mutex::new(None)),
        }
    }

    /// True while a brain is open on this handle.
    #[napi(getter)]
    pub fn is_open(&self) -> bool {
        self.slot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// `open(path, options?)`: opens the brain in directory `path` (created when empty) and
    /// resolves `{ brain_id, format_version, schema_version, created }`.
    ///
    /// Rejects `store_locked` when another handle or process owns the brain, `format_unknown` for
    /// a format this build does not read, `invalid_state` when this handle is already open.
    #[napi]
    pub fn open<'env>(
        &self,
        env: &'env Env,
        path: String,
        options: Option<BrainOpenOptions>,
    ) -> napi::Result<Object<'env>> {
        let slot = self.slot.clone();
        spawn(env, &self.pool, move || {
            let mut opts = OpenOptions {
                engine_abi: crate::ENGINE_ABI,
                catalog_version: crate::CATALOG_VERSION,
                ..OpenOptions::default()
            };
            if let Some(options) = options {
                if let Some(v) = options.schema_version {
                    opts.schema_version = v;
                }
                if let Some(by) = options.created_by {
                    opts.created_by = by;
                }
            }
            // Holding the slot while opening makes a second `open` on this handle wait, then see
            // the brain open.
            let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_some() {
                return Err(TaskError::new(
                    gbrain_store::error::INVALID_STATE,
                    "this handle already has a brain open; close it first",
                ));
            }
            let store = Store::open_dir(std::path::Path::new(&path), opts).map_err(task_error)?;
            let info = serde_json::to_value(store.info())
                .map_err(|e| TaskError::new(gbrain_store::error::STORE_CORRUPT, e.to_string()))?;
            *guard = Some(Arc::new(store));
            Ok(info)
        })
    }

    /// `close()`: waits for calls already running, then releases the brain and its lock. Resolves
    /// `undefined`; closing a closed handle is a no-op.
    #[napi]
    pub fn close<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        let taken = self.slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        spawn(env, &self.pool, move || {
            let Some(mut store) = taken else {
                return Ok(());
            };
            let deadline = Instant::now() + CLOSE_WAIT;
            loop {
                match Arc::try_unwrap(store) {
                    Ok(owned) => {
                        owned.close();
                        return Ok(());
                    }
                    Err(shared) => {
                        if Instant::now() > deadline {
                            return Err(TaskError::new(
                                gbrain_store::error::STORE_IO,
                                "calls were still running 30 seconds after close",
                            ));
                        }
                        store = shared;
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
            }
        })
    }

    /// `info()`: `{ brain_id, format_version, schema_version, created }` of the open brain.
    #[napi]
    pub fn info<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |store| Ok(store.info().clone()))
    }

    // ---- config -----------------------------------------------------------------------------

    /// `getConfig(key)`: the value or `null`.
    #[napi]
    pub fn get_config<'env>(&self, env: &'env Env, key: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_config(&key))
    }

    /// `setConfig(key, value)`: upsert. Resolves `null`.
    #[napi]
    pub fn set_config<'env>(
        &self,
        env: &'env Env,
        key: String,
        value: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_config(&key, &value))
    }

    /// `unsetConfig(key)`: the number of rows removed (0 or 1).
    #[napi]
    pub fn unset_config<'env>(&self, env: &'env Env, key: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.unset_config(&key))
    }

    /// `listConfigKeys(prefix)`: sorted keys that start with `prefix` (a literal prefix).
    #[napi]
    pub fn list_config_keys<'env>(
        &self,
        env: &'env Env,
        prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_config_keys(&prefix))
    }

    /// `getAllConfig()`: `{ [key]: value }`.
    #[napi]
    pub fn get_all_config<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.get_all_config())
    }

    // ---- sources ----------------------------------------------------------------------------

    /// `listAllSources({ includeArchived?, localPathOnly? }?)`: `SourceRow[]`, `default` first.
    #[napi]
    pub fn list_all_sources<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_all_sources(&arg(options, "listAllSources options")?)
        })
    }

    /// `getSourceById(id)`: the `SourceRow` or `null`.
    #[napi]
    pub fn get_source_by_id<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_source_by_id(&id))
    }

    /// `upsertSource({ id, name?, local_path?, last_sync_at?, config? })`: the `SourceRow`.
    #[napi]
    pub fn upsert_source<'env>(&self, env: &'env Env, input: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.upsert_source(&required(input, "upsertSource input")?)
        })
    }

    /// `updateSourceConfig(id, patch)`: merges `patch` into the config; whether the source exists.
    #[napi]
    pub fn update_source_config<'env>(
        &self,
        env: &'env Env,
        id: String,
        patch: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.update_source_config(&id, &required(patch, "updateSourceConfig patch")?)
        })
    }

    /// `setSourceArchived(id, archived)`: whether the source exists.
    #[napi]
    pub fn set_source_archived<'env>(
        &self,
        env: &'env Env,
        id: String,
        archived: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_source_archived(&id, archived))
    }

    // ---- pages ------------------------------------------------------------------------------

    /// `readPageSnapshot(slug, { sourceId?, sourceIds?, includeDeleted? }?)`: `{ page, tags,
    /// revision, sourceIncarnation, withdrawals }` or `null`. Dates are ISO strings.
    #[napi]
    pub fn read_page_snapshot<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_snapshot(&slug, &arg(options, "readPageSnapshot options")?)
        })
    }

    /// `putPage(slug, page, { sourceId?, allowEmptyOverwrite?, expectedRevision?, force? }?)`: the
    /// stored `Page`. `expectedRevision` is absent, `null` or a revision UUID.
    #[napi]
    pub fn put_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        page: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.put_page(
                &slug,
                &required(page, "putPage page")?,
                &arg(options, "putPage options")?,
            )
        })
    }

    /// `listPages(filters?)`: `Page[]`.
    #[napi]
    pub fn list_pages<'env>(
        &self,
        env: &'env Env,
        filters: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_pages(&arg(filters, "listPages filters")?)
        })
    }

    /// `countPages({ sourceId? }?)`: the number of live pages.
    #[napi]
    pub fn count_pages<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "countPages options")?;
            s.count_pages(scope.source_id.as_deref())
        })
    }

    /// `lockPageKeys([{ sourceId, slug }])`: resolves `null`.
    #[napi]
    pub fn lock_page_keys<'env>(&self, env: &'env Env, keys: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.lock_page_keys(&required::<Vec<gbrain_store::pages::PageKey>>(
                keys,
                "lockPageKeys keys",
            )?)
        })
    }

    /// `resolveSlugs(partial, { sourceId?, sourceIds? }?)`: up to 5 slugs.
    #[napi]
    pub fn resolve_slugs<'env>(
        &self,
        env: &'env Env,
        partial: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.resolve_slugs(&partial, &arg(options, "resolveSlugs options")?)
        })
    }

    /// `softDeletePage(slug, { sourceId? }?)`: `{ slug }` or `null` when no live page matches.
    #[napi]
    pub fn soft_delete_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "softDeletePage options")?;
            Ok(s.soft_delete_page(&slug, scope.source_id.as_deref())?
                .map(|slug| serde_json::json!({ "slug": slug })))
        })
    }

    /// `restorePage(slug, { sourceId? }?)`: whether a deleted page came back.
    #[napi]
    pub fn restore_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "restorePage options")?;
            s.restore_page(&slug, scope.source_id.as_deref())
        })
    }

    /// `deletePage(slug, { sourceId? }?)`: removes the page for good. Resolves `null`.
    #[napi]
    pub fn delete_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "deletePage options")?;
            s.delete_page(&slug, scope.source_id.as_deref())
        })
    }

    /// `getTags(slug, { sourceId?, sourceIds? }?)`: sorted tags.
    #[napi]
    pub fn get_tags<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_tags(&slug, &arg(options, "getTags options")?)
        })
    }

    /// `addTag(slug, tag, { sourceId? }?)`: resolves `null`; `page_not_found` for a missing page.
    #[napi]
    pub fn add_tag<'env>(
        &self,
        env: &'env Env,
        slug: String,
        tag: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "addTag options")?;
            s.add_tag(&slug, &tag, scope.source_id.as_deref())
        })
    }

    /// `removeTag(slug, tag, { sourceId? }?)`: resolves `null`.
    #[napi]
    pub fn remove_tag<'env>(
        &self,
        env: &'env Env,
        slug: String,
        tag: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "removeTag options")?;
            s.remove_tag(&slug, &tag, scope.source_id.as_deref())
        })
    }

    /// `createVersion(slug, { sourceId? }?)`: snapshots the page and resolves the version row.
    #[napi]
    pub fn create_version<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "createVersion options")?;
            s.create_version(&slug, scope.source_id.as_deref())
        })
    }

    /// `getVersions(slug, { sourceId?, sourceIds?, limit?, includeBody? }?)`: newest first.
    #[napi]
    pub fn get_versions<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_versions(&slug, &arg(options, "getVersions options")?)
        })
    }

    /// `upsertChunks(slug, chunks, { sourceId?, expectedRevision?, deferSeal? }?)`: replaces the
    /// page's chunks. With `expectedRevision` the chunks are sealed to it.
    #[napi]
    pub fn upsert_chunks<'env>(
        &self,
        env: &'env Env,
        slug: String,
        chunks: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let chunks: Vec<gbrain_store::chunks::ChunkInput> =
                required(chunks, "upsertChunks chunks")?;
            s.upsert_chunks(&slug, &chunks, &arg(options, "upsertChunks options")?)
        })
    }

    /// `getChunks(slug, { sourceId?, sourceIds?, includeDeleted? }?)`: `Chunk[]` without vectors.
    #[napi]
    pub fn get_chunks<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_chunks(&slug, &arg(options, "getChunks options")?)
        })
    }

    /// `deleteChunks(slug, { sourceId? }?)`: removes the page's chunks; the page stays.
    #[napi]
    pub fn delete_chunks<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "deleteChunks options")?;
            s.delete_chunks(&slug, scope.source_id.as_deref())
        })
    }

    /// `countChunks()`: chunks in the brain.
    #[napi]
    pub fn count_chunks<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_chunks())
    }

    /// `searchKeyword(query, opts?)`: `SearchResult[]`, one per page, best chunk first. Ranking is
    /// BM25, not the Postgres full-text rank; see the README.
    #[napi]
    pub fn search_keyword<'env>(
        &self,
        env: &'env Env,
        query: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.search_keyword(&query, &arg(options, "searchKeyword options")?)
        })
    }
}
