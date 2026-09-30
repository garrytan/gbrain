/* SPDX-License-Identifier: MIT
 * Windows-only IPC operations. Included after the opaque lock registry. */
#ifndef GBRAIN_WINDOWS_IPC_H
#define GBRAIN_WINDOWS_IPC_H
#include <bcrypt.h>

static char *ipc_argument(napi_env env, napi_callback_info info, lock_state **state, bool require_lock) {
  size_t expected = require_lock ? 2 : 1, argc = expected, length = 0;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, (void **)state) != napi_ok ||
      argc != expected || napi_get_value_string_utf8(env, argv[expected - 1], NULL, 0, &length) != napi_ok ||
      length == 0 || length > 131072) {
    napi_throw_type_error(env, "GBRAIN_NATIVE_IPC_PATH", "Expected a nonempty IPC name or path");
    return NULL;
  }
  if ((*state)->closing) { fail(env, "IPC during shutdown", 0); return NULL; }
  if (require_lock) {
    void *pointer = NULL;
    lock_handle *held = NULL;
    if (napi_unwrap(env, argv[0], &pointer) == napi_ok) {
      for (lock_handle *lock = (*state)->handles; lock; lock = lock->next) {
        if (lock == pointer && lock->locked && !lock->mutex_name && lock->handle != INVALID_LOCK_HANDLE) held = lock;
      }
    }
    if (!held) { fail(env, "remove IPC socket without binding claim", ERROR_NOT_OWNER); return NULL; }
  }
  char *text = malloc(length + 1);
  if (!text) { fail(env, "allocate", 0); return NULL; }
  if (napi_get_value_string_utf8(env, argv[expected - 1], text, length + 1, &length) != napi_ok ||
      memchr(text, 0, length) != NULL) {
    free(text);
    napi_throw_type_error(env, "GBRAIN_NATIVE_IPC_PATH", "IPC names and paths must not contain NUL");
    return NULL;
  }
  return text;
}

static napi_value open_ipc_mutex(napi_env env, napi_callback_info info) {
  lock_state *state = NULL;
  char *name = ipc_argument(env, info, &state, false);
  if (!name) return NULL;
  size_t length = strlen(name);
  bool valid = length > 9 && (name[0] == '\\' || name[0] == '/') &&
      (name[1] == '\\' || name[1] == '/') && (name[2] == '.' || name[2] == '?') &&
      (name[3] == '\\' || name[3] == '/') && (name[4] == 'p' || name[4] == 'P') &&
      (name[5] == 'i' || name[5] == 'I') && (name[6] == 'p' || name[6] == 'P') &&
      (name[7] == 'e' || name[7] == 'E') && (name[8] == '\\' || name[8] == '/') &&
      name[9] != '\\' && name[9] != '/';
  if (!valid) {
    free(name);
    napi_throw_type_error(env, "GBRAIN_NATIVE_IPC_PATH", "Expected a Windows named-pipe address");
    return NULL;
  }
  int wide_count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name + 9, -1, NULL, 0);
  wchar_t *wide = wide_count > 0 ? malloc((size_t)wide_count * sizeof(wchar_t)) : NULL;
  if (!wide) { unsigned long error = GetLastError(); free(name); return fail(env, "encode IPC name", error); }
  int converted = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name + 9, -1, wide, wide_count);
  free(name);
  if (!converted) { unsigned long error = GetLastError(); free(wide); return fail(env, "encode IPC name", error); }
  int upper_count = LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_UPPERCASE, wide, wide_count - 1, NULL, 0, NULL, NULL, 0);
  wchar_t *upper = upper_count > 0 ? malloc((size_t)upper_count * sizeof(wchar_t)) : NULL;
  if (!upper) { unsigned long error = GetLastError(); free(wide); return fail(env, "normalize IPC name", error); }
  int normalized = LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_UPPERCASE, wide, wide_count - 1, upper, upper_count, NULL, NULL, 0);
  free(wide);
  if (!normalized) { unsigned long error = GetLastError(); free(upper); return fail(env, "normalize IPC name", error); }
  unsigned char digest[32];
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  NTSTATUS status = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0);
  if (status >= 0) status = BCryptCreateHash(algorithm, &hash, NULL, 0, NULL, 0, 0);
  if (status >= 0) status = BCryptHashData(hash, (PUCHAR)upper, (ULONG)((size_t)upper_count * sizeof(wchar_t)), 0);
  if (status >= 0) status = BCryptFinishHash(hash, digest, sizeof(digest), 0);
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  free(upper);
  if (status < 0) return fail(env, "hash IPC name", (unsigned long)status);
  name = malloc(65);
  if (!name) return fail(env, "allocate", 0);
  const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < sizeof(digest); i++) { name[i * 2] = hex[digest[i] >> 4]; name[i * 2 + 1] = hex[digest[i] & 15]; }
  name[64] = 0;
  /* A global kernel name is independent of HOME, TMPDIR and logon session.
   * Default object security remains in force; inaccessible collisions refuse. */
  wchar_t full_name[96] = L"Global\\gbrain-ipc-";
  size_t prefix = wcslen(full_name);
  for (size_t i = 0; i < 64; i++) full_name[prefix + i] = (wchar_t)name[i];
  full_name[prefix + 64] = 0;
  HANDLE handle = CreateMutexW(NULL, FALSE, full_name);
  if (!handle) { unsigned long error = GetLastError(); free(name); return fail(env, "open IPC mutex", error); }
  /* File mappings are kernel-backed, with no mutable filesystem pathname.
   * Same-thread copies share a Local record; cross-session exclusion is still
   * the Global mutex, so no Global file-mapping privilege is required. */
  wchar_t record_name[112] = L"Local\\gbrain-ipc-owner-";
  prefix = wcslen(record_name);
  for (size_t i = 0; i < 64; i++) record_name[prefix + i] = (wchar_t)name[i];
  record_name[prefix + 64] = 0;
  HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, sizeof(ipc_mutex_owner), record_name);
  if (!mapping) { unsigned long error = GetLastError(); CloseHandle(handle); free(name); return fail(env, "open IPC owner record", error); }
  ipc_mutex_owner *owner = MapViewOfFile(mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, sizeof(ipc_mutex_owner));
  if (!owner) { unsigned long error = GetLastError(); CloseHandle(mapping); CloseHandle(handle); free(name); return fail(env, "map IPC owner record", error); }
  lock_handle *lock = calloc(1, sizeof(*lock));
  if (!lock) { UnmapViewOfFile(owner); CloseHandle(mapping); CloseHandle(handle); free(name); return fail(env, "allocate", 0); }
  lock->handle = handle;
  lock->mutex_name = name;
  lock->owner = state;
  lock->mutex_owner_mapping = mapping;
  lock->mutex_owner = owner;
  napi_value object;
  if (napi_create_object(env, &object) != napi_ok ||
      napi_wrap(env, object, lock, finalize_lock, NULL, NULL) != napi_ok) {
    close_handle(lock); free(name); free(lock);
    return fail(env, "wrap IPC mutex", 0);
  }
  lock->next = state->handles;
  state->handles = lock;
  state->references++;
  return object;
}

static napi_value remove_windows_unix_socket(napi_env env, napi_callback_info info) {
  lock_state *state = NULL;
  char *path = ipc_argument(env, info, &state, true);
  if (!path) return NULL;
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  wchar_t *wide = count > 0 ? malloc((size_t)count * sizeof(wchar_t)) : NULL;
  if (!wide) { free(path); return fail(env, "encode IPC path", GetLastError()); }
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, count)) {
    unsigned long error = GetLastError(); free(path); free(wide); return fail(env, "encode IPC path", error);
  }
  free(path);
  /* Inspect the leaf itself, never a reparse target. Withhold delete sharing
   * so replacement cannot change the verified object before disposition. */
  HANDLE handle = CreateFileW(wide, DELETE | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
  unsigned long error = handle == INVALID_HANDLE_VALUE ? GetLastError() : 0;
  free(wide);
  if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
    napi_value result;
    return napi_get_boolean(env, false, &result) == napi_ok ? result : NULL;
  }
  if (error) return fail(env, "open stale IPC socket", error);
  FILE_ATTRIBUTE_TAG_INFO tag;
  /* IO_REPARSE_TAG_AF_UNIX is 0x80000023 in the Windows SDK. Other reparse
   * points, ordinary files and directories must remain untouched. */
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))) error = GetLastError();
  else if (!(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) || tag.ReparseTag != 0x80000023UL) error = ERROR_INVALID_DATA;
  if (!error) {
    FILE_DISPOSITION_INFO disposition = { .DeleteFile = TRUE };
    if (!SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition))) error = GetLastError();
  }
  if (!CloseHandle(handle) && !error) error = GetLastError();
  if (error) return fail(env, "remove stale IPC socket", error);
  napi_value result;
  return napi_get_boolean(env, true, &result) == napi_ok ? result : NULL;
}
#endif
