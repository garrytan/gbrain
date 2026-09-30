/* SPDX-License-Identifier: MIT — built on native macOS against the real SDK. */
#include <stddef.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <errno.h>
#include <unistd.h>
#include <stdint.h>
_Static_assert(sizeof(struct stat) == 144, "Darwin stat ABI size");
_Static_assert(offsetof(struct stat, st_dev) == 0, "Darwin stat device offset");
_Static_assert(offsetof(struct stat, st_ino) == 8, "Darwin stat inode offset");
_Static_assert(offsetof(struct stat, st_mode) == 4, "Darwin stat mode offset");
_Static_assert(offsetof(struct stat, st_size) == 96, "Darwin stat size offset");
_Static_assert(O_RDWR == 2 && O_NONBLOCK == 4 && O_NOFOLLOW == 0x100 && O_CREAT == 0x200 && O_CLOEXEC == 0x1000000, "Darwin open ABI");
_Static_assert(LOCK_EX == 2 && LOCK_NB == 4 && EAGAIN == 35 && EINTR == 4 && EINVAL == 22, "Darwin lock ABI");
_Static_assert(O_RDONLY == 0 && O_WRONLY == 1 && O_EXCL == 0x800 && O_DIRECTORY == 0x100000, "Darwin export open ABI");
_Static_assert(SEEK_SET == 0 && ENOENT == 2 && EIO == 5 && ENOMEM == 12 && EEXIST == 17, "Darwin export error ABI");
_Static_assert(__builtin_types_compatible_p(__typeof__(&openat), int (*)(int, const char *, int, ...)), "openat ABI");
_Static_assert(__builtin_types_compatible_p(__typeof__(&mkdirat), int (*)(int, const char *, unsigned short)), "mkdirat ABI");
_Static_assert(__builtin_types_compatible_p(__typeof__(&linkat), int (*)(int, const char *, int, const char *, int)), "linkat ABI");
_Static_assert(__builtin_types_compatible_p(__typeof__(&unlinkat), int (*)(int, const char *, int)), "unlinkat ABI");
_Static_assert(__builtin_types_compatible_p(__typeof__(&write), long (*)(int, const void *, size_t)), "write ABI");
_Static_assert(__builtin_types_compatible_p(__typeof__(&read), long (*)(int, void *, size_t)), "read ABI");
_Static_assert(__builtin_types_compatible_p(__typeof__(&fsync), int (*)(int)), "fsync ABI");
_Static_assert(__builtin_types_compatible_p(__typeof__(&ftruncate), int (*)(int, int64_t)), "ftruncate ABI");
_Static_assert(__builtin_types_compatible_p(__typeof__(&lseek), int64_t (*)(int, int64_t, int)), "lseek ABI");
int main(void) { return 0; }
