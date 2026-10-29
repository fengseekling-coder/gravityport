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

export interface SseRefreshGateHooks {
  /** True while a refresh must not fire right now: an import is running, or
   * the gallery has a load in flight. */
  isBlocked: () => boolean;
  /** The actual refresh (bumps the gallery's navigation key). */
  refresh: () => void;
}

export interface SseRefreshGate {
  /** An SSE push asked for a refresh. Fires `refresh` immediately unless
   * blocked; while blocked it never aborts the work in flight — it queues at
   * most ONE follow-up refresh, no matter how many pushes arrive. */
  request: () => void;
  /** The blocked work settled. Returns whether a follow-up refresh was owed
   * and consumes the marker; the caller decides whether it still fires the
   * refresh itself (import end always does) or owes one now (a committed or
   * failed gallery load does). */
  takePending: () => boolean;
}

/**
 * Task 292 bridge, until review high-8's incremental refresh replaces this
 * whole path: SSE-triggered gallery refreshes must never abort the load
 * currently in flight, and during an import they hold off entirely (new
 * cards land through per-batch inserts instead). User-initiated refreshes
 * bypass the gate on purpose.
 */
export function createSseRefreshGate(hooks: SseRefreshGateHooks): SseRefreshGate {
  let pending = false;
  return {
    request() {
      if (!hooks.isBlocked()) {
        hooks.refresh();
        return;
      }
      pending = true;
    },
    takePending() {
      const owed = pending;
      pending = false;
      return owed;
    },
  };
}
