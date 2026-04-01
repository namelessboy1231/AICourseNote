!macro customHeader
  !undef UNINSTALL_FILENAME
  !define UNINSTALL_FILENAME "uninstall.exe"
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customInstall
    CreateDirectory "$INSTDIR\data"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --maintenance-task=write-local-runtime-config --local-data-dir="data"' $0

    ${If} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "安装完成，但初始化本地数据目录失败（退出码：$0）。请重新安装，或手动检查目标目录权限。"
      Abort
    ${EndIf}
  !macroend
!endif
