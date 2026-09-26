param([string]$First, [string]$Second)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PipeCaseProbe {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  public static extern int CompareStringOrdinal(string first, int firstLength, string second, int secondLength, bool ignoreCase);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern int LCMapStringEx(string locale, uint flags, string source, int sourceLength, StringBuilder destination, int destinationLength, IntPtr version, IntPtr reserved, IntPtr sort);
  [DllImport("ntdll.dll", ExactSpelling = true)]
  private static extern ushort RtlUpcaseUnicodeChar(ushort value);
  public static string NtUpper(string value) {
    char[] result = value.ToCharArray();
    for (int i = 0; i < result.Length; i++) result[i] = (char)RtlUpcaseUnicodeChar(result[i]);
    return new string(result);
  }
  public static string LocaleUpper(string value) {
    var result = new StringBuilder(value.Length * 2 + 1);
    if (LCMapStringEx("", 0x200, value, -1, result, result.Capacity, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero) == 0)
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return result.ToString();
  }
  public static string Hex(string value) {
    return BitConverter.ToString(Encoding.Unicode.GetBytes(value)).Replace("-", "");
  }
}
'@
@{
  ordinal_result = [PipeCaseProbe]::CompareStringOrdinal($First, $First.Length, $Second, $Second.Length, $true)
  first_utf16 = [PipeCaseProbe]::Hex($First)
  second_utf16 = [PipeCaseProbe]::Hex($Second)
  first_nt_upper = [PipeCaseProbe]::Hex([PipeCaseProbe]::NtUpper($First))
  second_nt_upper = [PipeCaseProbe]::Hex([PipeCaseProbe]::NtUpper($Second))
  first_locale_upper = [PipeCaseProbe]::Hex([PipeCaseProbe]::LocaleUpper($First))
  second_locale_upper = [PipeCaseProbe]::Hex([PipeCaseProbe]::LocaleUpper($Second))
} | ConvertTo-Json -Compress
