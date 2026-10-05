@echo off
rem Architecture Map build kit - installer for Windows (x64).
rem
rem   install.cmd                        installs to %LOCALAPPDATA%\Programs\ArchitectureMap
rem   install.cmd "D:\Tools\ArchMap"     installs to the folder given
rem
rem Needs no administrator rights and changes nothing outside the installation folder: no
rem registry entry, no PATH, no shortcut. To uninstall, delete the folder.
rem
rem This file only unpacks the Node.js that comes with the kit and hands over to
rem installer\install.mjs, which checks every packed file against manifest.json, unpacks the
rem rest and builds the viewer once. Set ARCHITECTURE_MAP_SILENT=1 to run without the pause at
rem the end and without opening the folder.
rem
rem No user path is expanded inside a parenthesised block, and delayed expansion is off, so
rem folders with brackets, ampersands or exclamation marks in their names work.
setlocal EnableExtensions DisableDelayedExpansion

set "RESULT=1"
set "KIT=%~dp0"
set "TARGET=%~1"
if not defined TARGET set "TARGET=%LOCALAPPDATA%\Programs\ArchitectureMap"
for %%T in ("%TARGET%\.") do set "TARGET=%%~fT"
set "TAR=%SystemRoot%\System32\tar.exe"
set "NODEZIP="
for %%F in ("%KIT%payload\node-v*-win-x64.zip") do set "NODEZIP=%%~fF"

echo.
echo  Architecture Map - build kit
echo  Installing to: "%TARGET%"
echo.

if not exist "%TAR%" goto :no_tar
if not defined NODEZIP goto :not_complete
if not exist "%KIT%installer\install.mjs" goto :not_complete
if not exist "%KIT%manifest.json" goto :not_complete
rem Checked here, before anything is unpacked (install.mjs checks both again, exactly):
rem the command files npm makes for its tools do not work below a folder with & ^ or %% in
rem its name, and the packages have long paths of their own.
echo "%TARGET%"| findstr /l /c:"&" /c:"^" /c:"%%" >nul
if not errorlevel 1 goto :bad_characters
if not "%TARGET:~110,1%"=="" goto :too_long
if not exist "%TARGET%\" goto :unpack
dir /b /a "%TARGET%" 2>nul | findstr "^" >nul
if not errorlevel 1 goto :not_empty

:unpack
if not exist "%TARGET%\node\" mkdir "%TARGET%\node"
if not exist "%TARGET%\node\" goto :cannot_create
echo  Unpacking Node.js ...
rem Straight into its final folder, without the top folder of the archive: a folder that was
rem just unpacked cannot always be renamed (a virus scanner may still be reading it).
"%TAR%" -xf "%NODEZIP%" -C "%TARGET%\node" --strip-components=1
if errorlevel 1 goto :failed
if not exist "%TARGET%\node\node.exe" goto :failed

"%TARGET%\node\node.exe" "%KIT%installer\install.mjs" "%KIT%." "%TARGET%\."
if errorlevel 1 goto :failed
set "RESULT=0"
goto :done

:no_tar
echo  This kit needs tar.exe, which is part of Windows 10 version 1803 and newer.
goto :done

:not_complete
echo  The kit is not complete: files are missing next to install.cmd.
echo  Unpack the whole zip file first, then run install.cmd from the unpacked folder.
goto :done

:bad_characters
echo  The name of that folder has one of the characters  ^&  ^^  %%  in it.
echo  The tools of the kit do not work below such a folder.
echo  Give another one:   install.cmd "C:\ArchitectureMap"
goto :done

:too_long
echo  The name of that folder is longer than 110 characters: the files below it would
echo  get names that are too long for Windows.
echo  Give a shorter one:   install.cmd "C:\ArchitectureMap"
goto :done

:not_empty
echo  That folder exists and is not empty.
echo  Give another one:   install.cmd "D:\Another\Folder"
echo  or delete it first, if it is an installation you no longer need.
goto :done

:cannot_create
echo  The folder could not be created.
goto :done

:failed
echo.
echo  The installation did not finish. Nothing outside the folder above was changed.
echo  Delete that folder before trying again.

:done
if defined ARCHITECTURE_MAP_SILENT exit /b %RESULT%
echo.
pause
exit /b %RESULT%
