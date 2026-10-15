/**
 * Pinterest connection flow shared by the guide page and the settings card.
 *
 * createPinterestConnectionFlow is a plain state machine (no React) so the
 * "one flow at a time / cancel aborts / errors surface as messages" rules are
 * unit-testable; usePinterestConnection bridges it into component state.
 */

import {
  pinterestErrorMessage,
  startPinterestConnect,
  waitForPinterestConnection,
  type PinterestStatus,
} from "./pinterest-api.js";
import { useEffect, useRef, useState } from "react";

export type PinterestConnectionPhase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "error"; message: string };

export type PinterestConnectionFlow = {
  start: () => void;
  cancel: () => void;
  dispose: () => void;
  /** True while a connect attempt is running; further start() calls are ignored. */
  isBusy: () => boolean;
};

export function createPinterestConnectionFlow(deps: {
  startConnect?: () => Promise<unknown>;
  waitFor?: (options: { signal: AbortSignal }) => Promise<PinterestStatus>;
  onPhase?: (phase: PinterestConnectionPhase) => void;
  onConnected: (status: PinterestStatus) => void;
  onError?: (message: string) => void;
}): PinterestConnectionFlow {
  const startConnect = deps.startConnect || startPinterestConnect;
  const waitFor = deps.waitFor || (({ signal }) => waitForPinterestConnection({ signal }));
  let controller: AbortController | null = null;
  let disposed = false;

  function setPhase(phase: PinterestConnectionPhase) {
    if (!disposed) deps.onPhase?.(phase);
  }

  return {
    isBusy: () => controller !== null,
    start() {
      // Only one connect flow at a time; a second click must not fire a
      // second /connect request.
      if (controller || disposed) return;
      const next = new AbortController();
      controller = next;
      setPhase({ kind: "connecting" });
      void (async () => {
        try {
          await startConnect();
          const status = await waitFor({ signal: next.signal });
          if (next.signal.aborted || disposed) return;
          controller = null;
          setPhase({ kind: "idle" });
          deps.onConnected(status);
        } catch (error) {
          if (next.signal.aborted || disposed) return;
          controller = null;
          const message = pinterestErrorMessage(error);
          setPhase({ kind: "error", message });
          deps.onError?.(message);
        }
      })();
    },
    cancel() {
      if (!controller || disposed) return;
      controller.abort();
      controller = null;
      // Back to the previous state without an error message.
      setPhase({ kind: "idle" });
    },
    dispose() {
      disposed = true;
      controller?.abort();
      controller = null;
    },
  };
}

export function usePinterestConnection(options: {
  onConnected?: (status: PinterestStatus) => void;
  onError?: (message: string) => void;
} = {}): {
  phase: PinterestConnectionPhase;
  start: () => void;
  cancel: () => void;
} {
  const [phase, setPhase] = useState<PinterestConnectionPhase>({ kind: "idle" });
  const callbacksRef = useRef(options);
  callbacksRef.current = options;
  const flowRef = useRef<PinterestConnectionFlow | null>(null);
  if (!flowRef.current) {
    flowRef.current = createPinterestConnectionFlow({
      onPhase: setPhase,
      onConnected: (status) => callbacksRef.current.onConnected?.(status),
      onError: (message) => callbacksRef.current.onError?.(message),
    });
  }
  useEffect(() => {
    const flow = flowRef.current;
    return () => flow?.dispose();
  }, []);
  return { phase, start: () => flowRef.current?.start(), cancel: () => flowRef.current?.cancel() };
}
