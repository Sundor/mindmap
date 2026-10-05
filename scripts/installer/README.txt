Architecture Map {{label}} - build kit for Windows (64-bit Intel/AMD)
======================================================================

WHAT THIS IS

  Everything a Windows computer needs to build the Architecture Map viewer from its source
  code - with no internet access, no administrator rights, and without installing anything
  system-wide:

    - Node.js {{node}}, the official portable build, unchanged
    - the source code of Architecture Map {{version}}
    - all npm packages the build and the tests need, ready to use
    - the viewer already built (folder "viewer")


IF YOU ONLY WANT TO USE THE MAP

  Nothing has to be installed. Open viewer\viewer.html in Edge or Chrome and read
  viewer\README.md.


INSTALLING (to build the viewer yourself)

  1. Unpack the whole zip file.
  2. Double-click install.cmd.

  It installs to   %LOCALAPPDATA%\Programs\ArchitectureMap
  For another folder:   install.cmd "D:\Tools\ArchitectureMap"

  The installer unpacks Node.js, checks every packed file against the checksums in
  manifest.json, unpacks the source and the packages, and builds the viewer once to show
  that this computer can. It takes a minute or two and about 300 MB.

  Nothing is written outside the installation folder: no registry entry, no PATH, no
  shortcut, no service.


AFTER INSTALLING - in the installation folder

  build.cmd       builds the viewer             ->  app\dist\viewer.html and its folder
  test.cmd        runs the unit tests
  smoke.cmd       runs the browser test of the built viewer (needs Edge or Chrome)
  dev.cmd         starts the development server and opens the viewer
  shell.cmd       a command prompt with the Node.js and npm of the kit on the PATH
  app\            the source code; app\README.md describes the project
  viewer\         the viewer as it came with the kit
  node\           Node.js {{node}}
  install-info.json   which version this is

  The folder can be moved or copied as a whole: nothing in it refers to where it is.


UNINSTALLING

  Delete the installation folder. Nothing else was changed on the computer.


REQUIREMENTS

  Windows 10 (version 1803 or newer) or Windows 11, 64-bit Intel/AMD.
  About 300 MB of free disk space.
  For smoke.cmd: Microsoft Edge or Google Chrome.

  This kit is for Windows on Intel/AMD only: Node.js and some of the packages are programs
  made for one system. Other systems need Node.js and "npm ci" (app\README.md).


IF WINDOWS ASKS BEFORE RUNNING install.cmd

  A file that came from the internet or by e-mail is marked by Windows, and it asks before
  running a command file from it. That question is about where the file came from, not
  about what it does. install.cmd and installer\install.mjs are plain text: open them in
  an editor to see what they do.


WHAT IS INSIDE, AND HOW TO CHECK IT

  manifest.json lists every packed file with its size and SHA-256 checksum. The installer
  compares them before it unpacks anything.

  payload\{{nodeFile}}
      The file published by nodejs.org, unchanged. Its SHA-256:
      {{nodeSha256}}
      It can be compared with SHASUMS256.txt in the folder of that release on nodejs.org.
  payload\app-source.zip
      The source code as committed: {{commit}}
  payload\node_modules.tar.gz
      The npm packages, as "npm ci" installed them from package-lock.json, which holds
      the checksum of every package.

  The checksum of the kit as a whole is in the file {{zipName}}.sha256 that comes with it.


LICENCES

  Node.js:        node\LICENSE (after installing; inside the Node.js archive before)
  npm packages:   each package brings its licence in app\node_modules
  The viewer:     viewer\THIRD-PARTY-NOTICES.txt lists the software inside viewer.html
