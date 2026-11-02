const DEFAULT_CHECK_INTERVAL_MS = 500;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

function encodeEvent(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// Revision tokens are "<journaled counter>" or "<counter>:<data_version>".
// The integer prefix is the delta API's `since` cursor.
function parseRevisionNumber(token) {
  const value = Number.parseInt(String(token ?? ""), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function createLibraryChangeStream(options = {}) {
  const store = options.store;
  if (!store || typeof store.libraryRevision !== "function") {
    throw new Error("Library change stream requires a store with libraryRevision().");
  }

  const checkIntervalMs = Number.isFinite(options.checkIntervalMs)
    ? Math.max(100, Number(options.checkIntervalMs))
    : DEFAULT_CHECK_INTERVAL_MS;
  const heartbeatIntervalMs = Number.isFinite(options.heartbeatIntervalMs)
    ? Math.max(1_000, Number(options.heartbeatIntervalMs))
    : DEFAULT_HEARTBEAT_INTERVAL_MS;

  const channels = new Map();
  let closed = false;

  function removeChannelIfEmpty(projectId, channel) {
    if (channel.clients.size) return;
    if (channel.checkTimer) clearInterval(channel.checkTimer);
    if (channel.heartbeatTimer) clearInterval(channel.heartbeatTimer);
    channels.delete(projectId);
  }

  function writeClient(client, eventName, payload) {
    if (client.closed || client.res.writableEnded || client.res.destroyed) return false;
    try {
      client.res.write(encodeEvent(eventName, payload));
      return true;
    } catch {
      client.closed = true;
      return false;
    }
  }

  function broadcast(channel, eventName, payload) {
    for (const client of [...channel.clients]) {
      if (!writeClient(client, eventName, payload)) channel.clients.delete(client);
    }
    removeChannelIfEmpty(channel.projectId, channel);
  }

  async function checkChannel(channel) {
    if (closed || channel.checkInFlight || !channel.clients.size) return;
    channel.checkInFlight = true;
    try {
      const nextRevision = String(await store.libraryRevision(channel.projectId));
      if (channel.lastRevision === null) {
        channel.lastRevision = nextRevision;
        return;
      }
      if (nextRevision === channel.lastRevision) return;
      const fromRevision = channel.lastRevision;
      channel.lastRevision = nextRevision;
      // Attach the journaled delta so connected clients can reconcile
      // incrementally without a second round trip. `fromRevision` lets a client
      // detect gaps against its own baseline (missed events, reconnects) and
      // fall back to the delta API, which is authoritative.
      const payload = {
        project: channel.projectId,
        revision: nextRevision,
        fromRevision,
        at: new Date().toISOString(),
      };
      if (typeof store.listLibraryChangesSince === "function") {
        try {
          const delta = await store.listLibraryChangesSince(channel.projectId, parseRevisionNumber(fromRevision));
          payload.changes = delta.changes;
          payload.complete = delta.complete;
        } catch {
          // Delta enrichment is best-effort; clients recover through the
          // regular delta API when it is missing.
        }
      }
      broadcast(channel, "library-changed", payload);
    } catch {
      // The regular revision endpoint remains the fallback. A transient stream
      // check failure must not tear down otherwise healthy browser clients.
    } finally {
      channel.checkInFlight = false;
    }
  }

  function ensureChannel(projectId) {
    let channel = channels.get(projectId);
    if (channel) return channel;
    channel = {
      projectId,
      clients: new Set(),
      lastRevision: null,
      checkInFlight: false,
      checkTimer: null,
      heartbeatTimer: null,
    };
    channel.checkTimer = setInterval(() => {
      void checkChannel(channel);
    }, checkIntervalMs);
    channel.heartbeatTimer = setInterval(() => {
      for (const client of [...channel.clients]) {
        if (client.closed || client.res.writableEnded || client.res.destroyed) {
          channel.clients.delete(client);
          continue;
        }
        try {
          client.res.write(": keepalive\n\n");
        } catch {
          client.closed = true;
          channel.clients.delete(client);
        }
      }
      removeChannelIfEmpty(projectId, channel);
    }, heartbeatIntervalMs);
    channels.set(projectId, channel);
    return channel;
  }

  async function attach(req, res, projectId = "default") {
    if (closed) return false;
    const cleanProjectId = typeof store.projectId === "function"
      ? store.projectId(projectId)
      : String(projectId || "default");
    const channel = ensureChannel(cleanProjectId);
    const client = { res, closed: false };
    channel.clients.add(client);

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const closeClient = () => {
      if (client.closed) return;
      client.closed = true;
      channel.clients.delete(client);
      removeChannelIfEmpty(cleanProjectId, channel);
    };
    req.once("close", closeClient);
    req.once("aborted", closeClient);
    res.once?.("close", closeClient);

    try {
      const revision = String(await store.libraryRevision(cleanProjectId));
      channel.lastRevision = revision;
      writeClient(client, "ready", {
        project: cleanProjectId,
        revision,
        at: new Date().toISOString(),
      });
    } catch {
      writeClient(client, "ready", {
        project: cleanProjectId,
        revision: null,
        at: new Date().toISOString(),
      });
    }
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const [projectId, channel] of channels) {
      if (channel.checkTimer) clearInterval(channel.checkTimer);
      if (channel.heartbeatTimer) clearInterval(channel.heartbeatTimer);
      for (const client of channel.clients) {
        client.closed = true;
        if (!client.res.writableEnded && !client.res.destroyed) client.res.end();
      }
      channel.clients.clear();
      channels.delete(projectId);
    }
  }

  // Task 333 — pairing requests are runtime-global (not per project), so the
  // signal goes to every channel. It carries no payload: the UI refetches
  // GET /api/web-capture/pair-requests, which is the authoritative list.
  function notifyPairRequests() {
    for (const channel of [...channels.values()]) {
      broadcast(channel, "web-capture-pair-requests", { at: new Date().toISOString() });
    }
  }

  return {
    attach,
    close,
    notifyPairRequests,
    checkNow(projectId = "default") {
      const cleanProjectId = typeof store.projectId === "function"
        ? store.projectId(projectId)
        : String(projectId || "default");
      const channel = channels.get(cleanProjectId);
      return channel ? checkChannel(channel) : Promise.resolve();
    },
  };
}
