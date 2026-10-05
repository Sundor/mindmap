import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checksumLine,
  fillTemplate,
  KIT_NODE,
  kitLabel,
  kitName,
  nodeArchiveName,
  withCrLf,
} from './make-installer.mjs';

const installerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'installer');
const COMMIT = '551aac5f00000000000000000000000000000000';

describe('kitLabel', () => {
  it('is the version itself for the commit that is tagged as that release', () => {
    expect(kitLabel('0.1.0', { tag: 'v0.1.0', commit: COMMIT })).toBe('0.1.0');
  });

  it('carries the commit as build metadata for any other commit', () => {
    expect(kitLabel('0.1.0', { commit: COMMIT })).toBe('0.1.0+551aac5');
    // The tag of another version does not make it a release of this one.
    expect(kitLabel('0.2.0', { tag: 'v0.1.0', commit: COMMIT })).toBe('0.2.0+551aac5');
  });

  it('says so when the working tree had changes that are not in the kit', () => {
    expect(kitLabel('0.1.0', { tag: 'v0.1.0', commit: COMMIT, dirty: true })).toBe(
      '0.1.0+551aac5.dirty',
    );
  });

  it('stays a valid semantic version', () => {
    const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
    for (const label of [
      kitLabel('0.1.0', { tag: 'v0.1.0', commit: COMMIT }),
      kitLabel('1.2.3', { commit: COMMIT }),
      kitLabel('1.2.3-rc.1', { commit: COMMIT, dirty: true }),
    ]) {
      expect(label, label).toMatch(semver);
    }
  });
});

describe('names', () => {
  it('names the kit after the app, its version and the system it is for', () => {
    expect(kitName('0.1.0')).toBe('architecture-map-0.1.0-win-x64');
    expect(kitName('0.1.0+551aac5')).toBe('architecture-map-0.1.0+551aac5-win-x64');
  });

  it('names the Node.js archive as nodejs.org does', () => {
    expect(nodeArchiveName('24.15.0')).toBe('node-v24.15.0-win-x64.zip');
  });

  it('pins a Node.js version with the checksum of its archive', () => {
    expect(KIT_NODE.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(KIT_NODE.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes a checksum file the usual tools read', () => {
    expect(checksumLine('ab'.repeat(32), 'kit.zip')).toBe(`${'ab'.repeat(32)}  kit.zip\n`);
  });
});

describe('fillTemplate', () => {
  it('puts the values in', () => {
    expect(fillTemplate('{{name}} {{version}}, {{name}}', { name: 'Map', version: '1' })).toBe(
      'Map 1, Map',
    );
    // A value is taken as it is, whatever is in it.
    expect(fillTemplate('{{a}}', { a: '$& {{b}} $1' })).toBe('$& {{b}} $1');
  });

  it('refuses a placeholder it has no value for', () => {
    expect(() => fillTemplate('{{name}} {{missing}}', { name: 'Map' })).toThrow(/\{\{missing\}\}/);
  });
});

describe('withCrLf', () => {
  it('gives every line a Windows line end, whatever it had', () => {
    expect(withCrLf('a\nb\r\nc\rd')).toBe('a\r\nb\r\nc\r\nd');
    expect(withCrLf('one line')).toBe('one line');
  });
});

describe('the files of the installer', () => {
  it('README.txt uses only the values the kit builder fills in', async () => {
    const template = await readFile(path.join(installerDir, 'README.txt'), 'utf8');
    const text = fillTemplate(template, {
      label: '0.1.0',
      version: '0.1.0',
      commit: COMMIT,
      node: KIT_NODE.version,
      nodeFile: nodeArchiveName(KIT_NODE.version),
      nodeSha256: KIT_NODE.sha256,
      zipName: `${kitName('0.1.0')}.zip`,
    });
    expect(text).not.toMatch(/\{\{|\}\}/);
    expect(text).toContain('Architecture Map 0.1.0 - build kit');
    expect(text).toContain(KIT_NODE.sha256);
  });

  it('install.cmd only jumps to labels it has', async () => {
    const script = await readFile(path.join(installerDir, 'install.cmd'), 'utf8');
    const lines = script.split(/\r?\n/);
    const labels = new Set(
      lines.filter((line) => /^:\w+$/.test(line.trim())).map((line) => line.trim().slice(1)),
    );
    const jumps = [...script.matchAll(/goto :(\w+)/g)].map((match) => match[1]);
    expect(jumps.length).toBeGreaterThan(5);
    for (const jump of jumps) expect(labels, `goto :${jump}`).toContain(jump);
  });

  it('install.cmd never expands a user path inside a bracketed block', async () => {
    // A folder like "C:\Users\Ann (Admin)" would end the block early.
    const script = await readFile(path.join(installerDir, 'install.cmd'), 'utf8');
    const code = script.split(/\r?\n/).filter((line) => !/^\s*(rem\b|echo\b)/i.test(line));
    for (const line of code) {
      if (/^\s*(if|for)\b.*\($/.test(line)) throw new Error(`a block is opened: ${line}`);
    }
    expect(script).toMatch(/DisableDelayedExpansion/);
  });
});
