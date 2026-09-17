/* SPDX-License-Identifier: MIT
 * Small Node-API v3 binding. All OS handles stay native; acquisition never waits.
 * The stable lock file must live in a directory controlled by the owner host.
 */
#include "node_api.h"
#include <stdbool.h>
#include <stdint.h>
#ifdef __APPLE__
#include "darwin-abi.h"
#else
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#endif

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "windows-napi.h"
typedef HANDLE os_handle;
#define INVALID_LOCK_HANDLE INVALID_HANDLE_VALUE
#else
#ifndef __APPLE__
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif
typedef int os_handle;
#define INVALID_LOCK_HANDLE (-1)
#endif

typedef struct lock_state lock_state;
#ifdef _WIN32
typedef struct ipc_mutex_owner { DWORD process_id; DWORD thread_id; } ipc_mutex_owner;
#endif
typedef struct lock_handle {
  os_handle handle;
  bool locked;
#ifdef _WIN32
  char *mutex_name;
  DWORD owning_thread;
  HANDLE mutex_owner_mapping;
  volatile ipc_mutex_owner *mutex_owner;
  bool finalized;
#endif
  struct lock_handle *next;
  lock_state *owner;
} lock_handle;

struct lock_state {
  lock_handle *handles;
  size_t references;
  bool closing;
};

static napi_value fail(napi_env env, const char *action, unsigned long code) {
  char message[128];
  snprintf(message, sizeof(message), "Native lock %s failed (OS error %lu)", action, code);
  napi_throw_error(env, "GBRAIN_NATIVE_LOCK_IO", message);
  return NULL;
}

/* Do not retry close on EINTR: on Linux the descriptor has already closed,
 * and retrying can close an unrelated, newly reused descriptor. */
static unsigned long close_handle(lock_handle *lock) {
  if (lock->handle == INVALID_LOCK_HANDLE) return 0;
#ifdef _WIN32
  if (lock->mutex_name && lock->locked) {
    /* Mutex release is thread-affine. NAPI handles cannot leave their owning
     * environment; an unexpected finalizer thread must not pretend to close. */
    if (lock->owning_thread != GetCurrentThreadId()) return ERROR_NOT_OWNER;
    lock->mutex_owner->process_id = 0;
    lock->mutex_owner->thread_id = 0;
    if (!ReleaseMutex(lock->handle)) {
      lock->mutex_owner->process_id = GetCurrentProcessId();
      lock->mutex_owner->thread_id = lock->owning_thread;
      return GetLastError();
    }
  }
#endif
  os_handle handle = lock->handle;
  lock->handle = INVALID_LOCK_HANDLE;
  lock->locked = false;
#ifdef _WIN32
  unsigned long error = CloseHandle(handle) ? 0 : GetLastError();
  if (lock->mutex_owner && !UnmapViewOfFile((const void *)lock->mutex_owner) && !error) error = GetLastError();
  if (lock->mutex_owner_mapping && !CloseHandle(lock->mutex_owner_mapping) && !error) error = GetLastError();
  lock->mutex_owner = NULL;
  lock->mutex_owner_mapping = NULL;
  return error;
#else
  return close(handle) == 0 ? 0 : (unsigned long)errno;
#endif
}

static void release_state(lock_state *state) {
  if (--state->references == 0) free(state);
}

static void finalize_lock(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  lock_handle *lock = data;
  lock_state *state = lock->owner;
#ifdef _WIN32
  /* A failed release must retain both its handle and registry reference for
   * owning-environment cleanup; never free the only tracked unreleased lock. */
  if (close_handle(lock) != 0) { lock->finalized = true; return; }
#else
  close_handle(lock);
#endif
  lock_handle **cursor = &state->handles;
  while (*cursor && *cursor != lock) cursor = &(*cursor)->next;
  if (*cursor) *cursor = lock->next;
#ifdef _WIN32
  free(lock->mutex_name);
#endif
  free(lock);
  release_state(state);
}

static void cleanup(void *data) {
  lock_state *state = data;
  state->closing = true;
#ifdef _WIN32
  lock_handle **cursor = &state->handles;
  while (*cursor) {
    lock_handle *lock = *cursor;
    unsigned long error = close_handle(lock);
    if (lock->finalized && !error) {
      *cursor = lock->next;
      free(lock->mutex_name); free(lock);
      release_state(state);
    } else cursor = &lock->next;
  }
#else
  for (lock_handle *lock = state->handles; lock; lock = lock->next) close_handle(lock);
#endif
  release_state(state);
}

static lock_handle *get_lock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  lock_state *state = NULL;
  void *pointer = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, (void **)&state) != napi_ok ||
      argc != 1 || napi_unwrap(env, argv[0], &pointer) != napi_ok) {
    napi_throw_type_error(env, "GBRAIN_NATIVE_LOCK_HANDLE", "Expected an opaque native lock handle");
    return NULL;
  }
  /* Compare against our registry before dereferencing: an object wrapped by
   * another addon is not one of our handles. */
  for (lock_handle *lock = state->handles; lock; lock = lock->next) {
    if (lock == pointer) return lock;
  }
  napi_throw_type_error(env, "GBRAIN_NATIVE_LOCK_HANDLE", "Foreign native lock handle");
  return NULL;
}

static napi_value open_lock(napi_env env, napi_callback_info info) {
  size_t argc = 1, length = 0;
  napi_value argv[1], object;
  lock_state *state = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, (void **)&state) != napi_ok ||
      argc != 1 || napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok ||
      length == 0 || length > 131072) {
    napi_throw_type_error(env, "GBRAIN_NATIVE_LOCK_PATH", "Expected a nonempty lock path");
    return NULL;
  }
  if (state->closing) return fail(env, "open during shutdown", 0);
  char *path = malloc(length + 1);
  if (!path) return fail(env, "allocate", 0);
  if (napi_get_value_string_utf8(env, argv[0], path, length + 1, &length) != napi_ok ||
      memchr(path, 0, length) != NULL) {
    free(path);
    napi_throw_type_error(env, "GBRAIN_NATIVE_LOCK_PATH", "Lock paths must not contain NUL");
    return NULL;
  }
  os_handle handle;
  unsigned long error = 0;
#ifdef _WIN32
  int wide_length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  wchar_t *wide = wide_length > 0 ? malloc((size_t)wide_length * sizeof(wchar_t)) : NULL;
  if (!wide) { free(path); return fail(env, "encode path", GetLastError()); }
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, wide_length);
  /* Sharing read/write lets contenders open the SAME file. Do not share
   * delete: renaming/replacing this inode while it is held breaks exclusion. */
  handle = CreateFileW(wide, GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_LOCK_HANDLE) error = GetLastError();
  if (!error) {
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(handle, &info)) error = GetLastError();
    else if (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) error = ERROR_INVALID_DATA;
  }
  free(wide);
#else
  handle = open(path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  if (handle == INVALID_LOCK_HANDLE) error = (unsigned long)errno;
  if (!error) {
    struct stat info;
    if (fstat(handle, &info) != 0) error = (unsigned long)errno;
    else if (!S_ISREG(info.st_mode)) error = EINVAL;
  }
#endif
  free(path);
  lock_handle *lock = calloc(1, sizeof(*lock));
  if (!lock) {
    lock_handle temporary = { .handle = handle };
    close_handle(&temporary);
    return fail(env, "allocate", 0);
  }
  lock->handle = handle;
  lock->owner = state;
  if (error || napi_create_object(env, &object) != napi_ok) {
    close_handle(lock); free(lock);
    return fail(env, "open", error);
  }
  if (napi_wrap(env, object, lock, finalize_lock, NULL, NULL) != napi_ok) {
    close_handle(lock); free(lock);
    return fail(env, "wrap", 0);
  }
  lock->next = state->handles;
  state->handles = lock;
  state->references++;
  return object;
}

#ifdef _WIN32
#include "windows-ipc.h"
#endif

static napi_value try_lock(napi_env env, napi_callback_info info) {
  lock_handle *lock = get_lock(env, info);
  if (!lock) return NULL;
  if (lock->handle == INVALID_LOCK_HANDLE) return fail(env, "acquire closed handle", 0);
  bool acquired = lock->locked;
  if (!acquired) {
#ifdef _WIN32
    if (lock->mutex_name) {
      /* Windows mutexes recurse for their owning thread. Refuse a separate
       * handle in this environment before asking the kernel to acquire. */
      for (lock_handle *other = lock->owner->handles; other; other = other->next) {
        if (other != lock && other->locked && other->mutex_name &&
            strcmp(other->mutex_name, lock->mutex_name) == 0) goto lock_result;
      }
      DWORD result = WaitForSingleObject(lock->handle, 0);
      if (result == WAIT_OBJECT_0 || result == WAIT_ABANDONED) {
        /* A copied DLL has another environment registry on the same thread.
         * Kernel-backed owner metadata makes recursion visible across copies.
         * An abandoned owner's metadata cannot veto the kernel's handoff. */
        if (result == WAIT_OBJECT_0 && lock->mutex_owner->process_id == GetCurrentProcessId() &&
            lock->mutex_owner->thread_id == GetCurrentThreadId()) {
          if (!ReleaseMutex(lock->handle)) return fail(env, "undo recursive IPC mutex", GetLastError());
          goto lock_result;
        }
        lock->mutex_owner->process_id = GetCurrentProcessId();
        lock->mutex_owner->thread_id = GetCurrentThreadId();
        acquired = true;
        lock->owning_thread = GetCurrentThreadId();
      } else if (result != WAIT_TIMEOUT) return fail(env, "acquire IPC mutex", GetLastError());
    } else {
    OVERLAPPED offset = {0};
    acquired = LockFileEx(lock->handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
        0, 1, 0, &offset) != 0;
    if (!acquired) {
      DWORD error = GetLastError();
      if (error != ERROR_LOCK_VIOLATION) return fail(env, "acquire", error);
    }
    }
#else
    acquired = flock(lock->handle, LOCK_EX | LOCK_NB) == 0;
    if (!acquired && errno != EWOULDBLOCK && errno != EAGAIN && errno != EINTR)
      return fail(env, "acquire", (unsigned long)errno);
#endif
  }
#ifdef _WIN32
lock_result:
#endif
  lock->locked = acquired;
  napi_value result;
  if (napi_get_boolean(env, acquired, &result) != napi_ok) return NULL;
  return result;
}

static napi_value close_lock(napi_env env, napi_callback_info info) {
  lock_handle *lock = get_lock(env, info);
  if (!lock) return NULL;
  unsigned long error = close_handle(lock);
  if (error) return fail(env, "close", error);
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}

NAPI_MODULE_INIT() {
#ifdef _WIN32
  /* Missing exports reject registration before any Node-API call. */
  if (!gbrain_initialize_napi()) return NULL;
#endif
  lock_state *state = calloc(1, sizeof(*state));
  if (!state) return fail(env, "allocate", 0);
  state->references = 1;
  if (napi_add_env_cleanup_hook(env, cleanup, state) != napi_ok) {
    free(state); return fail(env, "register cleanup", 0);
  }
  const napi_property_descriptor properties[] = {
    {"openLock", NULL, open_lock, NULL, NULL, NULL, napi_default, state},
    {"tryLock", NULL, try_lock, NULL, NULL, NULL, napi_default, state},
    {"close", NULL, close_lock, NULL, NULL, NULL, napi_default, state},
#ifdef _WIN32
    {"openIpcMutex", NULL, open_ipc_mutex, NULL, NULL, NULL, napi_default, state},
    {"removeWindowsUnixSocket", NULL, remove_windows_unix_socket, NULL, NULL, NULL, napi_default, state},
#endif
  };
  napi_value target;
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok ||
      napi_create_string_utf8(env, GBRAIN_NATIVE_TARGET, NAPI_AUTO_LENGTH, &target) != napi_ok ||
      napi_set_named_property(env, exports, "target", target) != napi_ok) return NULL;
  return exports;
}
