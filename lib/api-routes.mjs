import { handleAssetRoute } from "./api/asset-routes.mjs";
import { handleBridgeRoute } from "./api/bridge-routes.mjs";
import { handleGenerationRoute } from "./api/generation-routes.mjs";
import { handleLibraryRoute } from "./api/library-routes.mjs";
import { handleVisualRoute } from "./api/visual-routes.mjs";
import { handlePinterestRoute } from "./api/pinterest-routes.mjs";

/**
 * Dispatches API requests by domain. Origin/CORS checks remain in
 * mosa-runtime.mjs, before any route handler receives a request.
 */
export async function handleApiRequest(request) {
  if (await handleBridgeRoute(request)) return true;
  if (await handleLibraryRoute(request)) return true;
  if (await handleGenerationRoute(request)) return true;
  if (await handleVisualRoute(request)) return true;
  if (await handlePinterestRoute(request)) return true;
  return handleAssetRoute(request);
}
