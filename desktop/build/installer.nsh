!macro customInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "PMBrain requires 64-bit Windows 10 version 1809 or later, or Windows 11."
    Quit
  ${EndIf}

  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $0 != ""
  ${AndIf} $0 < 17763
    MessageBox MB_OK|MB_ICONSTOP "This Windows 10 build is too old. Update to version 1809 or later before installing PMBrain."
    Quit
  ${EndIf}
!macroend
