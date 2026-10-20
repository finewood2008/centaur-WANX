; Shared by standard, signed-release and internal Windows packages.
!include nsDialogs.nsh
SetFont "Microsoft YaHei UI" 9

!define MUI_BGCOLOR "FCF9F5"
!define MUI_TEXTCOLOR "302C28"
!define MUI_HEADER_TRANSPARENT_TEXT
!define MUI_INSTFILESPAGE_PROGRESSBAR "colored"
!define MUI_INSTFILESPAGE_COLORS "A35D40 FCF9F5"
!define MUI_FINISHPAGE_TITLE "万象已准备就绪"
!define MUI_FINISHPAGE_TEXT "应用 · 空间 · 盒子$\r$\n$\r$\n发现需要的 AI 应用，整理自己的文件，连接并管理万象盒子。$\r$\n$\r$\n升级安装会保留现有账号与应用数据。"
!define MUI_FINISHPAGE_RUN_TEXT "立即打开万象"
!define MUI_CUSTOMFUNCTION_GUIINIT WanxInstallerGuiInit

Var wxWelcomeDialog
Var wxArtwork
Var wxBitmap
Var wxSlide
Var wxSlideTitle
Var wxSlideText
Var wxSlideIndex
Var wxPauseButton
Var wxPaused
Var wxTitleFont
Var wxBodyFont
Var wxProgressArtwork
Var wxProgressBitmap
Var wxProgressAnimation

!macro customWelcomePage
  Page custom WanxWelcomePage WanxWelcomeLeave
!macroend

; electron-builder inserts this after MUI pages declare their control variables.
!macro customHeader
Function WanxInstallerGuiInit
  CreateFont $wxTitleFont "Microsoft YaHei UI" 16 600
  CreateFont $wxBodyFont "Microsoft YaHei UI" 9 400
  SendMessage $HWNDPARENT ${WM_SETFONT} $wxBodyFont 1
FunctionEnd

Function WanxExtractArtwork
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=wanx-feature-1.bmp "${PROJECT_DIR}\resources\installer\feature-1.bmp"
  File /oname=wanx-feature-2.bmp "${PROJECT_DIR}\resources\installer\feature-2.bmp"
  File /oname=wanx-feature-3.bmp "${PROJECT_DIR}\resources\installer\feature-3.bmp"
  File /oname=wanx-overview.bmp "${PROJECT_DIR}\resources\installer\overview.bmp"
  File /oname=wanx-posters-1x.avi "${PROJECT_DIR}\resources\installer\poster-loop-1x.avi"
  File /oname=wanx-posters-2x.avi "${PROJECT_DIR}\resources\installer\poster-loop-2x.avi"
  File /oname=wanx-posters-3x.avi "${PROJECT_DIR}\resources\installer\poster-loop-3x.avi"
FunctionEnd

Function WanxWelcomePage
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "欢迎使用万象" "应用 · 空间 · 盒子"
  Call WanxExtractArtwork
  ; Use the full welcome-page area so poster headlines are legible.
  nsDialogs::Create 1044
  Pop $wxWelcomeDialog
  ${If} $wxWelcomeDialog == error
    Abort
  ${EndIf}
  SetCtlColors $wxWelcomeDialog 302C28 FCF9F5
  ${NSD_CreateBitmap} 0 0 100% 122u ""
  Pop $wxArtwork
  ${NSD_CreateLabel} 10u 130u 95% 21u ""
  Pop $wxSlideTitle
  SendMessage $wxSlideTitle ${WM_SETFONT} $wxTitleFont 1
  SetCtlColors $wxSlideTitle 302C28 FCF9F5
  ${NSD_CreateLabel} 10u 156u 95% 12u ""
  Pop $wxSlideText
  SetCtlColors $wxSlideText 756B61 FCF9F5
  ${NSD_CreateLabel} 10u 176u 80u 12u ""
  Pop $wxSlideIndex
  SetCtlColors $wxSlideIndex A35D40 FCF9F5
  ${NSD_CreateButton} 169u 172u 38u 18u "上一页"
  Pop $0
  ${NSD_OnClick} $0 WanxPreviousSlide
  ${NSD_CreateButton} 213u 172u 38u 18u "暂停"
  Pop $wxPauseButton
  ${NSD_OnClick} $wxPauseButton WanxToggleSlides
  ${NSD_CreateButton} 257u 172u 38u 18u "下一页"
  Pop $0
  ${NSD_OnClick} $0 WanxNextSlide
  StrCpy $wxSlide 1
  StrCpy $wxPaused 0
  StrCpy $wxBitmap 0
  Call WanxRenderSlide
  ${NSD_CreateTimer} WanxSlideTimer 5500
  nsDialogs::Show
  ; Show also returns on Cancel; always release the timer/GDI bitmap.
  Call WanxWelcomeCleanup
FunctionEnd

Function WanxRenderSlide
  ${If} $wxBitmap != 0
    ${NSD_ClearImage} $wxArtwork
    ${NSD_FreeImage} $wxBitmap
  ${EndIf}
  ${NSD_SetStretchedImage} $wxArtwork "$PLUGINSDIR\wanx-feature-$wxSlide.bmp" $wxBitmap
  ${Switch} $wxSlide
    ${Case} 1
      ${NSD_SetText} $wxSlideIndex "1 / 3 · 应用"
      ${NSD_SetText} $wxSlideTitle "应用，让 AI 融入日常"
      ${NSD_SetText} $wxSlideText "发现、安装和使用适合你的 AI 应用。"
      ${Break}
    ${Case} 2
      ${NSD_SetText} $wxSlideIndex "2 / 3 · 空间"
      ${NSD_SetText} $wxSlideTitle "空间，安放你的文件与资料"
      ${NSD_SetText} $wxSlideText "集中管理文件，自主决定 AI 可以访问的内容。"
      ${Break}
    ${Case} 3
      ${NSD_SetText} $wxSlideIndex "3 / 3 · 盒子"
      ${NSD_SetText} $wxSlideTitle "盒子，连接你的 AI 底座"
      ${NSD_SetText} $wxSlideText "连接万象盒子，查看设备状态，管理运行服务。"
      ${Break}
  ${EndSwitch}
FunctionEnd

Function WanxSlideTimer
  ${If} $wxPaused == 0
    Call WanxAdvanceSlide
  ${EndIf}
FunctionEnd

Function WanxAdvanceSlide
  IntOp $wxSlide $wxSlide + 1
  ${If} $wxSlide > 3
    StrCpy $wxSlide 1
  ${EndIf}
  Call WanxRenderSlide
FunctionEnd

Function WanxNextSlide
  Pop $0
  Call WanxAdvanceSlide
FunctionEnd

Function WanxPreviousSlide
  Pop $0
  IntOp $wxSlide $wxSlide - 1
  ${If} $wxSlide < 1
    StrCpy $wxSlide 3
  ${EndIf}
  Call WanxRenderSlide
FunctionEnd

Function WanxToggleSlides
  Pop $0
  IntOp $wxPaused $wxPaused ^ 1
  ${If} $wxPaused == 1
    ${NSD_SetText} $wxPauseButton "播放"
  ${Else}
    ${NSD_SetText} $wxPauseButton "暂停"
  ${EndIf}
FunctionEnd

Function WanxWelcomeLeave
  Call WanxWelcomeCleanup
FunctionEnd

Function WanxWelcomeCleanup
  ${NSD_KillTimer} WanxSlideTimer
  ${If} $wxBitmap != 0
    ${NSD_ClearImage} $wxArtwork
    ${NSD_FreeImage} $wxBitmap
    StrCpy $wxBitmap 0
  ${EndIf}
FunctionEnd

Function WanxInstallShow
  StrCpy $wxProgressAnimation 0
  Call WanxExtractArtwork
  !insertmacro MUI_HEADER_TEXT "正在安装万象" "正在复制应用与配套组件，请稍候。"
  ; NSIS alone drives the real progress bar. The independent native animation
  ; control rotates posters while files are copied on the installer thread.
  System::Call '*(i 0, i 0, i 0, i 0) p.r0'
  System::Call 'user32::GetClientRect(p $mui.InstFilesPage, p r0)'
  System::Call '*$0(i, i, i.r3, i.r4)'
  System::Free $0
  IntOp $5 $4 * 25
  IntOp $5 $5 / 100
  IntOp $6 $4 * 75
  IntOp $6 $6 / 100
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5000000E, i 0, i r5, i r3, i r6, p $mui.InstFilesPage, p 0, p 0, p 0) p.s'
  Pop $wxProgressArtwork
  ${NSD_SetStretchedImage} $wxProgressArtwork "$PLUGINSDIR\wanx-overview.bmp" $wxProgressBitmap
  ${If} $3 < 280
  ${OrIf} $6 < 156
    Return
  ${EndIf}
  ; A still image remains visible if Windows cannot open the animation.
  StrCpy $7 "$PLUGINSDIR\wanx-posters-1x.avi"
  ${If} $3 >= 420
  ${AndIf} $6 >= 234
    StrCpy $7 "$PLUGINSDIR\wanx-posters-2x.avi"
  ${EndIf}
  ${If} $3 >= 560
  ${AndIf} $6 >= 312
    StrCpy $7 "$PLUGINSDIR\wanx-posters-3x.avi"
  ${EndIf}
  System::Call '*(i 8, i 128) p.r0'
  System::Call 'comctl32::InitCommonControlsEx(p r0)'
  System::Free $0
  ; ACS_CENTER keeps the pre-rendered frame centered without distortion.
  System::Call 'user32::CreateWindowExW(i 0, w "SysAnimate32", w "", i 0x50000001, i 0, i r5, i r3, i r6, p $mui.InstFilesPage, p 0, p 0, p 0) p.s'
  Pop $wxProgressAnimation
  SendMessage $wxProgressAnimation ${ACM_OPEN} 0 "STR:$7" $0
  ${If} $0 != 0
    SendMessage $wxProgressAnimation ${ACM_PLAY} -1 0xFFFF0000 $0
  ${EndIf}
  ${If} $0 != 0
    ShowWindow $wxProgressArtwork ${SW_HIDE}
  ${Else}
    SendMessage $wxProgressAnimation ${ACM_OPEN} 0 0
    System::Call 'user32::DestroyWindow(p $wxProgressAnimation)'
    StrCpy $wxProgressAnimation 0
  ${EndIf}
FunctionEnd

Function WanxInstallLeave
  ${If} $wxProgressAnimation != 0
    SendMessage $wxProgressAnimation ${ACM_STOP} 0 0
    SendMessage $wxProgressAnimation ${ACM_OPEN} 0 0
    System::Call 'user32::DestroyWindow(p $wxProgressAnimation)'
    StrCpy $wxProgressAnimation 0
  ${EndIf}
  ${If} $wxProgressBitmap != 0
    ${NSD_ClearImage} $wxProgressArtwork
    ${NSD_FreeImage} $wxProgressBitmap
    StrCpy $wxProgressBitmap 0
  ${EndIf}
FunctionEnd
!macroend
