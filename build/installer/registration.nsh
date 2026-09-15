!include "LogicLib.nsh"
!include "FileFunc.nsh"

; Test harnesses override these keys to avoid touching a real installation.
!ifndef TTCUT_LAYOUT_KEY
  !define TTCUT_LAYOUT_KEY "Software\TTcut\Install"
!endif
!ifndef TTCUT_APPLICATION_KEY
  !define TTCUT_APPLICATION_KEY "Software\${APP_GUID}"
!endif
!ifndef TTCUT_UNINSTALL_KEY
  !define TTCUT_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
!endif

Var TTcutRegistrationError
Var TTcutRegistrationLog

!macro TTcutWriteVerified Type Key Name Value
  StrCpy $TTcutRegistrationError "WRITE: ${Key}\${Name}"
  ClearErrors
  WriteReg${Type} HKCU "${Key}" "${Name}" "${Value}"
  IfErrors ttcut_registration_done
  StrCpy $TTcutRegistrationError "READBACK: ${Key}\${Name}"
  ClearErrors
  ReadReg${Type} $0 HKCU "${Key}" "${Name}"
  IfErrors ttcut_registration_done
  StrCmp $0 "${Value}" +2
    Goto ttcut_registration_done
!macroend

; Keep registration in the installer process: enterprise PowerShell policies,
; language modes, PATH and .NET availability must not gate native registry IO.
Function TTcutCommitRegistration
  Push $0
  SetRegView 64
  StrCpy $TTcutRegistrationError "INVALID_INSTALL_ROOT"
  ${GetRoot} "$TTcutRoot" $0
  StrCmp $TTcutRoot "" ttcut_registration_done
  StrCmp $TTcutRoot $0 ttcut_registration_done
  StrCpy $TTcutRegistrationError "INSTALL_FILES_MISSING"
  IfFileExists "$INSTDIR\TTcut.exe" 0 ttcut_registration_done
  IfFileExists "$INSTDIR\Uninstall TTcut.exe" 0 ttcut_registration_done

  !insertmacro TTcutWriteVerified Str "${TTCUT_LAYOUT_KEY}" "InstallRoot" "$TTcutRoot"
  !insertmacro TTcutWriteVerified DWORD "${TTCUT_LAYOUT_KEY}" "DesktopShortcut" "$TTcutDesktopShortcut"
  !insertmacro TTcutWriteVerified DWORD "${TTCUT_LAYOUT_KEY}" "LayoutVersion" "1"
  !insertmacro TTcutWriteVerified Str "${TTCUT_APPLICATION_KEY}" "InstallLocation" "$INSTDIR"
  !insertmacro TTcutWriteVerified Str "${TTCUT_APPLICATION_KEY}" "KeepShortcuts" "true"
  !insertmacro TTcutWriteVerified Str "${TTCUT_APPLICATION_KEY}" "ShortcutName" "TTcut"
  !insertmacro TTcutWriteVerified Str "${TTCUT_UNINSTALL_KEY}" "DisplayName" "TTcut ${VERSION}"
  !insertmacro TTcutWriteVerified Str "${TTCUT_UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  !insertmacro TTcutWriteVerified Str "${TTCUT_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\uninstallerIcon.ico"
  !insertmacro TTcutWriteVerified Str "${TTCUT_UNINSTALL_KEY}" "Publisher" "weiye"
  !insertmacro TTcutWriteVerified Str "${TTCUT_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  !insertmacro TTcutWriteVerified Str "${TTCUT_UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall TTcut.exe$\" /currentuser'
  !insertmacro TTcutWriteVerified Str "${TTCUT_UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall TTcut.exe$\" /currentuser /S'
  !insertmacro TTcutWriteVerified DWORD "${TTCUT_UNINSTALL_KEY}" "NoModify" "1"
  !insertmacro TTcutWriteVerified DWORD "${TTCUT_UNINSTALL_KEY}" "NoRepair" "1"
  DeleteRegValue HKCU "${TTCUT_LAYOUT_KEY}" "PreservedDataRoot"
  StrCpy $TTcutRegistrationError ""

  ttcut_registration_done:
  ; Outside the install tree so rollback cannot erase the failure evidence.
  StrCpy $TTcutRegistrationLog ""
  StrCmp $TTcutRegistrationError "" ttcut_registration_log_done
  ClearErrors
  GetTempFileName $TTcutRegistrationLog "$TEMP"
  IfErrors ttcut_registration_log_done
  FileOpen $0 "$TTcutRegistrationLog" w
  IfErrors ttcut_registration_log_done
  FileWriteWord $0 0xFEFF
  FileClose $0
  WriteINIStr "$TTcutRegistrationLog" "Registration" "InstallRoot" "$TTcutRoot"
  WriteINIStr "$TTcutRegistrationLog" "Registration" "Version" "${VERSION}"
  WriteINIStr "$TTcutRegistrationLog" "Registration" "Error" "$TTcutRegistrationError"
  ttcut_registration_log_done:
  Pop $0
FunctionEnd
