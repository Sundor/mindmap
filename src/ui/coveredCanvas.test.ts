// What the control panel hides of the canvas, read from a page played by hand: the two
// elements the function looks for, each with the boxes the browser would give it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { coveredCanvasLeft } from './coveredCanvas';

/** An element as far as the function reads it: displayed or not, and where its box lies. */
function element(box: { readonly left: number; readonly right: number }, displayed = true) {
  return {
    getClientRects: () => (displayed ? [box] : []),
    getBoundingClientRect: () => box,
  };
}

/** A page with the tab panels and the column of the canvas; `undefined` for one it lacks. */
function page(panels?: ReturnType<typeof element>, column?: ReturnType<typeof element>) {
  vi.stubGlobal('document', {
    querySelector: (selector: string) =>
      (selector === '.cp-panels' ? panels : selector === '.app-column' ? column : undefined) ??
      null,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('coveredCanvasLeft', () => {
  it('is 0 where there is no document', () => {
    expect(typeof document).toBe('undefined');
    expect(coveredCanvasLeft()).toBe(0);
  });

  it('is how far the tab panels reach over the left of the canvas', () => {
    page(element({ left: 48, right: 368 }), element({ left: 48, right: 1000 }));
    expect(coveredCanvasLeft()).toBe(320);
  });

  it('is 0 while the panels stand beside the canvas', () => {
    page(element({ left: 48, right: 368 }), element({ left: 368, right: 1440 }));
    expect(coveredCanvasLeft()).toBe(0);
    page(element({ left: 48, right: 368 }), element({ left: 380, right: 1440 }));
    expect(coveredCanvasLeft()).toBe(0);
  });

  it('is 0 while the panels are not displayed', () => {
    page(element({ left: 0, right: 0 }, false), element({ left: 48, right: 1000 }));
    expect(coveredCanvasLeft()).toBe(0);
    // Not even where a box is still reported for them.
    page(element({ left: 48, right: 368 }, false), element({ left: 48, right: 1000 }));
    expect(coveredCanvasLeft()).toBe(0);
  });

  it('is 0 on a page that has no panels or no canvas', () => {
    page(undefined, element({ left: 48, right: 1000 }));
    expect(coveredCanvasLeft()).toBe(0);
    page(element({ left: 48, right: 368 }), undefined);
    expect(coveredCanvasLeft()).toBe(0);
    page();
    expect(coveredCanvasLeft()).toBe(0);
  });
});
