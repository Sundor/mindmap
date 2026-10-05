#!/usr/bin/env node
// Builds the build kit: one zip file with which a Windows computer can build the viewer without
// internet access and without anything installed system-wide (README.md, "The build kit").
//
//   npm run installer                  release/architecture-map-<version>-win-x64.zip (+ .sha256)
//   npm run installer -- --verify      also installs the kit into a scratch folder, as a user would
//   npm run installer -- --skip-tests  does not run the unit tests on the staged source
//   npm run installer -- --allow-dirty takes HEAD although the working tree has changes
//
// The kit is made from what is committed (`git archive HEAD`), never from the working tree:
//   1. the Node.js archive of nodejs.org, checked against the checksum pinned below;
//   2. the source, unpacked into a staging folder, where — with that same Node.js — `npm ci`
//      installs the packages (each checked against package-lock.json), the unit tests run and
//      the viewer is built;
//   3. the source, the packages, the built viewer, the installer and a manifest with the
//      checksum of every file are packed.
//
// Runs on Windows x64 only: the packages hold programs for the system they were installed on.
// Node built-ins only.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Node.js that goes into the kit. To change it: take the version and the SHA-256 of
 * `node-v<version>-win-x64.zip` from SHASUMS256.txt in the folder of that release on nodejs.org.
 */
export const KIT_NODE = {
  version: '24.15.0',
  sha256: 'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62',
};
export const KIT_PLATFORM = 'win-x64';
/** What the unpacked kit needs on disk once installed, for the summary. */
const APP_NAME = 'Architecture Map';
const FILE_STEM = 'architecture-map';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptsDir);

/**
 * The version of a kit: the version of the app when the commit is that release (tagged
 * `v<version>`), else the version with the commit as build metadata (Semantic Versioning §10),
 * and `.dirty` when the working tree had changes that are not in the kit.
 * @param {string} version
 * @param {{ tag?: string, commit: string, dirty?: boolean }} state
 * @returns {string}
 */
export function kitLabel(version, { tag, commit, dirty = false }) {
  if (tag === `v${version}` && !dirty) return version;
  return `${version}+${commit.slice(0, 7)}${dirty ? '.dirty' : ''}`;
}

/** @param {string} label @returns {string} the name of the kit: its folder, and its zip file */
export function kitName(label) {
  return `${FILE_STEM}-${label}-${KIT_PLATFORM}`;
}

/** @param {string} version @returns {string} */
export function nodeArchiveName(version) {
  return `node-v${version}-${KIT_PLATFORM}.zip`;
}

/**
 * The text of a `.sha256` file, as `sha256sum -c` and `Get-FileHash` users expect it.
 * @param {string} sha256
 * @param {string} fileName
 */
export function checksumLine(sha256, fileName) {
  return `${sha256}  ${fileName}\n`;
}

/**
 * `text` with every `{{key}}` replaced; an unknown key is an error, so that no placeholder
 * reaches a reader.
 * @param {string} text
 * @param {Record<string, string>} values
 */
export function fillTemplate(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, /** @type {string} */ key) => {
    const value = values[key];
    if (value === undefined) throw new Error(`no value for {{${key}}}`);
    return value;
  });
}

/** @param {string} text @returns {string} `text` with Windows line ends, whatever it had */
export function withCrLf(text) {
  return text.replace(/\r\n?|\n/g, '\r\n');
}

/** @param {string} file */
async function sha256Of(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

/**
 * Every file below `dir`, as paths relative to it with forward slashes.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
async function filesBelow(dir, prefix = '') {
  /** @type {string[]} */
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory())
      found.push(...(await filesBelow(path.join(dir, entry.name), relative)));
    else found.push(relative);
  }
  return found;
}

/** @param {string} text */
const say = (text) => console.log(`installer: ${text}`);

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions & { quiet?: boolean }} [options]
 * @returns {string} what the command printed, when `quiet`
 */
function run(command, args, { quiet = false, ...options } = {}) {
  const result = spawnSync(command, args, {
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 2 ** 20,
    ...options,
  });
  if (result.error) throw new Error(`${path.basename(command)}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} ${args.slice(0, 3).join(' ')} ended with code ${result.status}` +
        (quiet ? `\n${result.stderr}` : ''),
    );
  }
  return quiet ? String(result.stdout).trim() : '';
}

/** @param {string[]} args @returns {string} */
const git = (...args) => run('git', args, { cwd: repoRoot, quiet: true });

/**
 * The Node.js archive: from the cache of earlier runs, else downloaded; in both cases only
 * taken when its checksum is the pinned one.
 * @param {string} cacheDir
 * @returns {Promise<string>} the path of the archive
 */
async function nodeArchive(cacheDir) {
  const name = nodeArchiveName(KIT_NODE.version);
  const file = path.join(cacheDir, name);
  if (existsSync(file) && (await sha256Of(file)) === KIT_NODE.sha256) return file;
  const url = `https://nodejs.org/dist/v${KIT_NODE.version}/${name}`;
  say(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (sha256 !== KIT_NODE.sha256) {
    throw new Error(
      `${name}: SHA-256 is ${sha256}, not the pinned ${KIT_NODE.sha256} — not taken.`,
    );
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, body);
  return file;
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  for (const flag of flags) {
    if (!['--verify', '--skip-tests', '--allow-dirty'].includes(flag)) {
      throw new Error(`unknown option ${flag} (--verify, --skip-tests, --allow-dirty)`);
    }
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(
      `the kit is made on Windows x64 (this is ${process.platform} ${process.arch}).`,
    );
  }
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (!existsSync(tar)) throw new Error(`${tar} not found (Windows 10 version 1803 or newer).`);

  // --- What is being packed -----------------------------------------------------------------
  const dirty = git('status', '--porcelain') !== '';
  if (dirty && !flags.has('--allow-dirty')) {
    throw new Error(
      'the working tree has changes that are not committed. The kit is made from the commit: ' +
        'commit them first (or pass --allow-dirty to pack HEAD without them).',
    );
  }
  const commit = git('rev-parse', 'HEAD');
  const version = String(
    JSON.parse(git('show', 'HEAD:package.json')).version, // the committed one, like the source
  );
  const tag = git('tag', '--points-at', 'HEAD')
    .split(/\r?\n/)
    .find((name) => name === `v${version}`);
  const label = kitLabel(version, { tag, commit, dirty });
  const name = kitName(label);
  say(
    `${APP_NAME} ${label} (${commit.slice(0, 7)}${tag ? `, tagged ${tag}` : ', not a tagged release'})`,
  );

  const release = path.join(repoRoot, 'release');
  const work = path.join(release, 'work');
  const kit = path.join(work, name);
  const stage = path.join(work, 'stage');
  const app = path.join(stage, 'app');
  await rm(work, { recursive: true, force: true });
  await mkdir(path.join(kit, 'payload'), { recursive: true });
  await mkdir(path.join(kit, 'installer'), { recursive: true });
  await mkdir(app, { recursive: true });

  // --- 1. Node.js -----------------------------------------------------------------------------
  const nodeZip = await nodeArchive(path.join(release, 'cache'));
  const nodeFile = path.basename(nodeZip);
  await cp(nodeZip, path.join(kit, 'payload', nodeFile));
  run(tar, ['-xf', nodeZip, '-C', stage]);
  const nodeDir = path.join(stage, `node-v${KIT_NODE.version}-${KIT_PLATFORM}`);
  const node = path.join(nodeDir, 'node.exe');
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  /** @param {string[]} args */
  const npm = (...args) =>
    run(node, [npmCli, ...args], {
      cwd: app,
      env: {
        ...process.env,
        PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}`,
        npm_config_update_notifier: 'false',
      },
    });

  // --- 2. The source, its packages, its tests, the viewer --------------------------------------
  const sourceZip = path.join(kit, 'payload', 'app-source.zip');
  git('archive', '--format=zip', '-o', sourceZip, 'HEAD');
  run(tar, ['-xf', sourceZip, '-C', app]);
  say(`npm ci, with the Node.js ${KIT_NODE.version} of the kit`);
  npm('ci', '--no-audit', '--no-fund', '--prefer-offline');
  // Packed now, before anything writes its caches into node_modules.
  const packagesFile = path.join(kit, 'payload', 'node_modules.tar.gz');
  say('packing the npm packages');
  run(tar, ['-czf', packagesFile, '-C', app, 'node_modules']);
  const packedPaths = (await filesBelow(path.join(app, 'node_modules'))).map(
    (file) => `app/node_modules/${file}`,
  );
  if (!flags.has('--skip-tests')) {
    say('unit tests on the staged source');
    npm('test');
  }
  say('building the viewer from the staged source');
  npm('run', 'build');
  await cp(path.join(app, 'dist'), path.join(kit, 'viewer'), { recursive: true });
  const viewerSha256 = await sha256Of(path.join(kit, 'viewer', 'viewer.html'));

  // --- 3. The installer, its manifest, the zip -------------------------------------------------
  const installerDir = path.join(scriptsDir, 'installer');
  await writeFile(
    path.join(kit, 'install.cmd'),
    withCrLf(await readFile(path.join(installerDir, 'install.cmd'), 'utf8')),
  );
  await cp(path.join(installerDir, 'install.mjs'), path.join(kit, 'installer', 'install.mjs'));
  await writeFile(
    path.join(kit, 'README.txt'),
    withCrLf(
      fillTemplate(await readFile(path.join(installerDir, 'README.txt'), 'utf8'), {
        label,
        version,
        commit,
        node: KIT_NODE.version,
        nodeFile,
        nodeSha256: KIT_NODE.sha256,
        zipName: `${name}.zip`,
      }),
    ),
  );
  // The longest path the installation will have below its folder: source, packages, and what
  // a build adds (dist is in the staging folder by now).
  const installedPaths = [
    ...(await filesBelow(app)).map((file) => `app/${file}`),
    ...packedPaths,
    ...(await filesBelow(nodeDir)).map((file) => `node/${file}`),
    ...(await filesBelow(path.join(kit, 'viewer'))).map((file) => `viewer/${file}`),
  ];
  const longestPath = Math.max(...installedPaths.map((file) => file.length));
  const packed = (await filesBelow(kit)).filter((file) => file !== 'manifest.json').sort();
  const manifest = {
    name: APP_NAME,
    version,
    label,
    commit,
    platform: KIT_PLATFORM,
    node: { version: KIT_NODE.version, file: nodeFile },
    payload: {
      source: 'payload/app-source.zip',
      packages: 'payload/node_modules.tar.gz',
      viewer: 'viewer',
    },
    longestPath,
    viewerSha256,
    files: await Promise.all(
      packed.map(async (file) => {
        const full = path.join(kit, ...file.split('/'));
        return { path: file, bytes: (await stat(full)).size, sha256: await sha256Of(full) };
      }),
    ),
  };
  await writeFile(path.join(kit, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const zip = path.join(release, `${name}.zip`);
  await rm(zip, { force: true });
  say('zipping');
  run(tar, ['-a', '-cf', zip, '-C', work, name]);
  const zipSha256 = await sha256Of(zip);
  await writeFile(`${zip}.sha256`, checksumLine(zipSha256, path.basename(zip)));
  const megabytes = ((await stat(zip)).size / 2 ** 20).toFixed(1);

  // --- 4. A trial installation, from the zip, as a user would ----------------------------------
  if (flags.has('--verify')) {
    const trial = path.join(work, 'trial');
    const unpacked = path.join(trial, 'unpacked');
    const target = path.join(trial, 'installed');
    await mkdir(unpacked, { recursive: true });
    run(tar, ['-xf', zip, '-C', unpacked]);
    say(`trial installation into ${target}`);
    // cmd.exe reads its command line by rules of its own: with /s it takes off the outer quotes
    // and leaves the rest, so both paths may contain spaces.
    run(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `""${path.join(unpacked, name, 'install.cmd')}" "${target}""`],
      {
        env: { ...process.env, ARCHITECTURE_MAP_SILENT: '1' },
        windowsVerbatimArguments: true,
      },
    );
    for (const expected of [
      'node/node.exe',
      'app/package.json',
      'app/node_modules/vite/package.json',
      'app/dist/viewer.html',
      'viewer/viewer.html',
      'build.cmd',
      'install-info.json',
      'README.txt',
    ]) {
      if (!existsSync(path.join(target, ...expected.split('/')))) {
        throw new Error(`the trial installation has no ${expected}`);
      }
    }
    const rebuilt = await sha256Of(path.join(target, 'app', 'dist', 'viewer.html'));
    say(
      rebuilt === viewerSha256
        ? 'trial installation: built a viewer identical to the one in the kit'
        : 'trial installation: built a viewer that DIFFERS from the one in the kit',
    );
  }

  await rm(work, { recursive: true, force: true });
  say(`${path.relative(repoRoot, zip)}  ${megabytes} MB`);
  say(`SHA-256 ${zipSha256}`);
  if (label !== version) {
    say(
      `note: this is not the release ${version} — the commit is not tagged v${version}${dirty ? ', and the working tree has changes that are not in the kit' : ''}.`,
    );
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(`installer: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
