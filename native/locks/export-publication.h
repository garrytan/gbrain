#ifndef GBRAIN_EXPORT_PUBLICATION_H
#define GBRAIN_EXPORT_PUBLICATION_H

#define EXPORT_MARKER ".gbrain-export-status"
#define EXPORT_INCOMPLETE "GBRAIN EXPORT INCOMPLETE\n"

typedef struct export_dir {
  os_handle handle;
  struct export_dir *parent;
#ifdef _WIN32
  wchar_t *path;
#else
  char name[256];
#endif
} export_dir;

typedef struct export_state export_state;
typedef struct export_handle {
  export_dir *root;
  os_handle marker;
  bool failed;
  bool completed;
  char temporary[64];
  struct export_handle *next;
  export_state *owner;
} export_handle;

struct export_state {
  export_handle *handles;
  size_t references;
  bool closing;
};

static unsigned long export_error(void) {
#ifdef _WIN32
  return GetLastError();
#else
  return (unsigned long)errno;
#endif
}

static unsigned long export_invalid(void) {
#ifdef _WIN32
  return ERROR_INVALID_DATA;
#else
  return EINVAL;
#endif
}

static napi_value export_fail(napi_env env, const char *action, unsigned long code) {
  char message[160];
  snprintf(message, sizeof(message), "Native export %s failed (OS error %lu)", action, code);
  napi_throw_error(env, "GBRAIN_NATIVE_EXPORT_IO", message);
  return NULL;
}

static unsigned long export_close_file(os_handle handle) {
  if (handle == INVALID_LOCK_HANDLE) return 0;
#ifdef _WIN32
  return CloseHandle(handle) ? 0 : export_error();
#else
  return close(handle) == 0 ? 0 : export_error();
#endif
}

static unsigned long export_close_dirs(export_dir *dir, export_dir *stop) {
  unsigned long error = 0;
  while (dir && dir != stop) {
    export_dir *parent = dir->parent;
    unsigned long current = export_close_file(dir->handle);
    if (!error) error = current;
#ifdef _WIN32
    free(dir->path);
#endif
    free(dir);
    dir = parent;
  }
  return error;
}

static unsigned long export_flush(os_handle handle) {
#ifdef _WIN32
  return FlushFileBuffers(handle) ? 0 : export_error();
#else
  int result;
  do { result = fsync(handle); } while (result != 0 && errno == EINTR);
  return result == 0 ? 0 : export_error();
#endif
}

static unsigned long export_flush_dir(export_dir *dir) {
#ifdef _WIN32
  (void)dir;
  return 0;
#else
  return export_flush(dir->handle);
#endif
}

static unsigned long export_verify(export_handle *handle, export_dir *dir) {
#ifdef _WIN32
  (void)handle; (void)dir;
  return 0;
#else
  for (; dir; dir = dir->parent) {
    int current = dir->parent ? openat(dir->parent->handle, dir->name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                              : open(dir->name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (current < 0) return export_error();
    struct stat retained_info, current_info;
    unsigned long error = 0;
    if (fstat(dir->handle, &retained_info) != 0 || fstat(current, &current_info) != 0) error = export_error();
    else if (retained_info.st_dev != current_info.st_dev || retained_info.st_ino != current_info.st_ino) error = export_invalid();
    unsigned long close_error = export_close_file(current);
    if (error || close_error) return error ? error : close_error;
  }
  int marker = openat(handle->root->handle, EXPORT_MARKER, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (marker < 0) return export_error();
  struct stat retained_info, current_info;
  unsigned long error = 0;
  if (fstat(handle->marker, &retained_info) != 0 || fstat(marker, &current_info) != 0) error = export_error();
  else if (!S_ISREG(current_info.st_mode) || retained_info.st_dev != current_info.st_dev ||
           retained_info.st_ino != current_info.st_ino) error = export_invalid();
  unsigned long close_error = export_close_file(marker);
  return error ? error : close_error;
#endif
}

static unsigned long export_write(os_handle handle, const void *data, size_t length) {
  const char *cursor = data;
  while (length) {
    size_t amount = length > 0x40000000 ? 0x40000000 : length;
#ifdef _WIN32
    DWORD written = 0;
    if (!WriteFile(handle, cursor, (DWORD)amount, &written, NULL)) return export_error();
#else
    long written = write(handle, cursor, amount);
    if (written < 0) { if (errno == EINTR) continue; return export_error(); }
#endif
    if (!written) return export_invalid();
    cursor += written;
    length -= (size_t)written;
  }
  return export_flush(handle);
}

static bool export_component(const char *name) {
  size_t length = strlen(name);
  if (!length || length > 255 || name[length - 1] == '.' || name[length - 1] == ' ') return false;
  char stem[8] = {0};
  size_t stem_length = 0;
  for (size_t i = 0; i < length; i++) {
    unsigned char c = (unsigned char)name[i];
    if (c < 32 || c == 127 || strchr("\\/:*?\"<>|", c)) return false;
    if (c != '.' && stem_length == i && stem_length < sizeof(stem) - 1)
      stem[stem_length++] = c >= 'a' && c <= 'z' ? (char)(c - 32) : (char)c;
  }
  if (!strcmp(stem, "CON") || !strcmp(stem, "PRN") || !strcmp(stem, "AUX") || !strcmp(stem, "NUL")) return false;
  if (stem[0] == 'C' && stem[1] == 'O' && stem[2] == 'M') {
    if ((stem_length == 4 && stem[3] >= '1' && stem[3] <= '9') ||
        (stem_length == 5 && (unsigned char)stem[3] == 0xc2 &&
          ((unsigned char)stem[4] == 0xb9 || (unsigned char)stem[4] == 0xb2 || (unsigned char)stem[4] == 0xb3))) return false;
  }
  if (stem[0] == 'L' && stem[1] == 'P' && stem[2] == 'T') {
    if ((stem_length == 4 && stem[3] >= '1' && stem[3] <= '9') ||
        (stem_length == 5 && (unsigned char)stem[3] == 0xc2 &&
          ((unsigned char)stem[4] == 0xb9 || (unsigned char)stem[4] == 0xb2 || (unsigned char)stem[4] == 0xb3))) return false;
  }
  return true;
}

static char *export_string(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || !length || length > 32768) return NULL;
  char *text = malloc(length + 1);
  if (!text) return NULL;
  if (napi_get_value_string_utf8(env, value, text, length + 1, &length) != napi_ok || memchr(text, 0, length)) {
    free(text); return NULL;
  }
  return text;
}

#ifdef _WIN32
static wchar_t *export_wide(const char *text) {
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, NULL, 0);
  wchar_t *wide = length > 0 ? malloc((size_t)length * sizeof(wchar_t)) : NULL;
  if (!wide) return NULL;
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, wide, length)) { free(wide); return NULL; }
  return wide;
}

static wchar_t *export_child_path(export_dir *parent, const char *name) {
  wchar_t *leaf = export_wide(name);
  if (!leaf) return NULL;
  size_t a = wcslen(parent->path), b = wcslen(leaf);
  wchar_t *path = malloc((a + b + 2) * sizeof(wchar_t));
  if (path) {
    memcpy(path, parent->path, a * sizeof(wchar_t));
    path[a] = L'\\';
    memcpy(path + a + 1, leaf, (b + 1) * sizeof(wchar_t));
  }
  free(leaf);
  return path;
}
#endif

static export_dir *export_open_dir(export_dir *parent, const char *name, unsigned long *error) {
  export_dir *dir = calloc(1, sizeof(*dir));
  if (!dir) { *error = export_invalid(); return NULL; }
  dir->handle = INVALID_LOCK_HANDLE;
  dir->parent = parent;
#ifdef _WIN32
  dir->path = parent ? export_child_path(parent, name) : export_wide(name);
  if (!dir->path) { *error = export_invalid(); goto failed; }
  dir->handle = CreateFileW(dir->path, FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (dir->handle == INVALID_LOCK_HANDLE && parent && GetLastError() == ERROR_FILE_NOT_FOUND) {
    if (!CreateDirectoryW(dir->path, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) { *error = export_error(); goto failed; }
    dir->handle = CreateFileW(dir->path, FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  }
  if (dir->handle == INVALID_LOCK_HANDLE) { *error = export_error(); goto failed; }
  BY_HANDLE_FILE_INFORMATION info;
  if (!GetFileInformationByHandle(dir->handle, &info)) { *error = export_error(); goto failed; }
  if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    *error = export_invalid(); goto failed;
  }
#else
  size_t name_length = strlen(name);
  if (name_length >= sizeof(dir->name)) { *error = export_invalid(); goto failed; }
  memcpy(dir->name, name, name_length + 1);
  dir->handle = parent ? openat(parent->handle, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                      : open(name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (dir->handle < 0 && parent && errno == ENOENT) {
    if (mkdirat(parent->handle, name, 0700) != 0 && errno != EEXIST) { *error = export_error(); goto failed; }
    if ((*error = export_flush_dir(parent))) goto failed;
    dir->handle = openat(parent->handle, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  }
  if (dir->handle < 0) { *error = export_error(); goto failed; }
#endif
  return dir;
failed:
  export_close_dirs(dir, parent);
  return NULL;
}

static export_dir *export_walk(export_dir *start, char *path, char **leaf, unsigned long *error) {
  export_dir *dir = start;
  char *cursor = path;
  unsigned depth = 0;
  for (;;) {
    char *slash = strchr(cursor, '/');
    if (slash) *slash = 0;
    if (++depth > 256 || !export_component(cursor)) { *error = export_invalid(); break; }
    if (!slash && leaf) { *leaf = cursor; return dir; }
    export_dir *next = export_open_dir(dir, cursor, error);
    if (!next) break;
    dir = next;
    if (!slash) return dir;
    cursor = slash + 1;
  }
  export_close_dirs(dir, start);
  return NULL;
}

static os_handle export_create(export_dir *parent, const char *name, unsigned long *error) {
  os_handle handle;
#ifdef _WIN32
  wchar_t *path = export_child_path(parent, name);
  if (!path) { *error = export_invalid(); return INVALID_LOCK_HANDLE; }
  handle = CreateFileW(path, GENERIC_WRITE | DELETE, FILE_SHARE_READ, NULL, CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
  free(path);
#else
  handle = openat(parent->handle, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
#endif
  if (handle == INVALID_LOCK_HANDLE) *error = export_error();
  return handle;
}

static unsigned long export_remove_temp(export_dir *parent, const char *name, os_handle handle) {
#ifdef _WIN32
  (void)parent; (void)name;
  FILE_DISPOSITION_INFO disposition = { .DeleteFile = TRUE };
  return SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition)) ? 0 : export_error();
#else
  (void)handle;
  return unlinkat(parent->handle, name, 0) == 0 ? 0 : export_error();
#endif
}

static unsigned long export_publish(export_dir *parent, const char *temporary, const char *leaf, os_handle handle) {
#ifdef _WIN32
  (void)temporary;
  wchar_t *wide = export_child_path(parent, leaf);
  if (!wide) return export_invalid();
  size_t bytes = wcslen(wide) * sizeof(wchar_t);
  size_t size = sizeof(FILE_RENAME_INFO) + bytes;
  FILE_RENAME_INFO *rename = calloc(1, size);
  if (!rename) { free(wide); return export_invalid(); }
  rename->ReplaceIfExists = FALSE;
  rename->RootDirectory = NULL;
  rename->FileNameLength = (DWORD)bytes;
  memcpy(rename->FileName, wide, bytes);
  unsigned long error = SetFileInformationByHandle(handle, FileRenameInfo, rename, (DWORD)size) ? 0 : export_error();
  free(rename); free(wide);
  return error;
#else
  (void)handle;
  return linkat(parent->handle, temporary, parent->handle, leaf, 0) == 0 ? 0 : export_error();
#endif
}

static unsigned long export_nonce(char *output) {
  unsigned char bytes[16];
#ifdef _WIN32
  if (BCryptGenRandom(NULL, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) return export_invalid();
#else
  int fd = open("/dev/urandom", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return export_error();
  size_t offset = 0;
  unsigned long error = 0;
  while (offset < sizeof(bytes)) {
    long count = read(fd, bytes + offset, sizeof(bytes) - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { error = count < 0 ? export_error() : export_invalid(); break; }
    offset += (size_t)count;
  }
  unsigned long close_error = export_close_file(fd);
  if (error || close_error) return error ? error : close_error;
#endif
  for (size_t i = 0; i < sizeof(bytes); i++) snprintf(output + i * 2, 3, "%02x", bytes[i]);
  return 0;
}

static unsigned long export_close(export_handle *handle) {
  unsigned long error = export_close_file(handle->marker);
  handle->marker = INVALID_LOCK_HANDLE;
  unsigned long dir_error = export_close_dirs(handle->root, NULL);
  handle->root = NULL;
  return error ? error : dir_error;
}

static void export_release_state(export_state *state) {
  if (--state->references == 0) free(state);
}

static void export_finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  export_handle *handle = data;
  export_state *state = handle->owner;
  export_close(handle);
  export_handle **cursor = &state->handles;
  while (*cursor && *cursor != handle) cursor = &(*cursor)->next;
  if (*cursor) *cursor = handle->next;
  free(handle);
  export_release_state(state);
}

static void export_cleanup(void *data) {
  export_state *state = data;
  state->closing = true;
  for (export_handle *handle = state->handles; handle; handle = handle->next) export_close(handle);
  export_release_state(state);
}

static export_handle *export_get(napi_env env, napi_callback_info info, size_t count, napi_value *argv) {
  size_t argc = count;
  export_state *state = NULL;
  void *pointer = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, (void **)&state) == napi_ok && argc > 0 &&
      napi_unwrap(env, argv[0], &pointer) == napi_ok) {
    for (export_handle *handle = state->handles; handle; handle = handle->next) if (handle == pointer) {
      if (argc == count) return handle;
      handle->failed = true;
      break;
    }
  }
  napi_throw_type_error(env, "GBRAIN_NATIVE_EXPORT_HANDLE", "Expected this addon's opaque export handle");
  return NULL;
}

static napi_value export_undefined(napi_env env) {
  napi_value result;
  return napi_get_undefined(env, &result) == napi_ok ? result : NULL;
}

static napi_value begin_export(napi_env env, napi_callback_info info) {
  napi_value argv[1], object;
  size_t argc = 1;
  export_state *state = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, (void **)&state) != napi_ok || argc != 1) return export_fail(env, "arguments", 0);
  char *path = export_string(env, argv[0]);
  if (!path) return export_fail(env, "destination", 0);
  unsigned long error = 0;
  export_dir *base = NULL, *root = NULL;
  export_handle *handle = NULL;
  if (state->closing) { error = export_invalid(); goto failed; }
#ifdef _WIN32
  size_t path_length = strlen(path);
  if (path_length < 3 || !((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) ||
      path[1] != ':' || (path[2] != '/' && path[2] != '\\')) { error = export_invalid(); goto failed; }
  for (char *p = path + 2; *p; p++) if (*p == '\\') *p = '/';
  char drive[] = "C:\\";
  drive[0] = path[0];
  base = export_open_dir(NULL, drive, &error);
  char *relative = path + 3;
#else
  if (path[0] != '/') { error = export_invalid(); goto failed; }
  base = export_open_dir(NULL, "/", &error);
  char *relative = path + 1;
#endif
  if (!base) goto failed;
  root = *relative ? export_walk(base, relative, NULL, &error) : base;
  if (!root) goto failed;
  handle = calloc(1, sizeof(*handle));
  if (!handle) { error = export_invalid(); goto failed; }
  handle->marker = INVALID_LOCK_HANDLE;
  handle->root = root;
  handle->owner = state;
  char nonce[33];
  if ((error = export_nonce(nonce))) goto failed;
  snprintf(handle->temporary, sizeof(handle->temporary), ".gbrain-export-%s.tmp", nonce);
  handle->marker = export_create(root, EXPORT_MARKER, &error);
  if (handle->marker == INVALID_LOCK_HANDLE) goto failed;
  if ((error = export_write(handle->marker, EXPORT_INCOMPLETE, sizeof(EXPORT_INCOMPLETE) - 1)) ||
      (error = export_flush_dir(root))) goto failed;
  if (napi_create_object(env, &object) != napi_ok || napi_wrap(env, object, handle, export_finalize, NULL, NULL) != napi_ok) {
    error = export_invalid(); goto failed;
  }
  handle->next = state->handles;
  state->handles = handle;
  state->references++;
  free(path);
  return object;
failed:
  if (handle) { export_close(handle); free(handle); }
  else export_close_dirs(root ? root : base, NULL);
  free(path);
  return export_fail(env, "begin", error);
}

static napi_value publish_export_file(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  export_handle *handle = export_get(env, info, 3, argv);
  if (!handle) return NULL;
  if (!handle->root || handle->failed || handle->completed) return export_fail(env, "inactive handle", 0);
  char *path = export_string(env, argv[1]);
  void *data = NULL;
  size_t length = 0;
  bool buffer = false;
  unsigned long error = 0;
  export_dir *parent = NULL;
  os_handle temporary = INVALID_LOCK_HANDLE;
  bool published = false;
  if ((error = export_verify(handle, handle->root))) goto failed;
  if (!path || !strcmp(path, EXPORT_MARKER) ||
      napi_is_buffer(env, argv[2], &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, argv[2], &data, &length) != napi_ok) { error = export_invalid(); goto failed; }
  char *leaf = NULL;
  parent = export_walk(handle->root, path, &leaf, &error);
  if (!parent) goto failed;
  temporary = export_create(parent, handle->temporary, &error);
  if (temporary == INVALID_LOCK_HANDLE) goto failed;
  if ((error = export_write(temporary, data, length))) goto failed;
  if ((error = export_verify(handle, parent))) goto failed;
  if ((error = export_publish(parent, handle->temporary, leaf, temporary))) goto failed;
  published = true;
#ifndef _WIN32
  if ((error = export_remove_temp(parent, handle->temporary, temporary))) goto failed;
#endif
  if ((error = export_flush_dir(parent))) goto failed;
failed:
  if (temporary != INVALID_LOCK_HANDLE) {
    if (!published) {
      unsigned long remove_error = export_remove_temp(parent, handle->temporary, temporary);
      if (!error) error = remove_error;
    }
    unsigned long close_error = export_close_file(temporary);
    if (!error) error = close_error;
  }
  unsigned long close_error = export_close_dirs(parent, handle->root);
  if (!error) error = close_error;
  free(path);
  if (error) { handle->failed = true; return export_fail(env, "publish", error); }
  return export_undefined(env);
}

static void export_uncomplete(export_handle *handle) {
#ifdef _WIN32
  LARGE_INTEGER offset;
  offset.QuadPart = sizeof(EXPORT_INCOMPLETE) - 1;
  if (SetFilePointerEx(handle->marker, offset, NULL, FILE_BEGIN)) SetEndOfFile(handle->marker);
#else
  ftruncate(handle->marker, sizeof(EXPORT_INCOMPLETE) - 1);
  lseek(handle->marker, sizeof(EXPORT_INCOMPLETE) - 1, SEEK_SET);
#endif
  export_flush(handle->marker);
}

static napi_value complete_export(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  export_handle *handle = export_get(env, info, 1, argv);
  if (!handle) return NULL;
  if (!handle->root || handle->failed || handle->completed) return export_fail(env, "inactive handle", 0);
  unsigned long error = export_verify(handle, handle->root);
  if (!error) error = export_flush_dir(handle->root);
  if (error) {
    handle->failed = true;
    return export_fail(env, "complete", error);
  }
  error = export_write(handle->marker, "COMPLETE\n", 9);
  if (error) {
    handle->failed = true;
    export_uncomplete(handle);
    return export_fail(env, "complete", error);
  }
  handle->completed = true;
  return export_undefined(env);
}

static napi_value close_export(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  export_handle *handle = export_get(env, info, 1, argv);
  if (!handle) return NULL;
  unsigned long error = export_close(handle);
  if (error) return export_fail(env, "close", error);
  return export_undefined(env);
}

#endif
