!ifndef BUILD_UNINSTALLER

!include LogicLib.nsh
!include "${PROJECT_DIR}\shell\installer-ui.nsh"

; The zip app package is unpacked by nsisunz, which cannot create paths beyond
; MAX_PATH. Reject a long destination before unpacking the payload.
!define WANX_MAX_INSTALL_DIR_LENGTH 85

!macro customInit
  ${If} $installMode == "all"
    MessageBox MB_ICONSTOP|MB_OK "万象仅支持为当前用户安装。"
    SetErrorLevel 1603
    Quit
  ${EndIf}
  ; Silent installs skip every page, so the path guard and the security
  ; preflight must run here as well; otherwise a bad target only shows up as an
  ; unpacking error after hundreds of megabytes were already written.
  IfSilent wxSilentGuard wxSilentGuardDone
  wxSilentGuard:
    Call WanxAssertInstallPathLength
    Call WanxExtractAclTool
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\wanx-windows-install-acl.ps1" -Mode Preflight -Path "$INSTDIR"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      Call WanxWriteAclFailureLog
      SetErrorLevel 1603
      Quit
    ${EndIf}
  wxSilentGuardDone:
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customPageAfterChangeDir
  Page custom WanxPreflightPage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW WanxInstallShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE WanxInstallLeave
!macroend

Function WanxExtractAclTool
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=wanx-windows-install-acl.ps1 "${PROJECT_DIR}\shell\windows-install-acl.ps1"
FunctionEnd

Function WanxWriteAclFailureLog
  FileOpen $2 "$TEMP\Wanx-install-acl-error.log" w
  FileWrite $2 "exit=$0$\r$\n$1$\r$\n"
  FileClose $2
FunctionEnd

Function WanxAssertInstallPathLength
  StrLen $0 "$INSTDIR"
  ${If} $0 > ${WANX_MAX_INSTALL_DIR_LENGTH}
    StrCpy $1 "WINDOWS_INSTALL_PATH_TOO_LONG|$INSTDIR"
    Call WanxWriteAclFailureLog
    IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "安装路径过长（当前 $0 个字符，最多 ${WANX_MAX_INSTALL_DIR_LENGTH} 个）。请选择更短的目录后重新安装。"
    SetErrorLevel 1603
    Quit
  ${EndIf}
FunctionEnd

Function WanxPreflightPage
  Call WanxAssertInstallPathLength
  Call WanxExtractAclTool
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\wanx-windows-install-acl.ps1" -Mode Preflight -Path "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    Call WanxWriteAclFailureLog
    MessageBox MB_ICONSTOP|MB_OK "所选位置不支持安全安装，请选择当前用户有权限的本机 NTFS 目录。诊断日志已保存到临时目录。"
    SetErrorLevel 1603
    Quit
  ${EndIf}
  Abort
FunctionEnd

!macro customInstall
  ${IfNot} ${Silent}
    !insertmacro MUI_HEADER_TEXT "正在完成安装" "正在验证组件与安装目录，请稍候。"
  ${EndIf}
  Call WanxExtractAclTool
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\wanx-windows-install-acl.ps1" -Mode ProtectTree -Path "$INSTDIR"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    Call WanxWriteAclFailureLog
    ; A silent install must fail fast: a dialog nobody can see would hang the
    ; installer forever and leave a half-installed tree behind.
    IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "安装目录安全权限设置失败，万象不会启动。请重新安装并选择本机 NTFS 目录。诊断日志已保存到临时目录。"
    SetErrorLevel 1603
    Abort
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\wanx-windows-install-acl.ps1" -Mode VerifyTree -Path "$INSTDIR"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    Call WanxWriteAclFailureLog
    IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "安装目录安全权限验证失败，万象不会启动。诊断日志已保存到临时目录。"
    SetErrorLevel 1603
    Abort
  ${EndIf}
!macroend

!endif
