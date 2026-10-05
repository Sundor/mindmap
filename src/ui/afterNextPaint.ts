/**
 * Resolves once the browser has had the chance to paint what was just rendered. For work that
 * blocks the main thread, so that the status announcing it is on screen while it runs.
 */
export function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    // A frame callback runs just before the paint; the timer it starts runs after it.
    requestAnimationFrame(() => setTimeout(finish, 0));
    // No frames are produced in a background tab: do not wait for one for ever.
    setTimeout(finish, 100);
  });
}
