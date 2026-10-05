// Access to `localStorage` that never throws (the app must work without it).

import type { ViewStateStorage } from '../core';

/** `window.localStorage`, or undefined where it is unavailable or blocked (privacy settings). */
export function browserStorage(): ViewStateStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
