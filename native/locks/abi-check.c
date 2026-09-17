/* SPDX-License-Identifier: MIT — built on native macOS against the real SDK. */
#include <stddef.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <errno.h>
_Static_assert(sizeof(struct stat) == 144, "Darwin stat ABI size");
_Static_assert(offsetof(struct stat, st_mode) == 4, "Darwin stat mode offset");
_Static_assert(offsetof(struct stat, st_size) == 96, "Darwin stat size offset");
_Static_assert(O_RDWR == 2 && O_NONBLOCK == 4 && O_NOFOLLOW == 0x100 && O_CREAT == 0x200 && O_CLOEXEC == 0x1000000, "Darwin open ABI");
_Static_assert(LOCK_EX == 2 && LOCK_NB == 4 && EAGAIN == 35 && EINTR == 4 && EINVAL == 22, "Darwin lock ABI");
int main(void) { return 0; }
