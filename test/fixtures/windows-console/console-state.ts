/**
 * Console probe for test/windows-hidden-console.test.ts (Windows only).
 *
 * `consoleState()` reports whether this process has a console and whether that
 * console's window is visible. Run as a program, it writes that state as JSON
 * to $GBRAIN_TEST_CONSOLE_STATE_OUT. The test compiles it to a console .exe,
 * the same kind of binary as gbrain.exe and git.exe, so it also stands in for
 * git on PATH.
 */
import { dlopen, FFIType } from 'bun:ffi';
import { writeFileSync } from 'node:fs';

export function consoleState(): { console: boolean; visibleWindow: boolean } {
  const kernel32 = dlopen('kernel32.dll', {
    GetConsoleWindow: { args: [], returns: FFIType.ptr },
    GetConsoleProcessList: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  });
  const user32 = dlopen('user32.dll', { IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 } });
  const window = kernel32.symbols.GetConsoleWindow();
  return {
    console: kernel32.symbols.GetConsoleProcessList(new Uint32Array(8), 8) > 0,
    visibleWindow: !!window && user32.symbols.IsWindowVisible(window) !== 0,
  };
}

if (import.meta.main) writeFileSync(process.env.GBRAIN_TEST_CONSOLE_STATE_OUT!, JSON.stringify(consoleState()));
