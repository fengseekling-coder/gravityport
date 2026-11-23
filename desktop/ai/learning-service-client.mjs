// 任务 463：主进程调服务 HTTP 的薄封装。学习的流程跑在主进程，读图、写结
// 果都经服务的 HTTP 路由（服务和路由永远看不到密钥）。
//
// 开始学习时记下 getService() 的 port 和 clientToken，这次学习的每个请求都
// 用这一对；之后 getService() 变了（换素材库、服务重启换端口）→ runner 会
// 停在内存里、不再发任何请求（D.3），旧库那条 run 下次打开旧库时被 D.5 的
// 扫尾改成「中断」。fetch 可注入（测试用假 fetch 记每次请求）。

const LEARNING_REQUEST_TIMEOUT_MS = 30_000;

export function createLearningServiceClient({ port, clientToken, fetchImpl = globalThis.fetch } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-mosa-client-token": clientToken };

  async function request(path, { method = "GET", body } = {}) {
    const init = {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      signal: AbortSignal.timeout(LEARNING_REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetchImpl(`${base}${path}`, init);
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    return { ok: response.ok, status: response.status, payload };
  }

  return {
    port,
    clientToken,
    async getLearningState(projectId, libraryId) {
      return request(`/api/learning-libraries/${encodeURIComponent(libraryId)}/learning?project=${encodeURIComponent(projectId)}`);
    },
    async listPending(projectId, libraryId) {
      return request(`/api/learning-libraries/${encodeURIComponent(libraryId)}/learning/pending?project=${encodeURIComponent(projectId)}`);
    },
    async listNotes(projectId, libraryId) {
      return request(`/api/learning-libraries/${encodeURIComponent(libraryId)}/learning/notes?project=${encodeURIComponent(projectId)}`);
    },
    async createRun(projectId, libraryId, body) {
      return request(`/api/learning-libraries/${encodeURIComponent(libraryId)}/runs`, { method: "POST", body: { projectId, ...body } });
    },
    async getRun(projectId, runId) {
      return request(`/api/learning-runs/${encodeURIComponent(runId)}?project=${encodeURIComponent(projectId)}`);
    },
    async patchRun(projectId, runId, body) {
      return request(`/api/learning-runs/${encodeURIComponent(runId)}`, { method: "PATCH", body: { projectId, ...body } });
    },
    async getItemInput(projectId, runId, assetId) {
      return request(`/api/learning-runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(assetId)}/input?project=${encodeURIComponent(projectId)}`);
    },
    async postItemResult(projectId, runId, assetId, body) {
      return request(`/api/learning-runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(assetId)}/result`, { method: "POST", body: { projectId, ...body } });
    },
    async postGuide(projectId, runId, body) {
      return request(`/api/learning-runs/${encodeURIComponent(runId)}/guide`, { method: "POST", body: { projectId, ...body } });
    },
    async getLibrary(projectId, libraryId) {
      return request(`/api/learning-libraries/${encodeURIComponent(libraryId)}?project=${encodeURIComponent(projectId)}`);
    },
  };
}
