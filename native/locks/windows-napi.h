/* SPDX-License-Identifier: MIT
 * Bind Node-API to the executable that created the environment. A normal
 * node.exe import can load a different runtime into Bun (or a compiled CLI).
 */
#ifndef GBRAIN_WINDOWS_NAPI_H
#define GBRAIN_WINDOWS_NAPI_H

#include <windows.h>
#include "node_api.h"

#define GBRAIN_NAPI_SYMBOLS(X) \
  X(napi_get_cb_info) \
  X(napi_unwrap) \
  X(napi_throw_type_error) \
  X(napi_throw_error) \
  X(napi_get_value_string_utf8) \
  X(napi_create_object) \
  X(napi_wrap) \
  X(napi_get_boolean) \
  X(napi_get_undefined) \
  X(napi_add_env_cleanup_hook) \
  X(napi_define_properties) \
  X(napi_create_string_utf8) \
  X(napi_set_named_property)

typedef struct {
#define GBRAIN_NAPI_DECLARE(name) __typeof__(&name) name;
  GBRAIN_NAPI_SYMBOLS(GBRAIN_NAPI_DECLARE)
#undef GBRAIN_NAPI_DECLARE
} gbrain_napi_api;

static INIT_ONCE gbrain_napi_once = INIT_ONCE_STATIC_INIT;
static gbrain_napi_api gbrain_napi;

static BOOL CALLBACK gbrain_bind_napi(PINIT_ONCE once, PVOID parameter, PVOID *context) {
  (void)once; (void)parameter; (void)context;
  HMODULE executable = GetModuleHandleW(NULL);
  if (!executable) return FALSE;
  gbrain_napi_api resolved = {0};
#define GBRAIN_NAPI_RESOLVE(name) \
  resolved.name = (__typeof__(resolved.name))GetProcAddress(executable, #name); \
  if (!resolved.name) return FALSE;
  GBRAIN_NAPI_SYMBOLS(GBRAIN_NAPI_RESOLVE)
#undef GBRAIN_NAPI_RESOLVE
  /* Publish only the complete table. InitOnce supplies the cross-thread
   * barrier; module registrations never share an environment or its handles. */
  gbrain_napi = resolved;
  return TRUE;
}

static bool gbrain_initialize_napi(void) {
  return InitOnceExecuteOnce(&gbrain_napi_once, gbrain_bind_napi, NULL, NULL) != 0;
}

#define napi_get_cb_info gbrain_napi.napi_get_cb_info
#define napi_unwrap gbrain_napi.napi_unwrap
#define napi_throw_type_error gbrain_napi.napi_throw_type_error
#define napi_throw_error gbrain_napi.napi_throw_error
#define napi_get_value_string_utf8 gbrain_napi.napi_get_value_string_utf8
#define napi_create_object gbrain_napi.napi_create_object
#define napi_wrap gbrain_napi.napi_wrap
#define napi_get_boolean gbrain_napi.napi_get_boolean
#define napi_get_undefined gbrain_napi.napi_get_undefined
#define napi_add_env_cleanup_hook gbrain_napi.napi_add_env_cleanup_hook
#define napi_define_properties gbrain_napi.napi_define_properties
#define napi_create_string_utf8 gbrain_napi.napi_create_string_utf8
#define napi_set_named_property gbrain_napi.napi_set_named_property
#undef GBRAIN_NAPI_SYMBOLS
#endif
