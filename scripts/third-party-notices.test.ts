import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  licenseProblem,
  packageDirOf,
  readPackage,
  renderNotices,
  sourceAddress,
  type BundledPackage,
} from './third-party-notices.ts';

function pkg(overrides: Partial<BundledPackage> = {}): BundledPackage {
  return {
    name: 'left-pad',
    version: '1.0.0',
    license: 'MIT',
    source: 'https://github.com/example/left-pad',
    licenseText: 'MIT License\n\nCopyright (c) Example\n',
    ...overrides,
  };
}

describe('packageDirOf', () => {
  it('is the directory of the package a module belongs to', () => {
    expect(packageDirOf('/repo/node_modules/react/index.js')).toBe('/repo/node_modules/react');
    expect(packageDirOf('H:\\repo\\node_modules\\@xyflow\\react\\dist\\esm\\index.js')).toBe(
      'H:/repo/node_modules/@xyflow/react',
    );
    expect(packageDirOf('/repo/node_modules/zod/v4/core/schemas.js?commonjs-proxy')).toBe(
      '/repo/node_modules/zod',
    );
  });

  it('takes the innermost package of a nested one', () => {
    expect(packageDirOf('/repo/node_modules/a/node_modules/@s/b/lib/x.js')).toBe(
      '/repo/node_modules/a/node_modules/@s/b',
    );
  });

  it('is undefined for the own code and for modules the bundler makes up', () => {
    expect(packageDirOf('/repo/src/main.tsx')).toBeUndefined();
    expect(packageDirOf('\0rolldown/runtime.js')).toBeUndefined();
    expect(packageDirOf('\0/repo/node_modules/react/index.js?commonjs-exports')).toBeUndefined();
    expect(packageDirOf('/repo/node_modules/@scope')).toBeUndefined();
  });
});

describe('sourceAddress', () => {
  it('turns the repository of a package.json into a web address', () => {
    expect(sourceAddress({ type: 'git', url: 'git+https://github.com/a/b.git' })).toBe(
      'https://github.com/a/b',
    );
    expect(sourceAddress({ url: 'git://github.com/a/b.git' })).toBe('https://github.com/a/b');
    expect(sourceAddress('git@github.com:a/b.git')).toBe('https://github.com/a/b');
    expect(sourceAddress('github:a/b')).toBe('https://github.com/a/b');
    expect(sourceAddress('a/b')).toBe('https://github.com/a/b');
    expect(sourceAddress('https://example.org/src')).toBe('https://example.org/src');
  });

  it('is empty when the package names none', () => {
    expect(sourceAddress(undefined)).toBe('');
    expect(sourceAddress({})).toBe('');
    expect(sourceAddress(7)).toBe('');
  });
});

describe('licenseProblem', () => {
  it('accepts the permissive licences', () => {
    for (const license of ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0']) {
      expect(licenseProblem(pkg({ license })), license).toBeUndefined();
    }
  });

  it('stops at any other licence, and at none', () => {
    for (const license of ['GPL-3.0-only', 'AGPL-3.0', 'EPL-2.0', 'MIT OR GPL-2.0', 'UNLICENSED']) {
      expect(licenseProblem(pkg({ license })), license).toMatch(/has not been accepted/);
    }
    expect(licenseProblem(pkg({ license: '' }))).toMatch(/"none declared"/);
  });

  it('accepts a reviewed package only under the licence it was reviewed with', () => {
    const elk = { name: 'elkjs', version: '0.12.0' };
    expect(licenseProblem(pkg({ ...elk, license: 'EPL-2.0 OR GPL-3.0-or-later' }))).toBeUndefined();
    expect(licenseProblem(pkg({ ...elk, license: 'GPL-3.0-or-later' }))).toMatch(
      /elkjs 0\.12\.0: licence "GPL-3\.0-or-later" has not been accepted/,
    );
    // Not even a permissive one: the review was of something else.
    expect(licenseProblem(pkg({ ...elk, license: 'MIT' }))).toMatch(/has not been accepted/);
  });

  it('stops at a package without a licence text to pass on', () => {
    expect(licenseProblem(pkg({ licenseText: ' \n' }))).toBe(
      'left-pad 1.0.0: the package ships no licence file',
    );
  });
});

describe('renderNotices', () => {
  const text = renderNotices([
    pkg({ name: 'zod', version: '4.6.5', licenseText: 'MIT License\r\nCopyright (c) Zod\r\n' }),
    pkg({
      name: 'elkjs',
      version: '0.12.0',
      license: 'EPL-2.0 OR GPL-3.0-or-later',
      source: 'https://github.com/kieler/elkjs',
      licenseText: 'Eclipse Public License - v 2.0',
    }),
    pkg({ name: '@xyflow/react', version: '12.12.0', source: '' }),
  ]);

  it('lists the components by name, then gives every licence text', () => {
    const lines = text.split('\n');
    expect(lines[0]).toBe('THIRD-PARTY SOFTWARE NOTICES');
    const table = lines.slice(lines.findIndex((line) => line.startsWith('Component')));
    expect(table.slice(0, 5)).toEqual([
      'Component      Version  Licence',
      '-------------  -------  -------',
      '@xyflow/react  12.12.0  MIT',
      'elkjs          0.12.0   EPL-2.0 OR GPL-3.0-or-later',
      'zod            4.6.5    MIT',
    ]);
    expect(text).toContain(
      'zod 4.6.5\nLicence: MIT\nSource code: https://github.com/example/left-pad\n',
    );
    expect(text).toContain('MIT License\nCopyright (c) Zod\n');
    expect(text).not.toContain('\r');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('says under which licence a reviewed package is used, and leaves out an unknown source', () => {
    expect(text).toMatch(
      /elkjs 0\.12\.0\nLicence: EPL-2\.0 OR GPL-3\.0-or-later\nSource code: https:\/\/github\.com\/kieler\/elkjs\nUsed under the Eclipse Public License 2\.0, unmodified\./,
    );
    expect(text).toMatch(/@xyflow\/react 12\.12\.0\nLicence: MIT\n-{78}\n/);
  });
});

describe('readPackage', () => {
  it('reads name, version, licence, source and licence text of an installed package', async () => {
    const react = await readPackage(path.resolve('node_modules/react'));
    expect(react.name).toBe('react');
    expect(react.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(react.license).toBe('MIT');
    expect(react.source).toMatch(/^https:\/\/github\.com\/[\w-]+\/react$/);
    expect(react.licenseText).toMatch(/MIT License[\s\S]*Permission is hereby granted/);
    expect(licenseProblem(react)).toBeUndefined();
  });
});
