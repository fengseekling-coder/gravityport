// Pinterest API routes.
import { sendJson } from "../http-response.mjs";

const BOARD_PINS_RE = /^\/api\/pinterest\/boards\/([^/]+)\/pins$/;

export async function handlePinterestRoute({ req, res, url, context }) {
  if (!url.pathname.startsWith("/api/pinterest/")) return false;
  
  const { pinterest, port } = context;
  
  if (req.method === "GET" && url.pathname === "/api/pinterest/status") {
    if (!pinterest) {
      sendJson(res, 503, { code: "PINTEREST_UNAVAILABLE" });
      return true;
    }
    
    const status = await pinterest.status();
    sendJson(res, 200, status);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/pinterest/connect") {
    if (!pinterest) {
      sendJson(res, 503, { code: "PINTEREST_UNAVAILABLE" });
      return true;
    }
    
    try {
      const result = pinterest.beginConnect({ port });
      sendJson(res, 200, result);
    } catch (error) {
      if (error.code === "PINTEREST_PORT_MISMATCH") {
        sendJson(res, 409, { code: error.code });
      } else {
        sendJson(res, 500, { error: "Internal error" });
      }
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/pinterest/callback") {
    if (!pinterest) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(createHtmlPage("Service Unavailable / 服务不可用", "The Pinterest connection service is not available. / Pinterest 连接服务不可用。"));
      return true;
    }
    
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    
    if (error === "access_denied") {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(createHtmlPage("Access Denied / 已拒绝访问", "You declined the Pinterest authorization. / 您拒绝了 Pinterest 授权。"));
      return true;
    }
    
    if (!code || !state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(createHtmlPage("Bad Request / 请求错误", "Missing authorization code or state. / 缺少授权码或状态。"));
      return true;
    }
    
    try {
      await pinterest.completeConnect({ code, state });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(createHtmlPage("Connected / 已连接", "Pinterest is connected. You can return to GravityPort. / 已连接 Pinterest，可以回到 GravityPort。"));
    } catch (error) {
      if (error.code === "PINTEREST_STATE_INVALID") {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(createHtmlPage("Invalid State / 状态无效", "The authorization state is invalid or expired. / 授权状态无效或已过期。"));
      } else {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(createHtmlPage("Error / 错误", "Failed to complete Pinterest connection. / 无法完成 Pinterest 连接。"));
      }
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/pinterest/disconnect") {
    if (!pinterest) {
      sendJson(res, 503, { code: "PINTEREST_UNAVAILABLE" });
      return true;
    }
    
    await pinterest.disconnect();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/pinterest/boards") {
    if (!pinterest) {
      sendJson(res, 503, { code: "PINTEREST_UNAVAILABLE" });
      return true;
    }
    
    const bookmark = url.searchParams.get("bookmark") || "";
    
    try {
      const result = await pinterest.listBoards({ bookmark });
      sendJson(res, 200, result);
    } catch (error) {
      handlePinterestError(res, error);
    }
    return true;
  }

  const boardPinsMatch = BOARD_PINS_RE.exec(url.pathname);
  if (req.method === "GET" && boardPinsMatch) {
    if (!pinterest) {
      sendJson(res, 503, { code: "PINTEREST_UNAVAILABLE" });
      return true;
    }
    
    const boardId = decodeURIComponent(boardPinsMatch[1]);
    const bookmark = url.searchParams.get("bookmark") || "";
    
    try {
      const result = await pinterest.listBoardPins(boardId, { bookmark });
      sendJson(res, 200, result);
    } catch (error) {
      handlePinterestError(res, error);
    }
    return true;
  }

  return false;
}

/**
 * Handle Pinterest-specific errors.
 * @param {object} res - Response object.
 * @param {Error} error - Error object.
 */
function handlePinterestError(res, error) {
  if (error.code === "PINTEREST_NOT_CONNECTED") {
    sendJson(res, 401, { code: error.code });
  } else if (error.code === "PINTEREST_RECONNECT_REQUIRED") {
    sendJson(res, 401, { code: error.code });
  } else if (error.code === "PINTEREST_QUOTA_LOW") {
    sendJson(res, 429, { code: error.code });
  } else if (error.code === "PINTEREST_RATE_LIMITED") {
    sendJson(res, 429, { code: error.code });
  } else if (error.code === "PINTEREST_BAD_ID") {
    sendJson(res, 400, { code: error.code });
  } else {
    sendJson(res, 500, { error: "Internal error" });
  }
}

/**
 * Create a simple HTML page.
 * @param {string} title - Page title.
 * @param {string} message - Message to display.
 * @returns {string} HTML content.
 */
function createHtmlPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 80px auto; padding: 20px; text-align: center; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    p { font-size: 16px; color: #666; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

/**
 * Escape HTML special characters.
 * @param {string} str - String to escape.
 * @returns {string} Escaped string.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
