#!/usr/bin/env node
// The installer of the Architecture Map build kit (README.md, "The build kit"). install.cmd
// unpacks the Node.js of the kit and runs this file with it:
//
//   node install.mjs <kit folder> <installation folder>
//
// It checks every packed file against manifest.json, unpacks the source and the npm packages,
// copies the built viewer, writes the helper commands, and builds the viewer once to show that
// this computer can. Nothing outside the installation folder is written.
//
// Node built-ins only: this file runs before any package is unpacked.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {object} PackedFile
 * @property {string} path  relative to the kit folder, with forward slashes
 * @property {number} bytes
 * @property {string} sha256  lower-case hex
 */

/**
 * @typedef {object} Manifest
 * @property {string} name
 * @property {string} version  the version of the app (package.json)
 * @property {string} label  the version of the kit: the app's, plus the commit when it is no release
 * @property {string} commit
 * @property {string} platform  e.g. `win-x64`
 * @property {{ version: string, file: string }} node
 * @property {{ source: string, packages: string, viewer: string }} payload  paths in the kit
 * @property {PackedFile[]} files
 * @property {number} longestPath  the longest path below the installation folder, in characters
 * @property {string} viewerSha256  of the built viewer.html in the kit
 */

/**
 * The longest path Windows takes without long-path support: 260 characters for a file, the
 * closing NUL included, and less for a folder.
 */
export const MAX_PATH = 247;

/** @param {string} file @returns {Promise<string>} the SHA-256 of the file, in lower-case hex */
export function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Compares the packed files with what the manifest says about them.
 * @param {string} kitDir
 * @param {readonly PackedFile[]} files
 * @returns {Promise<string[]>} what is wrong, one line per file; empty when all is as packed
 */
export async function verifyFiles(kitDir, files) {
  /** @type {string[]} */
  const problems = [];
  for (const file of files) {
    const full = path.join(kitDir, ...file.path.split('/'));
    const info = await stat(full).catch(() => undefined);
    if (!info?.isFile()) problems.push(`${file.path}: missing`);
    else if (info.size !== file.bytes) {
      problems.push(`${file.path}: ${info.size} bytes instead of ${file.bytes}`);
    } else if ((await sha256Of(full)) !== file.sha256) {
      problems.push(`${file.path}: the content is not what was packed (SHA-256 differs)`);
    }
  }
  return problems;
}

/**
 * Why the installation folder cannot be used, or undefined when it can. The command files npm
 * makes for the tools of a project (`node_modules\.bin\*.cmd`) do not work below a folder with
 * `&`, `^` or `%` in its name, and the paths below the folder must stay within what Windows
 * and its tools take.
 * @param {string} target
 * @param {number} longestPath
 * @returns {string | undefined}
 */
export function pathProblem(target, longestPath) {
  const unusable = [...new Set(target.match(/[&^%]/g) ?? [])];
  if (unusable.length > 0) {
    return (
      `The folder name has ${unusable.join(' ')} in it, and the tools of the kit do not work ` +
      `below such a folder. Give another one, for example:  install.cmd "C:\\ArchitectureMap"`
    );
  }
  const longest = target.length + 1 + longestPath;
  if (longest <= MAX_PATH) return undefined;
  const room = MAX_PATH - 1 - longestPath;
  return (
    `The folder name is too long: the files below it would get paths of up to ${longest} ` +
    `characters, and Windows takes ${MAX_PATH}. Use a folder whose full name has at most ` +
    `${room} characters, for example:  install.cmd "C:\\ArchitectureMap"`
  );
}

/**
 * A command file of the installation folder: the Node.js of the kit first on the PATH, npm's
 * own files kept inside the folder, then the command, run in the source folder. `%~dp0` is the
 * folder of the command file, so the installation can be moved.
 * @param {string} about  what the command does, for the first line
 * @param {string} command
 * @returns {string}
 */
function commandFile(about, command) {
  return [
    '@echo off',
    `rem Architecture Map: ${about}`,
    'setlocal',
    'set "PATH=%~dp0node;%PATH%"',
    'set "npm_config_cache=%~dp0npm-cache"',
    'set "npm_config_update_notifier=false"',
    'cd /d "%~dp0app" || exit /b 1',
    command,
    '',
  ].join('\r\n');
}

/**
 * The command files written into the installation folder, by file name.
 * @returns {Record<string, string>}
 */
export function helperCommands() {
  return {
    'build.cmd': commandFile(
      'builds the viewer into app\\dist (viewer.html and its folder).',
      'call npm.cmd run build',
    ),
    'test.cmd': commandFile('runs the unit tests.', 'call npm.cmd test'),
    'smoke.cmd': commandFile(
      'runs the browser test of the built viewer (needs Edge or Chrome; build first).',
      'call npm.cmd run smoke',
    ),
    'dev.cmd': commandFile(
      'starts the development server and opens the viewer in the browser.',
      'call npm.cmd run dev',
    ),
    'shell.cmd': commandFile(
      'a command prompt in the source folder, with the Node.js and npm of the kit.',
      'cmd /k echo Node.js and npm of the Architecture Map kit are on the PATH. Type exit to leave.',
    ),
  };
}

/**
 * What is noted in the installation folder about itself (`install-info.json`).
 * @param {Manifest} manifest
 * @returns {Record<string, string>}
 */
export function installInfo(manifest) {
  return {
    name: manifest.name,
    version: manifest.version,
    kit: manifest.label,
    commit: manifest.commit,
    platform: manifest.platform,
    node: manifest.node.version,
  };
}

/** @param {string} text */
const say = (text) => console.log(`  ${text}`);

class InstallError extends Error {}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [options]
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw new InstallError(`${path.basename(command)}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new InstallError(`${path.basename(command)} ended with code ${result.status}`);
  }
}

/**
 * @param {string} kitDir
 * @param {string} target
 */
async function install(kitDir, target) {
  /** @type {Manifest} */
  const manifest = JSON.parse(await readFile(path.join(kitDir, 'manifest.json'), 'utf8'));
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const app = path.join(target, 'app');
  const inKit = (/** @type {string} */ relative) => path.join(kitDir, ...relative.split('/'));

  say(
    `${manifest.name} ${manifest.label} for ${manifest.platform}, with Node.js ${process.version}`,
  );
  if (process.version !== `v${manifest.node.version}`) {
    throw new InstallError(
      `This is Node.js ${process.version}, not the ${manifest.node.version} of the kit: run install.cmd.`,
    );
  }
  const tooLong = pathProblem(target, manifest.longestPath);
  if (tooLong) throw new InstallError(tooLong);

  say('Checking the packed files ...');
  const problems = await verifyFiles(kitDir, manifest.files);
  if (problems.length > 0) {
    throw new InstallError(
      `The kit is damaged or incomplete — copy or download it again:\n    ${problems.join('\n    ')}`,
    );
  }

  say('Unpacking the source code ...');
  await mkdir(app, { recursive: true });
  run(tar, ['-xf', inKit(manifest.payload.source), '-C', app]);
  say('Unpacking the npm packages (the longest step) ...');
  run(tar, ['-xf', inKit(manifest.payload.packages), '-C', app]);
  say('Copying the built viewer ...');
  await cp(inKit(manifest.payload.viewer), path.join(target, 'viewer'), { recursive: true });

  for (const [name, content] of Object.entries(helperCommands())) {
    await writeFile(path.join(target, name), content);
  }
  await writeFile(
    path.join(target, 'install-info.json'),
    `${JSON.stringify(installInfo(manifest), null, 2)}\n`,
  );
  if (existsSync(path.join(kitDir, 'README.txt'))) {
    await cp(path.join(kitDir, 'README.txt'), path.join(target, 'README.txt'));
  }

  say('Building the viewer once, to see that this computer can ...');
  const nodeDir = path.dirname(process.execPath);
  run(
    process.execPath,
    [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'run', 'build'],
    {
      cwd: app,
      env: {
        ...process.env,
        PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}`,
        npm_config_cache: path.join(target, 'npm-cache'),
        npm_config_update_notifier: 'false',
      },
    },
  );
  const built = path.join(app, 'dist', 'viewer.html');
  if (!existsSync(built))
    throw new InstallError('The build did not produce app\\dist\\viewer.html.');
  const same = (await sha256Of(built)) === manifest.viewerSha256;

  console.log('');
  say(`Installed in ${target}`);
  say(
    same
      ? 'The viewer built here is identical, byte for byte, to the one that came with the kit.'
      : 'The viewer built here differs from the one in the kit (a different folder or system can do that).',
  );
  console.log('');
  say('viewer\\viewer.html   the viewer as shipped: open it in Edge or Chrome');
  say('build.cmd            builds the viewer from the source   ->  app\\dist');
  say('test.cmd, smoke.cmd  the unit tests, the browser test');
  say('dev.cmd, shell.cmd   the development server, a prompt with Node.js and npm');
  say('README.txt           the rest');
  say('To uninstall, delete the folder.');
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  const [kitArg, targetArg] = process.argv.slice(2);
  if (!kitArg || !targetArg) {
    console.error('Usage: node install.mjs <kit folder> <installation folder>   (run install.cmd)');
    process.exit(2);
  }
  const target = path.resolve(targetArg);
  try {
    await install(path.resolve(kitArg), target);
    if (!process.env.ARCHITECTURE_MAP_SILENT) {
      // Shows the result where the user is: the folder, in the file manager.
      spawnSync('explorer.exe', [target], { stdio: 'ignore' });
    }
  } catch (error) {
    console.error('');
    console.error(
      `  ${error instanceof InstallError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(1);
  }
}
