// Build step that lists the third-party software inside dist/viewer.html with its licences.
// The bundle is minified, which drops the licence comments of the libraries; most of the
// licences ask for the notice to go with every copy.
//
// The list is taken from the modules that are really in the bundle, not from package.json, and
// the build fails for a licence nobody has looked at — so a new dependency cannot bring one in
// unnoticed.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Name of the notices file next to the viewer. */
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.txt';

/** Licences that ask for no more than keeping their notice with the copies. */
const ACCEPTED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
]);

/**
 * Packages under another licence that have been looked at, with the licence they declare (a
 * change of it is a reason to look again) and what the notices say about it.
 */
const REVIEWED_PACKAGES: Readonly<Record<string, { license: string; note: string }>> = {
  elkjs: {
    license: 'EPL-2.0 OR GPL-3.0-or-later',
    note:
      'Used under the Eclipse Public License 2.0, unmodified. Its source code is available ' +
      'from the address above.',
  },
};

export interface BundledPackage {
  readonly name: string;
  readonly version: string;
  /** The `license` of its package.json; empty when it declares none. */
  readonly license: string;
  /** Where its source code is; empty when unknown. */
  readonly source: string;
  /** The text of its licence files; empty when it ships none. */
  readonly licenseText: string;
}

/**
 * The directory of the installed package a module belongs to, or undefined for a module that is
 * not from a package (the app's own code, virtual modules of the bundler).
 */
export function packageDirOf(moduleId: string): string | undefined {
  if (moduleId.startsWith('\0')) return undefined;
  const id = moduleId.replace(/\\/g, '/').replace(/[?#].*$/, '');
  const marker = '/node_modules/';
  const at = id.lastIndexOf(marker);
  if (at < 0) return undefined;
  const [first, second] = id.slice(at + marker.length).split('/');
  if (!first) return undefined;
  const name = first.startsWith('@') ? (second ? `${first}/${second}` : undefined) : first;
  return name === undefined ? undefined : id.slice(0, at + marker.length) + name;
}

/** The address of a package's source code, from the `repository` of its package.json. */
export function sourceAddress(repository: unknown): string {
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' && repository !== null && 'url' in repository
        ? String(repository.url)
        : '';
  const url = raw
    .trim()
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '');
  if (url === '' || /^https?:\/\//.test(url)) return url;
  // The short form `owner/repository` means GitHub.
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

/** Why the licence of `pkg` stops the build, or undefined when it is fine. */
export function licenseProblem(pkg: BundledPackage): string | undefined {
  const where = `${pkg.name} ${pkg.version}`;
  const reviewed = REVIEWED_PACKAGES[pkg.name];
  const accepted = reviewed ? reviewed.license === pkg.license : ACCEPTED_LICENSES.has(pkg.license);
  if (!accepted) {
    return (
      `${where}: licence "${pkg.license || 'none declared'}" has not been accepted for the ` +
      `viewer — see ACCEPTED_LICENSES and REVIEWED_PACKAGES in scripts/third-party-notices.ts`
    );
  }
  if (pkg.licenseText.trim() === '') return `${where}: the package ships no licence file`;
  return undefined;
}

const RULE = '='.repeat(78);
const THIN_RULE = '-'.repeat(78);

/** The notices file: a table of what is in the viewer, then every licence text. */
export function renderNotices(packages: readonly BundledPackage[]): string {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const width = (pick: (pkg: BundledPackage) => string, heading: string) =>
    Math.max(heading.length, ...sorted.map((pkg) => pick(pkg).length));
  const nameWidth = width((pkg) => pkg.name, 'Component');
  const versionWidth = width((pkg) => pkg.version, 'Version');
  const row = (name: string, version: string, license: string) =>
    `${name.padEnd(nameWidth)}  ${version.padEnd(versionWidth)}  ${license}`;
  const lines = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    'viewer.html contains the software listed below, unmodified and in minified form. Each',
    'component is the property of its authors and is used under the licence named here; the',
    'licence texts follow the list. This file is written by the build from what is in the',
    'bundle, and its content is also at the end of viewer.html.',
    '',
    row('Component', 'Version', 'Licence'),
    row('-'.repeat(nameWidth), '-'.repeat(versionWidth), '-------'),
    ...sorted.map((pkg) => row(pkg.name, pkg.version, pkg.license)),
  ];
  for (const pkg of sorted) {
    const note = REVIEWED_PACKAGES[pkg.name]?.note;
    lines.push(
      '',
      RULE,
      `${pkg.name} ${pkg.version}`,
      `Licence: ${pkg.license}`,
      ...(pkg.source === '' ? [] : [`Source code: ${pkg.source}`]),
      ...(note === undefined ? [] : [note]),
      THIN_RULE,
      pkg.licenseText.replace(/\r\n?/g, '\n').trim(),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Reads what the notices need from the installed package in `dir`. */
export async function readPackage(dir: string): Promise<BundledPackage> {
  const manifest: unknown = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const field = (key: string): unknown =>
    typeof manifest === 'object' && manifest !== null
      ? (manifest as Record<string, unknown>)[key]
      : undefined;
  const text = (key: string): string => {
    const value = field(key);
    return typeof value === 'string' ? value : '';
  };
  const names = (await readdir(dir)).filter((name) => /^(licen[cs]e|copying|notice)\b/i.test(name));
  const texts = await Promise.all(
    names.sort().map((name) => readFile(path.join(dir, name), 'utf8')),
  );
  return {
    name: text('name'),
    version: text('version'),
    license: text('license'),
    source: sourceAddress(field('repository')),
    licenseText: texts.join('\n\n'),
  };
}

/**
 * Vite plugin: writes {@link NOTICES_FILE} for the packages whose code is in the bundle, and
 * fails the build for a licence that has not been accepted.
 */
export function thirdPartyNotices(): Plugin {
  return {
    name: 'third-party-notices',
    apply: 'build',
    async generateBundle(_options, bundle) {
      const dirs = new Set<string>();
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        for (const id of file.moduleIds) {
          const dir = packageDirOf(id);
          if (dir !== undefined) dirs.add(dir);
        }
      }
      const packages = await Promise.all([...dirs].map(readPackage));
      const problems = packages.map(licenseProblem).filter((problem) => problem !== undefined);
      if (problems.length > 0) this.error(`Third-party licences:\n  ${problems.join('\n  ')}`);
      if (packages.length === 0) this.error('no third-party package found in the bundle');
      this.emitFile({ type: 'asset', fileName: NOTICES_FILE, source: renderNotices(packages) });
    },
  };
}
