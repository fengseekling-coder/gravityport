// 任务 458：AI「测试连接」的纯函数——发什么请求、怎么读回答、失败怎么归类。
//
// 测试只是向服务要一份模型清单，不收费。带密钥的请求不许跟随跳转
// （redirect: "error"），自定义头在跨站跳转时不会被浏览器剥掉，跟着跳转走
// 就可能把密钥带到别的站点。服务返回的原文一个字都不许显示、不许记日志
// （OpenAI 的 401 原文里会带半截密钥），所以这里只回我们自己的归类和文案。

const CONNECTION_TEST_TIMEOUT_MS = 10000;

export const AI_CONNECTION_SUCCESS_TEMPLATE = "连接正常 · 可用 {count} 个模型";

export function buildConnectionTestRequest(service, key, purpose = "text") {
  if (!service || typeof service !== "object") throw new TypeError("service must be an object");
  const base = String(service.baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new TypeError("service.baseUrl is required");
  const trimmedKey = String(key ?? "");
  const headers = {};
  let url;

  if (service.id === "gemini" && purpose === "image") {
    // Gemini 原生入口：出图模型的清单，x-goog-api-key 鉴权。
    url = `${base}/v1beta/models?pageSize=1000`;
    headers["x-goog-api-key"] = trimmedKey;
  } else if (service.id === "gemini") {
    // Gemini 文字（兼容入口）：OpenAI 格式，同一把密钥。
    url = `${base}/v1beta/openai/models`;
    headers.authorization = `Bearer ${trimmedKey}`;
  } else if (service.id === "claude" || service.format === "claude") {
    // 预设 Claude 带 limit=1000 拉全量；自定义服务按单子只拼 /v1/models。
    url = service.id === "claude" ? `${base}/v1/models?limit=1000` : `${base}/v1/models`;
    headers["x-api-key"] = trimmedKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (service.id === "ollama" || service.format === "ollama") {
    // 本机 Ollama：不需要鉴权。
    url = `${base}/api/tags`;
  } else if (service.id === "openai") {
    // 预设 OpenAI。
    url = `${base}/v1/models`;
    headers.authorization = `Bearer ${trimmedKey}`;
  } else {
    // OpenAI 格式的自定义服务：用户填的地址 + /models。
    url = `${base}/models`;
    headers.authorization = `Bearer ${trimmedKey}`;
  }

  return {
    url,
    init: {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      headers,
      signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
    },
  };
}

/**
 * 读响应体，最多 maxBytes 字节；超限返回 null（调用方按 bad-response 处理），
 * 读不出文本返回 ""。
 */
export async function readConnectionTestBody(response, maxBytes = 2 * 1024 * 1024) {
  if (!response || !response.body) {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return "";
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(concatChunks(chunks, total));
}

function concatChunks(chunks, total) {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function stripModelsPrefix(name) {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

// 两种清单形状按字段读：OpenAI 格式（含 Gemini 兼容入口）在 data[].id，
// Ollama /api/tags 与 Gemini 原生入口在 models[].name；Gemini 的 id/name 可能
// 带 models/ 前缀，统一去掉。
function modelIdsFromPayload(payload) {
  if (Array.isArray(payload?.data)) {
    return payload.data
      .map((model) => String(model?.id || ""))
      .filter(Boolean)
      .map(stripModelsPrefix);
  }
  if (Array.isArray(payload?.models)) {
    return payload.models
      .map((model) => String(model?.name || ""))
      .filter(Boolean)
      .map(stripModelsPrefix);
  }
  return null;
}

function statusFailureCode(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limit";
  if (status >= 500 && status <= 599) return "server";
  return "bad-response";
}

/**
 * service + status + 原文 → { ok, code, models }。原文只用来解析，一个字都
 * 不进返回值。
 */
export function parseConnectionTestResponse(service, status, bodyText) {
  const numericStatus = Number(status) || 0;
  if (numericStatus < 200 || numericStatus >= 300) {
    return { ok: false, code: statusFailureCode(numericStatus), models: [], status: numericStatus };
  }
  let payload;
  try {
    payload = JSON.parse(String(bodyText ?? ""));
  } catch {
    return { ok: false, code: "bad-response", models: [], status: numericStatus };
  }
  if (!payload || typeof payload !== "object") {
    return { ok: false, code: "bad-response", models: [], status: numericStatus };
  }
  const models = modelIdsFromPayload(payload);
  if (!models) {
    return { ok: false, code: "bad-response", models: [], status: numericStatus };
  }
  return { ok: true, code: "ok", models, status: numericStatus };
}

/**
 * 把 fetch 的异常归成失败类。带密钥的请求遇到跳转会在这里被抓住
 * （redirect: "error"）；超时、连不上（DNS、拒绝、代理）也在这里归类。
 */
export function classifyConnectionTestError(service, error) {
  const name = String(error?.name || "");
  const text = `${error?.message || ""} ${error?.cause?.message || ""}`;
  if (name === "TimeoutError" || name === "AbortError") {
    return { ok: false, code: "timeout", models: [] };
  }
  if (/redirect/i.test(text)) {
    return { ok: false, code: "redirect", models: [] };
  }
  if (service && (service.id === "ollama" || service.format === "ollama")) {
    return { ok: false, code: "ollama-not-running", models: [] };
  }
  return { ok: false, code: "network", models: [] };
}

/**
 * 失败归类 → 界面文字。返回 { code, status, template, params, message }：
 * template 是带 {service}/{status} 占位的键（i18n.ts 有英文条目），message 是
 * 填好显示名、直接可显示的中文。Ollama 连不上没有 {service} 前缀。
 */
export function describeConnectionFailure(serviceLabel, failure) {
  const code = String(failure?.code || "network");
  const status = Number(failure?.status) || 0;
  const label = String(serviceLabel || "");
  const withService = (template, params = {}) => {
    const filled = { service: label, ...params };
    const message = template.replace(/\{(\w+)\}/g, (_match, name) => filled[name] ?? "");
    return { code, status, template, params: filled, message };
  };
  if (code === "ollama-not-running") {
    const template = "本机没有在运行 Ollama";
    return { code, status, template, params: {}, message: template };
  }
  if (code === "auth") {
    return withService("无法连接 {service}：密钥不对或没有权限（{status}）", { status: String(status || 401) });
  }
  if (code === "not-found") {
    return withService("无法连接 {service}：地址不对（{status}）", { status: String(status || 404) });
  }
  if (code === "rate-limit") {
    return withService("无法连接 {service}：请求太多或额度已用完（{status}）", { status: String(status || 429) });
  }
  if (code === "server") {
    return withService("无法连接 {service}：服务暂时出错（{status}）", { status: String(status || 503) });
  }
  if (code === "redirect") {
    return withService("无法连接 {service}：地址发生了跳转，为保护密钥已停止");
  }
  if (code === "timeout") {
    return withService("无法连接 {service}：10 秒内没有回应");
  }
  if (code === "bad-response") {
    return withService("无法连接 {service}：返回的内容看不懂");
  }
  return withService("无法连接 {service}：连不上服务器，检查网络或代理");
}
