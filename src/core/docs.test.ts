// The guide of the viewer folder (docs/viewer-README.md) shows the two template files as its
// complete files. The test fails when a template file and its block in the guide differ.

import { describe, expect, it } from 'vitest';
import guide from '../../docs/viewer-README.md?raw';
import templateYaml from '../../examples/template/architecture.yaml?raw';
import templateJson from '../../examples/template/workitems.json?raw';

/** `text` with Windows line ends made plain ones. */
const plain = (text: string): string => text.replace(/\r\n/g, '\n');

/** The fenced blocks of `language` in a Markdown text, each without its fences. */
function fencedBlocks(markdown: string, language: string): string[] {
  const blocks: string[] = [];
  let block: string[] | undefined;
  for (const line of markdown.split('\n')) {
    if (block === undefined) {
      if (line === '```' + language) block = [];
    } else if (line === '```') {
      blocks.push(block.map((inner) => inner + '\n').join(''));
      block = undefined;
    } else {
      block.push(line);
    }
  }
  return blocks;
}

/** How many characters two texts have in common from their start. */
function commonStart(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return length;
}

/** The block of the guide that agrees with `file` furthest from its start: the one meant as it. */
function blockFor(language: string, file: string): string | undefined {
  let best: string | undefined;
  for (const block of fencedBlocks(plain(guide), language)) {
    if (best === undefined || commonStart(block, file) > commonStart(best, file)) best = block;
  }
  return best;
}

describe('docs/viewer-README.md', () => {
  it('the guide shows the template files as they are', () => {
    expect(blockFor('yaml', plain(templateYaml))).toBe(plain(templateYaml));
    expect(blockFor('json', plain(templateJson))).toBe(plain(templateJson));
  });
});
