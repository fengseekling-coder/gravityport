// Live sync reconnection resync trigger (pure logic, no React/DOM).

export interface ResyncHooks {
  onResync: () => void;
  delayMs?: number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (id: number) => void;
}

export interface ResyncController {
  handleOpen: () => void;
  handleChange: () => void;
  dispose: () => void;
}

/**
 * Creates a controller that triggers a resync on reconnection (EventSource open after first).
 * Debounced: multiple calls within delayMs only trigger once (last one wins).
 * The first open is skipped (initial page load handles that).
 * dispose() cancels any pending trigger and makes all further calls no-ops.
 */
export function createResyncOnReconnect(hooks: ResyncHooks): ResyncController {
  const { onResync, delayMs = 300, schedule = setTimeout, cancel = clearTimeout } = hooks;

  let firstOpen = true;
  let pendingTimer: number | null = null;
  let disposed = false;

  function triggerResync() {
    if (disposed) return;
    onResync();
    pendingTimer = null;
  }

  function scheduleResync() {
    if (disposed) return;
    if (pendingTimer !== null) {
      cancel(pendingTimer);
    }
    pendingTimer = schedule(triggerResync, delayMs);
  }

  return {
    handleOpen() {
      if (disposed) return;
      if (firstOpen) {
        firstOpen = false;
        return;
      }
      scheduleResync();
    },

    handleChange() {
      if (disposed) return;
      scheduleResync();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (pendingTimer !== null) {
        cancel(pendingTimer);
        pendingTimer = null;
      }
    },
  };
}
