import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  helperCommands,
  installInfo,
  MAX_PATH,
  pathProblem,
  sha256Of,
  verifyFiles,
} from './install.mjs';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A kit folder with the given files; resolves to its path. */
async function kitWith(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(path.join(os.tmpdir(), 'arch-map-kit-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, ...name.split('/'));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

describe('sha256Of', () => {
  it('is the SHA-256 of the file content', async () => {
    const kit = await kitWith({ 'a.txt': 'hello' });
    expect(await sha256Of(path.join(kit, 'a.txt'))).toBe(sha256('hello'));
    await expect(sha256Of(path.join(kit, 'missing.txt'))).rejects.toThrow();
  });
});

describe('verifyFiles', () => {
  const packed = (name: string, content: string) => ({
    path: name,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
  });

  it('finds nothing wrong with a kit that is as it was packed', async () => {
    const kit = await kitWith({ 'install.cmd': 'echo', 'payload/app-source.zip': 'PK source' });
    expect(
      await verifyFiles(kit, [
        packed('install.cmd', 'echo'),
        packed('payload/app-source.zip', 'PK source'),
      ]),
    ).toEqual([]);
  });

  it('names every file that is missing, cut short or changed', async () => {
    const kit = await kitWith({
      'payload/cut.zip': 'PK sour',
      'payload/changed.zip': 'PK s0urce',
      'payload/folder.zip/inside': 'x',
    });
    expect(
      await verifyFiles(kit, [
        packed('payload/missing.zip', 'PK source'),
        packed('payload/cut.zip', 'PK source'),
        packed('payload/changed.zip', 'PK source'),
        packed('payload/folder.zip', 'x'),
      ]),
    ).toEqual([
      'payload/missing.zip: missing',
      'payload/cut.zip: 7 bytes instead of 9',
      'payload/changed.zip: the content is not what was packed (SHA-256 differs)',
      'payload/folder.zip: missing',
    ]);
  });
});

describe('pathProblem', () => {
  it('takes a folder below which every path stays within what Windows takes', () => {
    expect(pathProblem('C:\\Users\\ann\\AppData\\Local\\Programs\\ArchitectureMap', 140)).toBe(
      undefined,
    );
    const target = `C:\\${'x'.repeat(MAX_PATH - 1 - 140 - 3)}`;
    expect(target.length + 1 + 140).toBe(MAX_PATH);
    expect(pathProblem(target, 140)).toBeUndefined();
  });

  it('refuses a folder that is one character too long, and says how long it may be', () => {
    const target = `C:\\${'x'.repeat(MAX_PATH - 1 - 140 - 2)}`;
    const problem = pathProblem(target, 140) ?? '';
    expect(problem).toContain(`paths of up to ${MAX_PATH + 1} characters`);
    expect(problem).toContain(`at most ${MAX_PATH - 1 - 140} characters`);
    expect(problem).toContain('install.cmd "C:\\ArchitectureMap"');
  });

  it('refuses a folder with a character that breaks the command files of npm', () => {
    expect(pathProblem('D:\\R&D\\Map', 140)).toMatch(/has & in it/);
    expect(pathProblem('D:\\100%\\a^b & c', 140)).toMatch(/has % \^ & in it/);
    // Spaces, brackets and exclamation marks are fine.
    expect(pathProblem('D:\\Tools (new)\\Arch Map!', 140)).toBeUndefined();
  });
});

describe('helperCommands', () => {
  const commands = helperCommands();

  it('offers the build, the tests, the browser test, the dev server and a prompt', () => {
    expect(Object.keys(commands).sort()).toEqual([
      'build.cmd',
      'dev.cmd',
      'shell.cmd',
      'smoke.cmd',
      'test.cmd',
    ]);
    expect(commands['build.cmd']).toContain('call npm.cmd run build');
    expect(commands['test.cmd']).toContain('call npm.cmd test');
    expect(commands['smoke.cmd']).toContain('call npm.cmd run smoke');
    expect(commands['dev.cmd']).toContain('call npm.cmd run dev');
  });

  it('uses the Node.js of the kit and keeps npm inside the folder, wherever the folder is', () => {
    for (const [name, text] of Object.entries(commands)) {
      expect(text, name).toContain('set "PATH=%~dp0node;%PATH%"');
      expect(text, name).toContain('set "npm_config_cache=%~dp0npm-cache"');
      expect(text, name).toContain('cd /d "%~dp0app"');
      // No drive letter: nothing refers to where the folder was installed.
      expect(text, name).not.toMatch(/[A-Za-z]:\\/);
    }
  });

  it('has Windows line ends throughout', () => {
    for (const [name, text] of Object.entries(commands)) {
      expect(text.replace(/\r\n/g, ''), name).not.toMatch(/[\r\n]/);
      expect(text.endsWith('\r\n'), name).toBe(true);
    }
  });
});

describe('installInfo', () => {
  it('notes which version was installed, from which commit, with which Node.js', () => {
    expect(
      installInfo({
        name: 'Architecture Map',
        version: '0.1.0',
        label: '0.1.0+551aac5',
        commit: '551aac5f',
        platform: 'win-x64',
        node: { version: '24.15.0', file: 'node-v24.15.0-win-x64.zip' },
        payload: { source: 's', packages: 'p', viewer: 'v' },
        files: [],
        longestPath: 140,
        viewerSha256: 'ab',
      }),
    ).toEqual({
      name: 'Architecture Map',
      version: '0.1.0',
      kit: '0.1.0+551aac5',
      commit: '551aac5f',
      platform: 'win-x64',
      node: '24.15.0',
    });
  });
});
