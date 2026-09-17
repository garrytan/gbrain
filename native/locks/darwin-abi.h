/* SPDX-License-Identifier: MIT
 * Public 64-bit Darwin C ABI used by the lock binding. Keeping this narrow
 * allows reproducible cross-builds without redistributing an Apple SDK.
 * ABI source: apple-oss-distributions/xnu tag xnu-11215.81.4,
 * bsd/sys/{stat.h,fcntl.h,file.h,errno.h}. Both supported macOS ABIs are LP64.
 * Native macOS CI also compiles abi-check.c against the installed SDK.
 */
#ifndef GBRAIN_DARWIN_ABI_H
#define GBRAIN_DARWIN_ABI_H
#include <stddef.h>
#include <stdint.h>

extern void *malloc(size_t);
extern void *calloc(size_t, size_t);
extern void free(void *);
extern int snprintf(char *, size_t, const char *, ...);
extern void *memchr(const void *, int, size_t);
extern int open(const char *, int, ...);
extern int close(int);
extern int flock(int, int);
extern int *__error(void);
#define errno (*__error())
#define O_RDWR 0x0002
#define O_NONBLOCK 0x0004
#define O_NOFOLLOW 0x0100
#define O_CREAT 0x0200
#define O_CLOEXEC 0x1000000
#define LOCK_EX 2
#define LOCK_NB 4
#define EINTR 4
#define EINVAL 22
#define EAGAIN 35
#define EWOULDBLOCK EAGAIN
#define S_ISREG(mode) (((mode) & 0170000) == 0100000)
struct stat {
  int32_t st_dev;
  uint16_t st_mode;
  uint16_t st_nlink;
  uint64_t st_ino;
  uint32_t st_uid;
  uint32_t st_gid;
  int32_t st_rdev;
  int64_t times[8];
  int64_t st_size;
  int64_t st_blocks;
  int32_t st_blksize;
  uint32_t st_flags;
  uint32_t st_gen;
  int32_t spare;
  int64_t reserved[2];
};
_Static_assert(sizeof(struct stat) == 144, "Darwin stat ABI size");
_Static_assert(offsetof(struct stat, st_mode) == 4, "Darwin stat ABI mode offset");
#ifdef __x86_64__
extern int fstat(int, struct stat *) __asm("_fstat$INODE64");
#else
extern int fstat(int, struct stat *);
#endif
#endif
