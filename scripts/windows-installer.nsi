; GravityPort Windows installer (NSIS 3.08 or later).
;
; One file that installs the packaged app for the current Windows user: no
; administrator prompt and no questions. It copies the app to
; %LOCALAPPDATA%\Programs\<PRODUCT>\app, adds Start menu and desktop
; shortcuts and an entry in Settings > Apps, then starts the app.
;
; The app sits one folder below the install root because the in-app updater
; replaces the whole folder that holds <PRODUCT>.exe and parks the previous
; copy in a .MOSA-update-* folder beside it (desktop/windows-updater.mjs).
; An update therefore swaps ...\<PRODUCT>\app only; the uninstaller, the
; shortcuts and any update leftovers all stay inside ...\<PRODUCT>.
;
; scripts/make-windows-installer.mjs builds it and defines:
;   PRODUCT      GravityPort, or MOSA for the transition build
;   VERSION      package.json version, for example 0.3.4 or 0.3.4-rc.1
;   VI_VERSION   the same version as four numbers, for example 0.3.4.0
;   APP_DIR      the packaged app folder (out/<PRODUCT>-win32-x64)
;   APP_ICON     the app icon (.ico)
;   OUT_FILE     where to write the installer
;   SIGN_NODE and SIGN_SCRIPT (production only): node and the script that
;                signs a file, run on the uninstaller and then on the installer

!ifndef PRODUCT | VERSION | VI_VERSION | APP_DIR | APP_ICON | OUT_FILE
  !error "Build the installer with scripts/make-windows-installer.mjs."
!endif

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
CRCCheck on

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

!define EXE_NAME "${PRODUCT}.exe"
!define UNINSTALLER_NAME "Uninstall ${PRODUCT}.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
!define WEBSITE "https://gravityport.azhuilab.com/"

!ifdef SIGN_SCRIPT
  ; makensis prefixes the command on Windows so cmd.exe keeps the quotes.
  !uninstfinalize '"${SIGN_NODE}" "${SIGN_SCRIPT}" "%1"' = 0
  !finalize '"${SIGN_NODE}" "${SIGN_SCRIPT}" "%1"' = 0
!endif

Name "${PRODUCT}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"
ShowInstDetails nevershow
ShowUninstDetails nevershow
AutoCloseWindow true
BrandingText "${PRODUCT} ${VERSION}"

!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_UNCONFIRMPAGE_TEXT_TOP "$(KeepsLibrary)"

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; The first language is the fallback for every system language not listed.
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

LangString AppRunning ${LANG_ENGLISH} "${PRODUCT} is open. Quit ${PRODUCT}, and any AI assistant that uses it (such as Claude), then click Retry."
LangString AppRunning ${LANG_SIMPCHINESE} "${PRODUCT} 正在运行。请先退出 ${PRODUCT}，以及正在使用它的 AI 助手（例如 Claude），然后点「重试」。"
LangString NeedsWindows10 ${LANG_ENGLISH} "${PRODUCT} needs 64-bit Windows 10 or 11."
LangString NeedsWindows10 ${LANG_SIMPCHINESE} "${PRODUCT} 需要 64 位的 Windows 10 或 11。"
LangString KeepsLibrary ${LANG_ENGLISH} "${PRODUCT} will be removed from this computer. Your library and settings are kept."
LangString KeepsLibrary ${LANG_SIMPCHINESE} "将从这台电脑上移除 ${PRODUCT}。你的素材库和设置会保留。"

VIProductVersion "${VI_VERSION}"
VIFileVersion "${VI_VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "LegalCopyright" "Copyright 2026 fengseekling-coder"

; 1 once the installed app has been moved to app.old, so a failed install
; can put it back.
Var MovedAside

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
  ${OrIfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "$(NeedsWindows10)" /SD IDOK
    Abort
  ${EndIf}
  ; Always the same per-user folder: the uninstaller and the in-app updater
  ; both rely on it, so /D= cannot move it.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCT}"
  StrCpy $MovedAside 0
FunctionEnd

; Renames $INSTDIR\app to $INSTDIR\<TO>. Windows cannot rename a folder
; while a program inside it is running, so a successful rename proves the app
; is closed. Antivirus scanners and the search indexer can hold a file for a
; moment after the app quits, so it tries for about two seconds before it
; asks. Cancel, and every silent run, aborts with the app untouched.
!macro MoveAppFolderTo TO
  retry:
    StrCpy $R9 0
  attempt:
    ClearErrors
    Rename "$INSTDIR\app" "$INSTDIR\${TO}"
    IfErrors 0 moved
    IntOp $R9 $R9 + 1
    IntCmp $R9 8 ask 0 ask
    Sleep 250
    Goto attempt
  ask:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(AppRunning)" /SD IDCANCEL IDRETRY retry
    Abort
  moved:
!macroend

; Keeps the installed copy as app.old until the new one is in place.
Function MoveInstalledAppAside
  IfFileExists "$INSTDIR\app\*.*" 0 done
  RMDir /r "$INSTDIR\app.old"
  !insertmacro MoveAppFolderTo "app.old"
  StrCpy $MovedAside 1
  done:
FunctionEnd

Section "Install"
  CreateDirectory "$INSTDIR"
  ; Left behind if an earlier uninstall could not finish deleting it.
  RMDir /r "$INSTDIR\app.removing"
  Call MoveInstalledAppAside

  SetOutPath "$INSTDIR\app"
  File /r "${APP_DIR}\*"

  WriteUninstaller "$INSTDIR\${UNINSTALLER_NAME}"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\app\${EXE_NAME}"
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\app\${EXE_NAME}"

  ; No DisplayVersion: in-app updates change the version without this
  ; installer, and a stale number would be wrong.
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\app\${EXE_NAME},0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "${WEBSITE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER_NAME}"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER_NAME}" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR\app" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"

  ${If} $MovedAside == 1
    RMDir /r "$INSTDIR\app.old"
  ${EndIf}
SectionEnd

Function .onInstFailed
  ${If} $MovedAside == 1
    RMDir /r "$INSTDIR\app"
    Rename "$INSTDIR\app.old" "$INSTDIR\app"
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  IfSilent done
  SetOutPath "$INSTDIR\app"
  Exec '"$INSTDIR\app\${EXE_NAME}"'
  done:
FunctionEnd

Function un.onInit
  SetShellVarContext current
FunctionEnd

Section "Uninstall"
  SetAutoClose true
  ; Remove only an app folder this installer put there.
  IfFileExists "$INSTDIR\app\${EXE_NAME}" 0 appRemoved
  RMDir /r "$INSTDIR\app.removing"
  !insertmacro MoveAppFolderTo "app.removing"
  RMDir /r "$INSTDIR\app.removing"
  appRemoved:

  RMDir /r "$INSTDIR\app.old"
  ; Copies the in-app updater parked here after an update.
  FindFirst $0 $1 "$INSTDIR\.MOSA-update-*"
  ${DoWhile} $1 != ""
    RMDir /r "$INSTDIR\$1"
    FindNext $0 $1
  ${Loop}
  FindClose $0

  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  Delete "$INSTDIR\${UNINSTALLER_NAME}"
  RMDir "$INSTDIR"
SectionEnd
