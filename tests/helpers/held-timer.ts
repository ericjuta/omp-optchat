/**
 * Turns a wall-clock bound into an event a test fires. While installed, every `setTimeout` armed with exactly
 * `ms` is held: it never fires on its own, and `fire()` runs the held timers not yet cleared. Timers with any
 * other delay stay real. A test then proves both that the code arms its bound with that delay and what happens
 * when it passes, with no clock sleep and no elapsed-time assertion. Always `restore()` in `finally`.
 */
export interface HeldTimers {
  /** How many timers were armed with the held delay since install, including cleared and fired ones. */
  readonly armed: number;
  /** Runs every held timer that is neither cleared nor already fired; returns how many ran. */
  fire(): number;
  restore(): void;
}

export function holdTimers(ms: number): HeldTimers {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const held = new Map<unknown, () => void>();
  let armed = 0;
  const set = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== ms) return realSet(callback, delay, ...args);
    armed++;
    // A real, never-due handle, so the code under test can clear it as usual.
    const handle = realSet(() => {}, 2 ** 31 - 1);
    handle.unref();
    held.set(handle, () => callback(...args));
    return handle;
  };
  const clear = (handle?: Parameters<typeof clearTimeout>[0]) => {
    held.delete(handle);
    realClear(handle);
  };
  globalThis.setTimeout = set as unknown as typeof setTimeout;
  globalThis.clearTimeout = clear as typeof clearTimeout;
  return {
    get armed() {
      return armed;
    },
    fire() {
      const due = [...held];
      held.clear();
      for (const [handle, run] of due) {
        realClear(handle as Parameters<typeof clearTimeout>[0]);
        run();
      }
      return due.length;
    },
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}
