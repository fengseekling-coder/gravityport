// Learning-library routes (task 459). Dispatched from lib/api-routes.mjs next
// to handleLibraryRoute; deliberately NOT in bridge-routes.mjs's
// WEB_CAPTURE_API_PATHS, so a browser-extension token can never reach them —
// they stay behind the client-token boundary like every other non-public API
// path. Addressing is by library id, never by name, so renames do not break
// callers.
import { requireArrayField, requireStringField } from "./request-fields.mjs";
import { readJson, sendJson } from "../http-response.mjs";

// Same capability guard shape as asset-routes.mjs: stores without the
// capability answer 501 instead of an opaque 500 (the JSON store does not
// support learning libraries).
function requireStoreCapability(store, method, message, code) {
  if (typeof store?.[method] === "function") return;
  const error = new Error(message);
  error.statusCode = 501;
  error.code = code;
  error.expose = true;
  throw error;
}

function projectIdFrom(url, body = {}) {
  return body.projectId || body.project || url.searchParams.get("project") || "default";
}

export async function handleLearningLibraryRoute({ req, res, url, context }) {
  const { store } = context;

  if (url.pathname === "/api/learning-libraries") {
    if (req.method === "GET") {
      requireStoreCapability(store, "listLearningLibraries", "Learning libraries are unavailable.", "LEARNING_LIBRARIES_UNAVAILABLE");
      sendJson(res, 200, {
        learningLibraries: await store.listLearningLibraries(url.searchParams.get("project") || "default"),
      });
      return true;
    }
    if (req.method === "POST") {
      requireStoreCapability(store, "createLearningLibrary", "Learning libraries are unavailable.", "LEARNING_LIBRARIES_UNAVAILABLE");
      const body = await readJson(req);
      requireStringField(body, "name", { optional: true, maxLength: 200 });
      requireStringField(body, "projectId", { optional: true, maxLength: 200 });
      sendJson(res, 201, {
        library: await store.createLearningLibrary({ projectId: projectIdFrom(url, body), name: body.name }),
      });
      return true;
    }
    return false;
  }

  const libraryMatch = /^\/api\/learning-libraries\/([^/]+)$/.exec(url.pathname);
  if (libraryMatch && (req.method === "GET" || req.method === "PATCH" || req.method === "DELETE")) {
    requireStoreCapability(store, "listLearningLibraries", "Learning libraries are unavailable.", "LEARNING_LIBRARIES_UNAVAILABLE");
    const id = decodeURIComponent(libraryMatch[1]);
    if (req.method === "GET") {
      sendJson(res, 200, {
        library: await store.getLearningLibrary(projectIdFrom(url), id),
      });
      return true;
    }
    if (req.method === "PATCH") {
      const body = await readJson(req);
      requireStringField(body, "name", { optional: true, maxLength: 200 });
      requireStringField(body, "projectId", { optional: true, maxLength: 200 });
      sendJson(res, 200, {
        library: await store.renameLearningLibrary(projectIdFrom(url, body), id, body.name),
      });
      return true;
    }
    sendJson(res, 200, await store.deleteLearningLibrary(projectIdFrom(url), id));
    return true;
  }

  const membersMatch = /^\/api\/learning-libraries\/([^/]+)\/members$/.exec(url.pathname);
  if (membersMatch && (req.method === "POST" || req.method === "DELETE")) {
    requireStoreCapability(store, req.method === "POST" ? "addToLearningLibrary" : "removeFromLearningLibrary", "Learning libraries are unavailable.", "LEARNING_LIBRARIES_UNAVAILABLE");
    const id = decodeURIComponent(membersMatch[1]);
    const body = await readJson(req);
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    if (req.method === "POST") {
      requireStringField(body, "groupName", { optional: true, maxLength: 200 });
      requireArrayField(body, "assetIds", { optional: true, of: "string", maxLength: 5000 });
      requireArrayField(body, "stackIds", { optional: true, of: "string", maxLength: 5000 });
      sendJson(res, 200, await store.addToLearningLibrary(projectIdFrom(url, body), id, {
        assetIds: body.assetIds,
        stackIds: body.stackIds,
        groupName: body.groupName,
      }));
      return true;
    }
    requireArrayField(body, "assetIds", { of: "string", maxLength: 5000 });
    sendJson(res, 200, await store.removeFromLearningLibrary(projectIdFrom(url, body), id, body.assetIds));
    return true;
  }

  return false;
}
