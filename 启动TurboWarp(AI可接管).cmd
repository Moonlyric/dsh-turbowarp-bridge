@echo off
rem ============================================================
rem  启动 TurboWarp Desktop（可被 AI 接管）
rem
rem  和直接双击 TurboWarp 的区别只有一个：多了
rem      --remote-debugging-port=31821
rem  于是 DSH 的 scratch 插件能通过 CDP 直接读写这个窗口里的积木
rem  （不需要浏览器扩展、不需要 token）。
rem
rem  日常用这个快捷方式开桌面版，AI 就能接管**你自己开的这份**；
rem  如果哪天不想让 AI 碰，就直接开原版 TurboWarp。
rem
rem  端口想换：改下面的 31821，并在插件配置里写 desktopDebugPort。
rem ============================================================
setlocal
set "TW=%ProgramFiles%\TurboWarp\TurboWarp.exe"
if not exist "%TW%" set "TW=%ProgramFiles(x86)%\TurboWarp\TurboWarp.exe"
if not exist "%TW%" set "TW=%LOCALAPPDATA%\Programs\TurboWarp\TurboWarp.exe"
rem 下面这条是"装在非标准位置"的例子（这台机器的安装位置就是这样）：
if not exist "%TW%" set "TW=G:\09 Eutopia\scr\TurboWarp\TurboWarp.exe"

rem 还在别的地方？把安装目录拖到这里当参数：启动TurboWarp(AI可接管).cmd "D:\xxx\TurboWarp.exe"
if not "%~1"=="" set "TW=%~1"

if not exist "%TW%" (
  echo [x] 没找到 TurboWarp.exe。请把它的完整路径当参数传进来，例如：
  echo     启动TurboWarp(AI可接管).cmd "D:\Apps\TurboWarp\TurboWarp.exe"
  pause
  exit /b 1
)

echo [*] 启动：%TW%
echo [*] 调试端口 31821（DSH 的 scratch 插件靠它接管）
start "" "%TW%" --remote-debugging-port=31821 %2 %3 %4 %5
endlocal
