/**
 * DEV-ONLY(128): remove before release.
 *
 * Local storage for the developer raw diagnostics records. One record per
 * image round, kept in the extension service worker's IndexedDB (database
 * `mosa-dev-raw-diagnostics`) with a small summary store so the options page
 * can show counts and total size without loading every full record.
 * Retention: the newest 200 records and at most 400 MiB in total; the oldest
 * records are evicted first. The whole module is deleted before release.
 */

export const DEV_RAW_DB_NAME = "mosa-dev-raw-diagnostics";
export const DEV_RAW_RECORDS_STORE = "records";
export const DEV_RAW_SUMMARIES_STORE = "summaries";
export const DEV_RAW_MAX_RECORDS = 200;
export const DEV_RAW_MAX_TOTAL_BYTES = 400 * 1024 * 1024;

/** Shared eviction math: given `{ id, bytes }` summaries (any order) return
 *  the ids to delete so the store fits the record-count and total-size caps,
 *  oldest (lowest id) first. */
export function idsToEvict(summaries, {
  maxRecords = DEV_RAW_MAX_RECORDS,
  maxTotalBytes = DEV_RAW_MAX_TOTAL_BYTES,
} = {}) {
  const ordered = [...summaries]
    .filter((entry) => entry && Number.isFinite(entry.id) && Number.isFinite(entry.bytes))
    .sort((a, b) => a.id - b.id);
  const drop = new Set();
  let total = ordered.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of ordered) {
    if (ordered.length - drop.size <= maxRecords && total <= maxTotalBytes) break;
    drop.add(entry.id);
    total -= entry.bytes;
  }
  return [...drop];
}

/** Identity of a round record: one record per conversation + assistant
 *  message. Re-records of the same round replace the stored one instead of
 *  appending a duplicate. */
export function devRawRecordKey(record) {
  const conversationId = String(record?.conversationId || "").trim();
  const assistantMessageId = String(record?.assistantMessageId || "").trim();
  if (!conversationId || !assistantMessageId) return "";
  return `${conversationId}\u0000${assistantMessageId}`;
}

function recordSummary(record, bytes) {
  const images = Array.isArray(record?.images) ? record.images : [];
  const frames = Array.isArray(record?.frames) ? record.frames : [];
  return {
    conversationId: String(record?.conversationId || ""),
    assistantMessageId: String(record?.assistantMessageId || ""),
    frameCount: frames.length,
    control: record?.control === true,
    missingPrompt: images.some((image) => (image?.promptStatus || "not-available") === "not-available"),
    bytes,
  };
}

function recordBytes(record) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(JSON.stringify(record ?? null)).byteLength;
  return String(JSON.stringify(record ?? null)).length;
}

function makeJsonlLine(record) {
  return JSON.stringify(record ?? null);
}

/**
 * In-memory implementation of the store contract; the unit tests substitute
 * this for the IndexedDB-backed store (no extra test dependencies).
 * Contract: { addRecord, listRecords, statsRecords, clearRecords }.
 */
export function createMemoryStore() {
  let nextId = 1;
  const records = new Map(); // id -> record
  const summaries = new Map(); // id -> { ...recordSummary, recordedAt }
  const keyIndex = new Map(); // recordKey -> id

  function frameCountOf(record) {
    return Array.isArray(record?.frames) ? record.frames.length : 0;
  }

  return {
    async addRecord(record) {
      const key = devRawRecordKey(record);
      const existingId = key ? keyIndex.get(key) : undefined;
      if (existingId && summaries.has(existingId)) {
        // One record per conversation + assistant message. The version with
        // the richer frame set wins; an equal or poorer re-record — the same
        // conversation reopened, say — changes nothing.
        if ((Number(summaries.get(existingId).frameCount) || 0) >= frameCountOf(record)) {
          return { id: existingId, count: records.size, replaced: false };
        }
        records.delete(existingId);
        summaries.delete(existingId);
        keyIndex.delete(key);
      }
      const id = nextId;
      nextId += 1;
      const bytes = recordBytes(record);
      records.set(id, record);
      summaries.set(id, { ...recordSummary(record, bytes), recordedAt: record?.recordedAt || "" });
      if (key) keyIndex.set(key, id);
      for (const evictId of idsToEvict([...summaries.entries()].map(([summaryId, value]) => ({ id: summaryId, bytes: value.bytes })))) {
        records.delete(evictId);
        summaries.delete(evictId);
        for (const [mappedKey, mappedId] of [...keyIndex]) {
          if (mappedId === evictId) keyIndex.delete(mappedKey);
        }
      }
      return { id, count: records.size, replaced: Boolean(existingId) };
    },

    async listRecords({ afterId = 0, limit = 10 } = {}) {
      const ids = [...records.keys()].sort((a, b) => a - b).filter((id) => id > afterId);
      const page = ids.slice(0, Math.max(1, limit));
      return {
        records: page.map((id) => records.get(id)),
        nextAfterId: page.length ? page[page.length - 1] : afterId,
        hasMore: ids.length > page.length,
      };
    },

    async statsRecords() {
      let bytes = 0;
      let missingPrompt = 0;
      let control = 0;
      let maxId = 0;
      for (const [id, summary] of summaries) {
        bytes += summary.bytes;
        if (summary.missingPrompt) missingPrompt += 1;
        if (summary.control) control += 1;
        if (id > maxId) maxId = id;
      }
      return { count: summaries.size, missingPromptCount: missingPrompt, controlCount: control, bytes, maxId };
    },

    async clearRecords() {
      records.clear();
      summaries.clear();
      return { ok: true };
    },
  };
}

/**
 * IndexedDB-backed store with the same contract. Opens the database lazily;
 * both stores are written in one transaction so records and their summaries
 * cannot drift apart.
 */
export function createIdbStore({ databaseName = DEV_RAW_DB_NAME } = {}) {
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DEV_RAW_RECORDS_STORE)) {
          db.createObjectStore(DEV_RAW_RECORDS_STORE, { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(DEV_RAW_SUMMARIES_STORE)) {
          db.createObjectStore(DEV_RAW_SUMMARIES_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("dev raw diagnostics database unavailable"));
    });
  }

  function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("dev raw diagnostics request failed"));
    });
  }

  async function readAllSummaries(db) {
    const tx = db.transaction(DEV_RAW_SUMMARIES_STORE, "readonly");
    const entries = await requestAsPromise(tx.objectStore(DEV_RAW_SUMMARIES_STORE).getAll());
    return Array.isArray(entries) ? entries : [];
  }

  async function deleteIds(db, ids) {
    if (!ids.length) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction([DEV_RAW_RECORDS_STORE, DEV_RAW_SUMMARIES_STORE], "readwrite");
      for (const id of ids) {
        tx.objectStore(DEV_RAW_RECORDS_STORE).delete(id);
        tx.objectStore(DEV_RAW_SUMMARIES_STORE).delete(id);
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("dev raw diagnostics delete failed"));
      tx.onabort = () => reject(tx.error || new Error("dev raw diagnostics delete aborted"));
    });
  }

  return {
    async addRecord(record) {
      const db = await openDb();
      try {
        const bytes = recordBytes(record);
        // One record per conversation + assistant message: the richer frame
        // set wins, an equal or poorer re-record changes nothing.
        const summariesBefore = await readAllSummaries(db);
        const key = devRawRecordKey(record);
        const existing = key
          ? summariesBefore.find((entry) => (
            `${String(entry?.conversationId || "")}\u0000${String(entry?.assistantMessageId || "")}` === key))
          : null;
        const frameCount = Array.isArray(record?.frames) ? record.frames.length : 0;
        if (existing && (Number(existing.frameCount) || 0) >= frameCount) {
          return { id: Number(existing.id), count: summariesBefore.length, replaced: false };
        }
        const id = await new Promise((resolve, reject) => {
          const tx = db.transaction([DEV_RAW_RECORDS_STORE, DEV_RAW_SUMMARIES_STORE], "readwrite");
          const store = tx.objectStore(DEV_RAW_RECORDS_STORE);
          const addRequest = store.add({ payload: record });
          let newId;
          // The summaries store has an explicit keyPath "id" (no generator),
          // so its row can only be written once the record's id is known.
          addRequest.onsuccess = () => {
            newId = addRequest.result;
            tx.objectStore(DEV_RAW_SUMMARIES_STORE).add({
              id: newId,
              ...recordSummary(record, bytes),
              recordedAt: record?.recordedAt || "",
            });
          };
          tx.oncomplete = () => resolve(newId);
          tx.onabort = () => reject(tx.error || new Error("dev raw diagnostics write aborted"));
          tx.onerror = () => reject(tx.error || new Error("dev raw diagnostics write failed"));
        });
        const stale = existing ? [Number(existing.id)] : [];
        await deleteIds(db, [...stale, ...idsToEvict((await readAllSummaries(db)).map((entry) => ({ id: entry.id, bytes: entry.bytes })))]);
        return { id, count: (await readAllSummaries(db)).length, replaced: Boolean(existing) };
      } finally {
        db.close();
      }
    },

    async listRecords({ afterId = 0, limit = 10 } = {}) {
      const db = await openDb();
      try {
        const tx = db.transaction(DEV_RAW_RECORDS_STORE, "readonly");
        const request = tx.objectStore(DEV_RAW_RECORDS_STORE).openCursor(IDBKeyRange.lowerBound(afterId, true));
        const found = [];
        let lastId = afterId;
        let hasMore = false;
        await new Promise((resolve, reject) => {
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return resolve();
            if (found.length < Math.max(1, limit)) {
              found.push({ id: cursor.key, payload: cursor.value?.payload });
              lastId = cursor.key;
              cursor.continue();
            } else {
              hasMore = true;
              resolve();
            }
          };
          request.onerror = () => reject(request.error || new Error("dev raw diagnostics read failed"));
        });
        return {
          records: found.map((entry) => entry.payload),
          nextAfterId: found.length ? lastId : afterId,
          hasMore,
        };
      } finally {
        db.close();
      }
    },

    async statsRecords() {
      const db = await openDb();
      try {
        const entries = await readAllSummaries(db);
        let bytes = 0;
        let missingPrompt = 0;
        let control = 0;
        let maxId = 0;
        for (const entry of entries) {
          bytes += Number(entry?.bytes) || 0;
          if (entry?.missingPrompt) missingPrompt += 1;
          if (entry?.control) control += 1;
          if (Number(entry?.id) > maxId) maxId = Number(entry.id);
        }
        return { count: entries.length, missingPromptCount: missingPrompt, controlCount: control, bytes, maxId };
      } finally {
        db.close();
      }
    },

    async clearRecords() {
      const db = await openDb();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction([DEV_RAW_RECORDS_STORE, DEV_RAW_SUMMARIES_STORE], "readwrite");
          tx.objectStore(DEV_RAW_RECORDS_STORE).clear();
          tx.objectStore(DEV_RAW_SUMMARIES_STORE).clear();
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error || new Error("dev raw diagnostics clear failed"));
          tx.onabort = () => reject(tx.error || new Error("dev raw diagnostics clear aborted"));
        });
        return { ok: true };
      } finally {
        db.close();
      }
    },
  };
}

/** Startup cleanup: the pre-0.15.30 structure-only diagnostics left three
 *  keys in chrome.storage.local; they are dead weight now and must go. */
export async function removeLegacyCaptureDiagnosticsKeys(storageArea) {
  if (!storageArea || typeof storageArea.remove !== "function") return;
  await storageArea.remove(["captureDiagnostics", "mosaCaptureDiagnosticsV1", "mosaCaptureDiagnosticsRejects"]);
}

export { recordBytes as devRawRecordBytes, makeJsonlLine as devRawJsonlLine };
