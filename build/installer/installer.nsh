!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
!include "nsDialogs.nsh"
!include "${PROJECT_DIR}\.runtime\installer-assets\online-model-installer.nsh"

!ifndef BUILD_UNINSTALLER
${StrRep}
!endif

Var TTcutRoot
Var TTcutRootField
Var TTcutBrowseButton
Var TTcutDesktopCheckbox
Var TTcutDesktopShortcut
Var TTcutMigrationLabel
Var TTcutIsRepair
Var TTcutLegacyComponents
Var TTcutLegacyUninstall
Var TTcutLegacyDeleteApproved
Var TTcutMigrationState
Var TTcutPreservedDataRoot
Var TTcutDeleteAllData
Var TTcutDeleteAllCheckbox

LangString TTCUT_SETUP_TITLE 1033 "Install TTcut"
LangString TTCUT_SETUP_TITLE 2052 "安装 TTcut"
LangString TTCUT_SETUP_DETAIL 1033 "Choose an installation location and shortcut. Analysis and media components will also be stored here."
LangString TTCUT_SETUP_DETAIL 2052 "选择安装位置和快捷方式。TTcut 的分析与视频处理组件也会保存在此位置。"
LangString TTCUT_INSTALL_LOCATION 1033 "Installation location"
LangString TTCUT_INSTALL_LOCATION 2052 "安装位置"
LangString TTCUT_BROWSE 1033 "Browse..."
LangString TTCUT_BROWSE 2052 "浏览…"
LangString TTCUT_DESKTOP 1033 "Create a desktop shortcut"
LangString TTCUT_DESKTOP 2052 "创建桌面快捷方式"
LangString TTCUT_MIGRATION 1033 "Existing components will be moved to the selected location before the old version is removed."
LangString TTCUT_MIGRATION 2052 "检测到旧版组件；验证迁移成功后才会移除旧版。"
LangString TTCUT_PATH_REQUIRED 1033 "Choose an installation location."
LangString TTCUT_PATH_REQUIRED 2052 "请选择安装位置。"
LangString TTCUT_PATH_SYSTEM 1033 "Choose a writable folder outside Windows and Program Files."
LangString TTCUT_PATH_SYSTEM 2052 "请选择 Windows 和 Program Files 之外的可写目录。"
LangString TTCUT_PATH_WRITE 1033 "The selected installation location is not writable."
LangString TTCUT_PATH_NOT_EMPTY 1033 "Choose an empty folder, or the existing TTcut installation location."
LangString TTCUT_PATH_NOT_EMPTY 2052 "请选择空文件夹，或已经安装的 TTcut 位置。"
LangString TTCUT_MODEL_DOWNLOAD_FAILED 1033 "TTcut could not download or verify its required analysis models. Check your network connection and run the installer again."
LangString TTCUT_MODEL_DOWNLOAD_FAILED 2052 "TTcut 无法下载或验证所需的分析模型。请检查网络连接后重新运行安装程序。"
LangString TTCUT_PATH_WRITE 2052 "所选安装位置不可写。"
LangString TTCUT_MIGRATION_FAILED 1033 "Component migration failed. The old installation and components were left unchanged."
LangString TTCUT_MIGRATION_FAILED 2052 "组件迁移失败，旧程序和旧组件保持不变。"
LangString TTCUT_LEGACY_UNINSTALL_FAILED 1033 "The old TTcut installation could not be removed and was restored. The old components were left unchanged."
LangString TTCUT_LEGACY_UNINSTALL_FAILED 2052 "无法移除旧版 TTcut，旧程序已恢复，旧组件保持不变。"
LangString TTCUT_REGISTRATION_FAILED 1033 "TTcut installation registration failed. Installation was stopped."
LangString TTCUT_REGISTRATION_FAILED 2052 "TTcut 安装信息写入失败，安装已停止。"
LangString TTCUT_COMPONENT_ACTIVATION_FAILED 1033 "The migrated components could not be enabled. The old installation and components were left unchanged."
LangString TTCUT_COMPONENT_ACTIVATION_FAILED 2052 "无法启用迁移后的组件，旧程序和旧组件保持不变。"
LangString TTCUT_DOWNGRADE_BLOCKED 1033 "A newer version of TTcut is already installed. Uninstall it before installing this older version."
LangString TTCUT_DOWNGRADE_BLOCKED 2052 "已安装更高版本的 TTcut。如需安装旧版本，请先卸载当前版本。"
LangString TTCUT_VERSION_INVALID 1033 "The installer version could not be validated. Installation was stopped."
LangString TTCUT_VERSION_INVALID 2052 "无法验证安装包版本，安装已停止。"
LangString TTCUT_DELETE_ALL 1033 "Delete all TTcut data, including components, settings, history, and logs"
LangString TTCUT_DELETE_ALL 2052 "删除所有 TTcut 数据，包括组件、设置、历史和日志"

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
  StrCpy $isForceMachineInstall "0"
!macroend

!ifndef BUILD_UNINSTALLER
!macro customInit
  SetShellVarContext current
  SetRegView 64
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TTcut" "DisplayVersion"
  ${EndIf}
  ${If} $0 != ""
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=compare-versions.ps1 "${PROJECT_DIR}\build\installer\compare-versions.ps1"
    nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\compare-versions.ps1" -InstalledVersion "$0" -CandidateVersion "${VERSION}"'
    Pop $1
    Pop $2
    ${If} $1 == 2
      IfSilent ttcut_downgrade_quit 0
      MessageBox MB_ICONSTOP "$(TTCUT_DOWNGRADE_BLOCKED)"
      ttcut_downgrade_quit:
      SetErrorLevel 2
      Quit
    ${ElseIf} $1 != 0
      IfSilent ttcut_invalid_version_quit 0
      MessageBox MB_ICONSTOP "$(TTCUT_VERSION_INVALID)"
      ttcut_invalid_version_quit:
      SetErrorLevel 3
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom TTcutOptionsCreate TTcutOptionsLeave
  ; The next MUI page is the installation progress page.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW TTcutHideBackButton
!macroend

!macro customFinishPage
  Function TTcutStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "TTcutStartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW TTcutHideBackButton
  !insertmacro MUI_PAGE_FINISH
!macroend

Function TTcutHideBackButton
  GetDlgItem $2 $HWNDPARENT 3
  ShowWindow $2 ${SW_HIDE}
  EnableWindow $2 0
FunctionEnd

Function TTcutChooseDefaultRoot
  StrCpy $TTcutRoot ""
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=choose-default-root.ps1 "${PROJECT_DIR}\build\installer\choose-default-root.ps1"
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\choose-default-root.ps1"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    ; Never copy an error record (or a diagnostic line) into the path field.
    StrLen $2 $1
    ${If} $2 >= 3
      StrCpy $3 $1 1 1
      ${If} $3 == ":"
        StrCpy $TTcutRoot $1
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

Function TTcutPathIsWithinBlockedRoot
  StrCpy $5 "0"
  ${If} $6 == ""
    Return
  ${EndIf}
  StrCpy $7 $6 1 -1
  ${If} $7 == "\"
    StrCpy $6 $6 -1
  ${EndIf}
  StrLen $7 $6
  StrCpy $8 $TTcutRoot $7
  ${If} $8 != $6
    Return
  ${EndIf}
  StrCpy $9 $TTcutRoot 1 $7
  ${If} $9 == ""
  ${OrIf} $9 == "\"
    StrCpy $5 "1"
  ${EndIf}
FunctionEnd

Function TTcutDirectoryHasEntries
  StrCpy $5 "0"
  StrCpy $7 ""
  StrCpy $8 ""
  ClearErrors
  FindFirst $7 $8 "$TTcutRoot\*"
  IfErrors ttcut_directory_entries_done

  ttcut_directory_entry_loop:
  StrCmp $8 "." ttcut_directory_entry_next
  StrCmp $8 ".." ttcut_directory_entry_next
  StrCmp $8 "" ttcut_directory_entries_close
  StrCpy $5 "1"
  Goto ttcut_directory_entries_close

  ttcut_directory_entry_next:
  ClearErrors
  FindNext $7 $8
  IfErrors ttcut_directory_entries_close
  Goto ttcut_directory_entry_loop

  ttcut_directory_entries_close:
  FindClose $7
  ttcut_directory_entries_done:
FunctionEnd

Function TTcutBrowse
  nsDialogs::SelectFolderDialog "$(TTCUT_INSTALL_LOCATION)" "$TTcutRoot"
  Pop $0
  ${If} $0 != "error"
    ; Selecting a drive means "install TTcut on this drive", not "use the
    ; drive root as the application directory".
    StrCpy $2 $0 1 -1
    ${If} $2 == "\"
      StrCpy $0 $0 -1
    ${EndIf}
    ${GetRoot} "$0" $1
    ${If} $0 == $1
      StrCpy $0 "$0\TTcut"
    ${EndIf}
    StrCpy $TTcutRoot $0
    ${NSD_SetText} $TTcutRootField $TTcutRoot
  ${EndIf}
FunctionEnd

Function TTcutOptionsCreate
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--updated" $1
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ; This is the first user-facing setup page.
  Call TTcutHideBackButton

  ReadRegStr $TTcutRoot HKCU "Software\TTcut\Install" "InstallRoot"
  ${If} $TTcutRoot == ""
    Call TTcutChooseDefaultRoot
    StrCpy $TTcutIsRepair "0"
  ${Else}
    StrCpy $TTcutIsRepair "1"
  ${EndIf}

  CreateFont $8 "Segoe UI" 11 700
  CreateFont $9 "Segoe UI" 9 400

  ${NSD_CreateLabel} 0 0 100% 16u "$(TTCUT_SETUP_TITLE)"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $8 1
  ${NSD_CreateLabel} 0 19u 100% 22u "$(TTCUT_SETUP_DETAIL)"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $9 1
  ${NSD_CreateLabel} 0 47u 100% 11u "$(TTCUT_INSTALL_LOCATION)"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $9 1
  ${NSD_CreateText} 0 61u 78% 19u "$TTcutRoot"
  Pop $TTcutRootField
  SendMessage $TTcutRootField ${WM_SETFONT} $9 1
  ${NSD_CreateButton} 80% 61u 20% 19u "$(TTCUT_BROWSE)"
  Pop $TTcutBrowseButton
  SendMessage $TTcutBrowseButton ${WM_SETFONT} $9 1
  ${NSD_OnClick} $TTcutBrowseButton TTcutBrowse
  ${NSD_CreateCheckbox} 0 88u 100% 16u "$(TTCUT_DESKTOP)"
  Pop $TTcutDesktopCheckbox
  SendMessage $TTcutDesktopCheckbox ${WM_SETFONT} $9 1
  StrCpy $2 1
  ReadRegDWORD $2 HKCU "Software\TTcut\Install" "DesktopShortcut"
  ${If} $TTcutIsRepair == "0"
  ${OrIf} $2 == 1
    ${NSD_Check} $TTcutDesktopCheckbox
  ${EndIf}

  ${If} $TTcutIsRepair == "1"
    EnableWindow $TTcutRootField 0
    EnableWindow $TTcutBrowseButton 0
  ${EndIf}

  StrCpy $TTcutLegacyComponents "$LOCALAPPDATA\TTcutData\components"
  StrCpy $TTcutLegacyUninstall ""
  StrCpy $TTcutLegacyDeleteApproved "1"
  ReadRegStr $TTcutPreservedDataRoot HKCU "Software\TTcut\Install" "PreservedDataRoot"
  ReadRegStr $3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TTcut" "InstallLocation"
  ${If} $3 == "$LOCALAPPDATA\TTcut"
  ${AndIf} ${FileExists} "$LOCALAPPDATA\TTcut\Update.exe"
    StrCpy $TTcutLegacyUninstall "$LOCALAPPDATA\TTcut\Update.exe"
  ${EndIf}
  ${IfNot} ${FileExists} "$TTcutLegacyComponents\*.*"
    StrCpy $TTcutLegacyDeleteApproved "0"
    StrCpy $3 $TTcutPreservedDataRoot
    ${If} $3 != ""
      ${GetRoot} "$3" $4
      ${If} $3 != $4
        StrCpy $TTcutLegacyComponents "$3\data\components"
        StrCpy $TTcutLegacyDeleteApproved "1"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} ${FileExists} "$TTcutLegacyComponents\*.*"
    ${NSD_CreateLabel} 0 110u 100% 24u "$(TTCUT_MIGRATION)"
    Pop $TTcutMigrationLabel
    SendMessage $TTcutMigrationLabel ${WM_SETFONT} $9 1
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function TTcutOptionsLeave
  ${NSD_GetText} $TTcutRootField $TTcutRoot
  ${If} $TTcutRoot == ""
    MessageBox MB_ICONEXCLAMATION "$(TTCUT_PATH_REQUIRED)"
    Abort
  ${EndIf}

  ; NSIS GetFullPathName returns an empty result when the selected directory
  ; does not exist yet. The Win32 API performs lexical normalization without
  ; requiring a pre-existing first-install target.
  System::Call 'kernel32::GetFullPathNameW(w "$TTcutRoot", i ${NSIS_MAX_STRLEN}, w .r2, p 0)i.r3'
  ${If} $3 == 0
  ${OrIf} $2 == ""
    MessageBox MB_ICONEXCLAMATION "$(TTCUT_PATH_REQUIRED)"
    Abort
  ${EndIf}
  StrCpy $TTcutRoot $2
  StrCpy $8 $TTcutRoot 1 -1
  ${If} $8 == "\"
    StrCpy $TTcutRoot $TTcutRoot -1
  ${EndIf}
  StrLen $0 $TTcutRoot
  ${If} $0 == 2
    StrCpy $1 $TTcutRoot 1 1
    ${If} $1 == ":"
      StrCpy $TTcutRoot "$TTcutRoot\TTcut"
      ${NSD_SetText} $TTcutRootField $TTcutRoot
    ${EndIf}
  ${EndIf}

  ReadEnvStr $6 "windir"
  Call TTcutPathIsWithinBlockedRoot
  ${If} $5 == "1"
    Goto path_system_blocked
  ${EndIf}
  ReadEnvStr $6 "ProgramFiles"
  Call TTcutPathIsWithinBlockedRoot
  ${If} $5 == "1"
    Goto path_system_blocked
  ${EndIf}
  ReadEnvStr $6 "ProgramFiles(x86)"
  Call TTcutPathIsWithinBlockedRoot
  ${If} $5 == "1"
    Goto path_system_blocked
  ${EndIf}
  ReadEnvStr $6 "ProgramW6432"
  Call TTcutPathIsWithinBlockedRoot
  ${If} $5 == "1"
    Goto path_system_blocked
  ${EndIf}
  ReadEnvStr $6 "ProgramData"
  Call TTcutPathIsWithinBlockedRoot
  ${If} $5 == "1"
    Goto path_system_blocked
  ${EndIf}
  Goto path_system_valid

  path_system_blocked:
  MessageBox MB_ICONEXCLAMATION "$(TTCUT_PATH_SYSTEM)"
  Abort

  path_system_valid:

  ${If} $TTcutIsRepair == "0"
    ReadRegStr $6 HKCU "Software\TTcut\Install" "PreservedDataRoot"
    Call TTcutDirectoryHasEntries
    ${If} $5 == "1"
      ${If} $6 == ""
      ${OrIf} $TTcutRoot != $6
        MessageBox MB_ICONEXCLAMATION "$(TTCUT_PATH_NOT_EMPTY)"
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}

  CreateDirectory "$TTcutRoot"
  ClearErrors
  FileOpen $4 "$TTcutRoot\.ttcut-write-test" w
  ${If} ${Errors}
    MessageBox MB_ICONEXCLAMATION "$(TTCUT_PATH_WRITE)"
    Abort
  ${EndIf}
  FileClose $4
  Delete "$TTcutRoot\.ttcut-write-test"

  System::Call 'kernel32::SetEnvironmentVariableW(w "TTCUT_INSTALLER_ROOT", w "$TTcutRoot")i.r1'
  ${If} $TTcutIsRepair == "1"
    System::Call 'kernel32::SetEnvironmentVariableW(w "TTCUT_INSTALLER_LEGACY", w "")i.r1'
  ${Else}
    System::Call 'kernel32::SetEnvironmentVariableW(w "TTCUT_INSTALLER_LEGACY", w "$TTcutLegacyComponents")i.r1'
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "TTCUT_INSTALLER_LEGACY_APP", w "$TTcutLegacyUninstall")i.r1'

  ${If} $TTcutLegacyUninstall != ""
    StrCpy $4 0
  auto_close_legacy_processes:
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=close-legacy-processes.ps1 "${PROJECT_DIR}\build\installer\close-legacy-processes.ps1"
    nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\close-legacy-processes.ps1"'
    Pop $6
    Pop $7
    ${If} $6 != 0
      IntOp $4 $4 + 1
      ${If} $4 < 3
        Sleep 500
        Goto auto_close_legacy_processes
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "TTCUT_INSTALLER_ROOT", w "")i.r1'
  System::Call 'kernel32::SetEnvironmentVariableW(w "TTCUT_INSTALLER_LEGACY", w "")i.r1'
  System::Call 'kernel32::SetEnvironmentVariableW(w "TTCUT_INSTALLER_LEGACY_APP", w "")i.r1'

  StrCpy $INSTDIR "$TTcutRoot\app"
  ${NSD_GetState} $TTcutDesktopCheckbox $TTcutDesktopShortcut
FunctionEnd

Function TTcutRollbackNewInstall
  ${If} $TTcutMigrationState == "1"
    RMDir /r "$TTcutRoot\data\components.migration"
  ${ElseIf} $TTcutMigrationState == "2"
    RMDir /r "$TTcutRoot\data\components"
  ${EndIf}
  RMDir /r "$TTcutRoot\data\.legacy-install.backup"
  Delete "$TTcutRoot\data\migration-report.json"
  Delete "$TTcutRoot\data\legacy-uninstall-report.json"
  Delete "$TTcutRoot\data\install-registration-report.json"

  ${If} $TTcutIsRepair == "0"
    DeleteRegKey HKCU "Software\TTcut\Install"
    ${If} $TTcutPreservedDataRoot != ""
      WriteRegStr HKCU "Software\TTcut\Install" "PreservedDataRoot" "$TTcutPreservedDataRoot"
    ${EndIf}
    DeleteRegKey HKCU "Software\${APP_GUID}"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
    RMDir /r "$INSTDIR"
    RMDir "$TTcutRoot\data"
    RMDir "$TTcutRoot"
  ${EndIf}
FunctionEnd

!if ${TTCUT_ONLINE_MODEL_INSTALLER} == 1
Function TTcutInstallOnlineModels
  IfFileExists "$INSTDIR\resources\resources\.ttcut-online-model-delivery" 0 ttcut_online_models_done
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=download-models.ps1 "${PROJECT_DIR}\build\installer\download-models.ps1"
  File /oname=online-model-delivery.json "${PROJECT_DIR}\resources\online-model-delivery.json"
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\download-models.ps1" -InstallDirectory "$INSTDIR" -DeliveryManifestPath "$PLUGINSDIR\online-model-delivery.json" -ModelManifestPath "$INSTDIR\resources\resources\model-manifest.json"'
  Pop $6
  Pop $7
  ${If} $6 != 0
    Call TTcutRollbackNewInstall
    MessageBox MB_ICONSTOP "$(TTCUT_MODEL_DOWNLOAD_FAILED)"
    SetErrorLevel 1
    Quit
  ${EndIf}
  ttcut_online_models_done:
FunctionEnd
!endif

!macro customInstall
  SetShellVarContext current
  ${GetParent} "$INSTDIR" $TTcutRoot
  StrCpy $TTcutMigrationState "0"

  !if ${TTCUT_ONLINE_MODEL_INSTALLER} == 1
  Call TTcutInstallOnlineModels
  !endif

  ; --updated skips the assisted options page. Restore the existing shortcut
  ; preference before the registration helper runs so a silent update cannot
  ; reset it. Older NSIS installs without the value fall back to the shortcut
  ; that is already present on the desktop.
  ${If} ${isUpdated}
    StrCpy $TTcutIsRepair "1"
    StrCpy $TTcutDesktopShortcut "0"
    ClearErrors
    ReadRegDWORD $TTcutDesktopShortcut HKCU "Software\TTcut\Install" "DesktopShortcut"
    ${If} ${Errors}
      ${If} ${FileExists} "$DESKTOP\TTcut.lnk"
        StrCpy $TTcutDesktopShortcut "1"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $TTcutIsRepair == "0"
  ${AndIf} ${FileExists} "$TTcutLegacyComponents\*.*"
  ${AndIf} "$TTcutLegacyComponents" != "$TTcutRoot\data\components"
    CreateDirectory "$TTcutRoot\data"
    RMDir /r "$TTcutRoot\data\components.migration"
    ${StrRep} $1 "$TTcutLegacyComponents" "\" "/"
    ${StrRep} $2 "$TTcutRoot\data\components.migration" "\" "/"
    ${StrRep} $3 "$PLUGINSDIR\migration-report.json" "\" "/"
    StrCpy $4 "$PLUGINSDIR\migration-request.json"
    FileOpen $5 "$4" w
    FileWriteWord $5 0xFEFF
    FileWriteUTF16LE $5 '{"schema_version":1,"source":"$1","target":"$2","report":"$3"}'
    FileClose $5
    ExecWait '"$INSTDIR\TTcut.exe" --installer-migrate-components "$4"' $6
    ${If} $6 != 0
      StrCpy $TTcutMigrationState "1"
      Call TTcutRollbackNewInstall
      MessageBox MB_ICONSTOP "$(TTCUT_MIGRATION_FAILED)"
      SetErrorLevel 1
      Quit
    ${EndIf}
    CopyFiles /SILENT "$PLUGINSDIR\migration-report.json" "$TTcutRoot\data\migration-report.json"
    StrCpy $TTcutMigrationState "1"
  ${EndIf}

  ; Commit and read back all new registration before touching the legacy app.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=commit-install-registration.ps1 "${PROJECT_DIR}\build\installer\commit-install-registration.ps1"
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\commit-install-registration.ps1" -InstallRoot "$TTcutRoot" -AppGuid "${APP_GUID}" -Version "${VERSION}" -DesktopShortcut "$TTcutDesktopShortcut" -ReportPath "$TTcutRoot\data\install-registration-report.json"'
  Pop $6
  Pop $7
  ${If} $6 != 0
    Call TTcutRollbackNewInstall
    MessageBox MB_ICONSTOP "$(TTCUT_REGISTRATION_FAILED)"
    SetErrorLevel 1
    Quit
  ${EndIf}

  ; Enable the verified component copy while the old app and source component
  ; store are still intact. A failed rename therefore has no destructive side
  ; effects and can be rolled back locally.
  ${If} $TTcutMigrationState == "1"
    ClearErrors
    Rename "$TTcutRoot\data\components.migration" "$TTcutRoot\data\components"
    ${If} ${Errors}
      Call TTcutRollbackNewInstall
      MessageBox MB_ICONSTOP "$(TTCUT_COMPONENT_ACTIVATION_FAILED)"
      SetErrorLevel 1
      Quit
    ${EndIf}
    StrCpy $TTcutMigrationState "2"
  ${EndIf}

  ; The legacy helper verifies a complete app backup before uninstalling and
  ; restores the app, uninstall registration, and shortcuts on any failure.
  ${If} $TTcutIsRepair == "0"
  ${AndIf} $TTcutLegacyUninstall != ""
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=finalize-legacy-install.ps1 "${PROJECT_DIR}\build\installer\finalize-legacy-install.ps1"
    nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\finalize-legacy-install.ps1" -LegacyUpdateExe "$TTcutLegacyUninstall" -LegacyInstallRoot "$LOCALAPPDATA\TTcut" -BackupRoot "$TTcutRoot\data\.legacy-install.backup" -ReportPath "$TTcutRoot\data\legacy-uninstall-report.json"'
    Pop $6
    Pop $7
    ${If} $6 != 0
      Call TTcutRollbackNewInstall
      MessageBox MB_ICONSTOP "$(TTCUT_LEGACY_UNINSTALL_FAILED)"
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}

  ${If} $TTcutMigrationState == "2"
  ${AndIf} $TTcutLegacyDeleteApproved == "1"
    RMDir /r "$TTcutLegacyComponents"
  ${EndIf}
  StrCpy $TTcutMigrationState "0"

  CreateDirectory "$SMPROGRAMS"
  CreateShortcut "$SMPROGRAMS\TTcut.lnk" "$INSTDIR\TTcut.exe"
  ${If} $TTcutDesktopShortcut == ${BST_CHECKED}
    CreateShortcut "$DESKTOP\TTcut.lnk" "$INSTDIR\TTcut.exe"
  ${Else}
    Delete "$DESKTOP\TTcut.lnk"
  ${EndIf}
!macroend
!endif

!macro customUnWelcomePage
  UninstPage custom un.TTcutDataPageCreate un.TTcutDataPageLeave
!macroend

Function un.TTcutDataPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 12u 100% 32u "$(TTCUT_DELETE_ALL)"
  Pop $TTcutDeleteAllCheckbox
  ${NSD_Check} $TTcutDeleteAllCheckbox
  nsDialogs::Show
FunctionEnd

Function un.TTcutDataPageLeave
  ${NSD_GetState} $TTcutDeleteAllCheckbox $TTcutDeleteAllData
FunctionEnd

!macro customUnInstall
  SetShellVarContext current
  ${IfNot} ${isUpdated}
  ReadRegStr $0 HKCU "Software\TTcut\Install" "InstallRoot"
  ${GetParent} "$INSTDIR" $1
  Delete "$DESKTOP\TTcut.lnk"
  Delete "$SMPROGRAMS\TTcut.lnk"
  ${If} $0 != ""
  ${AndIf} $0 == $1
    ${If} $TTcutDeleteAllData == ${BST_CHECKED}
      RMDir /r "$0\data"
      RMDir /r "$APPDATA\TTcut"
      RMDir /r "$APPDATA\ttcut"
      DeleteRegKey HKCU "Software\TTcut\Install"
    ${Else}
      WriteRegStr HKCU "Software\TTcut\Install" "PreservedDataRoot" "$0"
      DeleteRegValue HKCU "Software\TTcut\Install" "InstallRoot"
    ${EndIf}
    RMDir "$0"
  ${EndIf}
  ${EndIf}
!macroend
