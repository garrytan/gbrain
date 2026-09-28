#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int staged_write;

static int export_file(int fd, const char *suffix) {
  char link[64], path[4096];
  snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
  ssize_t size = readlink(link, path, sizeof(path) - 1);
  if (size < 0) return 0;
  path[size] = 0;
  size_t suffix_length = strlen(suffix);
  return (size_t)size >= suffix_length && strcmp(path + size - suffix_length, suffix) == 0;
}

ssize_t write(int fd, const void *data, size_t size) {
  ssize_t (*real_write)(int, const void *, size_t) = dlsym(RTLD_NEXT, "write");
  const char *mode = getenv("GBRAIN_EXPORT_TEST_FAULT");
  if (mode && export_file(fd, ".tmp")) {
    staged_write = 1;
    if (!strcmp(mode, "write")) { errno = ENOSPC; return -1; }
    if (!strcmp(mode, "short-write")) {
      static int interrupted;
      if (!interrupted++) { errno = EINTR; return -1; }
      return real_write(fd, data, size > 7 ? 7 : size);
    }
    if (!strcmp(mode, "crash")) {
      real_write(fd, data, size > 16 ? 16 : size);
      kill(getpid(), SIGKILL);
    }
  }
  return real_write(fd, data, size);
}

int fsync(int fd) {
  int (*real_fsync)(int) = dlsym(RTLD_NEXT, "fsync");
  const char *mode = getenv("GBRAIN_EXPORT_TEST_FAULT");
  if (mode && !strcmp(mode, "flush") && export_file(fd, ".tmp")) { errno = EIO; return -1; }
  struct stat info;
  if (mode && !strcmp(mode, "directory-flush") && staged_write && fstat(fd, &info) == 0 && S_ISDIR(info.st_mode)) {
    errno = EIO;
    return -1;
  }
  static unsigned marker_flushes = 0;
  if (mode && !strcmp(mode, "complete-flush") && export_file(fd, ".gbrain-export-status") && ++marker_flushes == 2) {
    errno = EIO;
    return -1;
  }
  return real_fsync(fd);
}
