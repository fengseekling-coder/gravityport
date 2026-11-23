// 任务 463：学习后台的流程（跑学习）。全进程同一时间最多跑一次学习；密钥
// 只在主进程，花钱的调用（analyzeImage / summarizeGuide）经 createClaudeClient
// 发出；读图、写结果都走服务 HTTP（learning-service-client），服务和路由永远
// 看不到密钥。日志只记 run id、阶段、计数、错误分类和状态码 —— 密钥、请求头、
// 服务返回原文、图片 base64 一律不进日志、不进数据库、不进 IPC 返回值。
import { randomBytes } from "node:crypto";
import {
  ANALYSIS_IMAGE_LONG_EDGE,
  ANALYSIS_FIXED_INPUT_TOKENS,
  ANALYSIS_OUTPUT_TOKENS,
  SUMMARY_FIXED_INPUT_TOKENS,
  SUMMARY_OUTPUT_TOKENS,
  SUMMARY_CHUNK_SIZE,
  estimateLearningCost,
  imageTokens,
  tokenCostUsd,
} from "../../lib/ai/learning-cost.mjs";
import { normalizeGuideEntries } from "../../lib/ai/learning-schema.mjs";
import { aiModelById, aiPresetServiceById, aiServiceFamily } from "../../lib/ai/model-catalog.mjs";
import { createLearningServiceClient } from "./learning-service-client.mjs";
import { createClaudeClient, analyzeImage, summarizeGuide } from "./claude-client.mjs";
import { ANALYSIS_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT, MERGE_SYSTEM_PROMPT, fillLanguage } from "./learning-prompts.mjs";
import { recordAiUsage } from "./usage-ledger.mjs";

const QUOTE_TOKEN_TTL_MS = 10 * 60 * 1000;
const PAUSE_REASONS = new Set([
  "user", "interrupted", "auth", "no-key", "rate-limit", "network", "server",
  "unknown", "over-budget", "library-unavailable", "summary-error",
]);

function languageToCode(language) {
  const text = String(language || "").toLowerCase();
  return text.startsWith("zh") ? "zh" : "en";
}

function makeQuoteToken() {
  return randomBytes(16).toString("hex");
}

function blocked(reason, extra = {}) {
  return { ok: false, blocked: reason, ...extra };
}

/** runner 的各项依赖都从注入处来（测试换假件，正式换真件）。 */
export function createLearningRunner({
  serviceClient = createLearningServiceClient,
  getService = null,
  credentialStore,
  settingsStore,
  ledgerDir,
  outboundFetch,
  createClient = createClaudeClient,
  now = () => Date.now(),
  concurrency = 4,
  chunkSize = SUMMARY_CHUNK_SIZE,
}) {
  const quoteTokens = new Map();
  const knownRuns = new Map(); // runId → { projectId, libraryId }（abandon 只拿到 runId）
  let active = null; // 全进程一次只有一个学习在跑

  function currentService() {
    return typeof getService === "function" ? getService() : null;
  }

  function serviceBoundClient() {
    const service = currentService();
    if (!service || !Number.isFinite(Number(service.port))) return null;
    return serviceClient({ port: service.port, clientToken: service.clientToken });
  }

  function rememberRun(run, projectId, libraryId) {
    if (run?.id) knownRuns.set(run.id, { projectId, libraryId });
  }

  /** 报价令牌：10 分钟过期、用一次就作废；绑着报价当时的条目和价钱。 */
  function takeQuoteToken(token, runId = null) {
    if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return null;
    const entry = quoteTokens.get(token);
    if (!entry || entry.used) return null;
    if (now() > entry.expiresAt) {
      quoteTokens.delete(token);
      return null;
    }
    if (runId !== null && entry.runId !== runId) return null;
    entry.used = true;
    quoteTokens.delete(token);
    return entry;
  }

  async function resolveServiceAndKey() {
    const settings = await settingsStore.read();
    const slot = settings.slots?.analysis;
    const serviceId = String(slot?.serviceId || "");
    if (!serviceId) return { failure: "no-service" };
    const preset = aiPresetServiceById(serviceId);
    let service = null;
    if (preset) service = { ...preset };
    else {
      const custom = (settings.customServices || []).find((entry) => entry.id === serviceId);
      if (custom) service = { ...custom, custom: true };
    }
    if (!service) return { failure: "no-service" };
    // 这张单只放行 Claude / Claude 格式的自定义服务（OpenAI、Gemini、Ollama
    // 是第 8 张单）。
    if (aiServiceFamily(service) !== "claude" || service.format === "ollama") return { failure: "unsupported-service" };
    if (credentialStore.isEncryptionAvailable() !== true) return { failure: "encryption-unavailable" };
    const key = await credentialStore.readForRequest(serviceId);
    if (!key) return { failure: "no-key" };
    const analysisModel = String(slot?.model || "");
    const summaryModel = String(slot?.summaryModel || "");
    if (!analysisModel || !summaryModel) return { failure: "unknown-price" };
    return { service, key, analysisModel, summaryModel };
  }

  /** 扫尾：库里 running / pausing 的 run，凡不是自己内存里在跑的，改 paused（interrupted）。 */
  async function sweepInterrupted(projectId, libraryId) {
    const client = serviceBoundClient();
    if (!client) return;
    const state = await client.getLearningState(projectId, libraryId).catch(() => null);
    const openRun = state?.payload?.openRun;
    if (!openRun || (openRun.status !== "running" && openRun.status !== "pausing")) return;
    if (active && active.runId === openRun.id) return;
    console.info(`[MOSA] learning run ${openRun.id} was left running; marking paused (interrupted).`);
    const patched = await client.patchRun(projectId, openRun.id, { to: "paused", reason: "interrupted" }).catch(() => null);
    if (patched?.payload?.run) rememberRun(patched.payload.run, projectId, libraryId);
  }

  /**
   * 报价。blocked 只能是：encryption-unavailable / no-service /
   * unsupported-service / no-key / unknown-price / busy / empty / open-run。
   */
  async function quote({ project, libraryId, runId = null, language = "en" }) {
    await sweepInterrupted(project, libraryId);
    if (active && active.libraryId !== libraryId) {
      return blocked("busy", { libraryId: active.libraryId, libraryName: await activeLibraryName(project) });
    }
    const resolved = await resolveServiceAndKey();
    if (resolved.failure) return blocked(resolved.failure);
    const client = serviceBoundClient();
    if (!client) return blocked("no-service");

    const stateResponse = await client.getLearningState(project, libraryId).catch(() => null);
    if (!stateResponse?.ok) return blocked("empty");
    const state = stateResponse.payload;

    // resume 报价：runId 指向暂停着的学习；找不到或已不是暂停 → 当普通报价。
    let resumeRun = null;
    if (runId) {
      const runResponse = await client.getRun(project, String(runId)).catch(() => null);
      const run = runResponse?.payload?.run;
      if (run && run.status === "paused") resumeRun = run;
    }
    const openRun = state?.openRun || null;
    if (!resumeRun && openRun) {
      // 有没结束的学习（运行中或暂停着）：先继续或放弃。
      return blocked("open-run", { runId: openRun.id });
    }

    const notesResponse = await client.listNotes(project, libraryId).catch(() => null);
    const notes = Array.isArray(notesResponse?.payload?.notes) ? notesResponse.payload.notes : [];

    let assetIds = [];
    let newImages = [];
    let kind = "summary-only";
    if (resumeRun) {
      kind = "resume";
      assetIds = (resumeRun.items || []).filter((item) => item.status === "pending").map((item) => item.assetId);
      // 续跑的图尺寸未知：按上限 960×960 估（宁可报高）。
      newImages = assetIds.map(() => ({ width: null, height: null }));
    } else {
      const pendingResponse = await client.listPending(project, libraryId).catch(() => null);
      const pending = Array.isArray(pendingResponse?.payload?.pending) ? pendingResponse.payload.pending : [];
      assetIds = pending.map((item) => item.assetId);
      newImages = pending.map((item) => ({ width: item.width, height: item.height }));
      if (assetIds.length > 0) kind = "learn";
    }
    if (kind === "summary-only" && notes.length === 0) return blocked("empty");

    const estimate = estimateLearningCost({
      analysisModel: resolved.analysisModel,
      summaryModel: resolved.summaryModel,
      newImages,
      existingNoteCount: notes.length,
      summarize: true,
    });
    if (!estimate) return blocked("unknown-price");

    const token = makeQuoteToken();
    quoteTokens.set(token, {
      used: false,
      expiresAt: now() + QUOTE_TOKEN_TTL_MS,
      kind,
      projectId: project,
      libraryId,
      runId: resumeRun ? resumeRun.id : null,
      assetIds,
      estimateUsd: estimate.estimateUsd,
      capUsd: estimate.capUsd,
      serviceId: resolved.service.id,
      baseUrl: String(resolved.service.baseUrl || ""),
      analysisModel: resolved.analysisModel,
      summaryModel: resolved.summaryModel,
      language: languageToCode(language),
    });
    return {
      ok: true,
      quoteToken: token,
      kind,
      counts: {
        newCount: assetIds.length,
        analyzedCount: Number(state?.counts?.analyzed || 0),
        totalCount: Number(state?.counts?.total || 0),
        noPreview: Number(state?.counts?.noPreview || 0),
      },
      estimateUsd: estimate.estimateUsd,
      capUsd: estimate.capUsd,
      analysisUsd: estimate.analysisUsd,
      summaryUsd: estimate.summaryUsd,
      summaryCalls: estimate.summaryCalls,
      service: { id: resolved.service.id, label: String(resolved.service.label || resolved.service.id) },
      models: {
        analysis: { id: resolved.analysisModel, label: aiModelById(resolved.analysisModel)?.label || resolved.analysisModel },
        summary: { id: resolved.summaryModel, label: aiModelById(resolved.summaryModel)?.label || resolved.summaryModel },
      },
      privacy: { imageCount: assetIds.length, longEdge: ANALYSIS_IMAGE_LONG_EDGE },
    };
  }

  /**
   * 正在学的那个库叫什么。开始学习时是异步去取的，刚开始那一下可能还没回来：
   * 没有就当场取一次（报价和状态的「另一个学习库正在学」都要带名字）。
   */
  async function activeLibraryName(project) {
    const context = active;
    if (!context) return "";
    if (context.libraryName) return context.libraryName;
    const client = serviceBoundClient();
    if (!client) return "";
    const response = await client.getLibrary(project, context.libraryId).catch(() => null);
    const name = String(response?.payload?.library?.name || "");
    if (name && active === context) context.libraryName = name;
    return name;
  }

  /** 开始前再核一次密钥和服务；核不过返回 blocked 原因。 */
  async function preflight(entry) {
    const resolved = await resolveServiceAndKey();
    if (resolved.failure) return resolved.failure;
    if (resolved.service.id !== entry.serviceId) return "no-service";
    if (active) return "busy";
    if (!serviceBoundClient()) return "no-service";
    return null;
  }

  async function start({ quoteToken }) {
    const entry = takeQuoteToken(quoteToken);
    if (!entry) return { ok: false, reason: "quote-expired" };
    const failure = await preflight(entry);
    if (failure) return { ok: false, reason: failure };
    const client = serviceBoundClient();
    const createBody = {
      assetIds: entry.assetIds,
      serviceId: entry.serviceId,
      analysisModel: entry.analysisModel,
      summaryModel: entry.summaryModel,
      language: entry.language,
      estimateUsd: entry.estimateUsd,
      capUsd: entry.capUsd,
    };
    let createResponse = await client.createRun(entry.projectId, entry.libraryId, createBody).catch(() => null);
    // 挡路的是别的学习库里一条「运行中」的残留（App 崩了、换过库；preflight
    // 已保证本进程此刻没在跑）：就地改成「中断」再建一次。扫尾平时只扫正在看
    // 的那个库，不在这里收拾的话，用户得先回到那个库才能学别的。
    if (createResponse?.payload?.code === "LEARNING_RUN_BUSY" && createResponse.payload.openRunId && !active) {
      const staleRunId = String(createResponse.payload.openRunId);
      console.info(`[MOSA] learning run ${staleRunId} was left running; marking paused (interrupted).`);
      await client.patchRun(entry.projectId, staleRunId, { to: "paused", reason: "interrupted" }).catch(() => null);
      createResponse = await client.createRun(entry.projectId, entry.libraryId, createBody).catch(() => null);
    }
    if (!createResponse?.ok) {
      const code = String(createResponse?.payload?.code || "");
      if (code === "LEARNING_RUN_BUSY") {
        return { ok: false, reason: "busy", libraryId: createResponse.payload?.busyLibraryId || "", libraryName: createResponse.payload?.busyLibraryName || "" };
      }
      if (code === "LEARNING_RUN_OPEN") return { ok: false, reason: "open-run", runId: createResponse.payload?.openRunId || entry.runId || "" };
      return { ok: false, reason: "library-unavailable" };
    }
    const run = createResponse.payload.run;
    rememberRun(run, entry.projectId, entry.libraryId);
    beginRunContext({ entry, client, run });
    return { ok: true, runId: run.id };
  }

  async function resume({ runId, quoteToken }) {
    const entry = takeQuoteToken(quoteToken, String(runId));
    if (!entry) return { ok: false, reason: "quote-expired" };
    const failure = await preflight(entry);
    if (failure) return { ok: false, reason: failure };
    const client = serviceBoundClient();
    const runResponse = await client.getRun(entry.projectId, String(runId)).catch(() => null);
    const run = runResponse?.payload?.run;
    if (!run || run.status !== "paused") return { ok: false, reason: "open-run" };
    // paused → running：必须给新的报价；cap_usd 由存储改成「已花 + 新报价 ×1.5 + $0.05」。
    const patchResponse = await client.patchRun(entry.projectId, run.id, {
      to: "running",
      estimateUsd: entry.estimateUsd,
      capUsd: entry.capUsd,
    }).catch(() => null);
    if (!patchResponse?.ok) {
      return { ok: false, reason: patchResponse?.status === 409 ? "open-run" : "library-unavailable" };
    }
    const resumedRun = patchResponse.payload.run;
    rememberRun(resumedRun, entry.projectId, entry.libraryId);
    beginRunContext({ entry, client, run: resumedRun });
    return { ok: true, runId: resumedRun.id };
  }

  function beginRunContext({ entry, client, run }) {
    const context = {
      runId: run.id,
      projectId: entry.projectId,
      libraryId: entry.libraryId,
      libraryName: "",
      run,
      client,
      entry,
      rateLimited: false,
      // 用户点了暂停：先同步置位（不等 HTTP 往返），派单循环立刻停止派新。
      pausingNow: false,
      pausePromise: null,
      // 已经花掉、但还没落到条目或手册上的钱（汇总失败、分批汇总半途停下、
      // 分析中途报错前已收到的回答）。暂停 / 失败时随状态变化一起记进 run。
      unrecordedCostUsd: 0,
      detached: false,
      finished: false,
    };
    active = context;
    void client.getLibrary(entry.projectId, entry.libraryId).then((response) => {
      if (active === context && response?.payload?.library) context.libraryName = String(response.payload.library.name || "");
    }).catch(() => {});
    void driveRun(context);
  }

  function logRun(context, message) {
    console.info(`[MOSA] learning ${context.runId}: ${message}`);
  }

  /** 换了素材库 / 服务重启换端口 → 学习停在内存里，不再发任何请求。 */
  function serviceChanged(context) {
    const service = currentService();
    if (!service) return true;
    return Number(service.port) !== Number(context.client.port)
      || String(service.clientToken || "") !== String(context.client.clientToken || "");
  }

  function perImageEstimateUsd(model) {
    // 派单前的逐步估计：尺寸未知按上限 960×960（宁可报高）。
    const inputTokens = imageTokens(null, null) + ANALYSIS_FIXED_INPUT_TOKENS;
    return tokenCostUsd(model, { inputTokens, outputTokens: ANALYSIS_OUTPUT_TOKENS }) || 0;
  }

  /** 主循环：analyze 并发派单；全结束转 summarize；异常兜底暂停。 */
  async function driveRun(context) {
    try {
      const pendingIds = (context.run.items || [])
        .filter((item) => item.status === "pending")
        .map((item) => item.assetId);
      if (pendingIds.length > 0) {
        await analyzePhase(context, pendingIds);
        if (context.detached || context.finished) return;
        // 用户点了暂停就按暂停收尾，不看 context.run.status：最后几张的回写可能
        // 比暂停那次 PATCH 先到服务、后回到这里，手上的 run 会是过时的 running。
        if (context.pausingNow || context.run.status === "pausing") {
          if (context.pausePromise) await context.pausePromise;
          await settlePause(context);
          return;
        }
        if (context.run.status !== "running") return;
      }
      await summarizePhase(context);
    } catch (error) {
      logRun(context, `runner loop failed (${error?.code || "unknown"}).`);
      await pauseRun(context, "unknown");
      active = null;
      context.finished = true;
    }
  }

  async function analyzePhase(context, pendingIds) {
    let next = 0;
    let workers = 0;
    let pausedReason = null;
    const capUsd = Number(context.run.capUsd ?? Number.POSITIVE_INFINITY);
    const analysisModel = context.entry.analysisModel;

    await new Promise((resolveLoop) => {
      // 暂停类标志（用户暂停 / 自动暂停 / 换库脱钩）只停止「派新的」；落停
      // 必须等手上的都回来（workers === 0），它们的结果和花费照常记（D.4）。
      const settled = () => pausedReason || context.pausingNow || context.run.status === "pausing" || context.detached;
      const maybeFinish = () => {
        if (workers === 0 && ((next >= pendingIds.length && !context.detached) || settled())) {
          resolveLoop();
        }
      };
      const pump = () => {
        while (
          !pausedReason && !context.pausingNow && context.run.status !== "pausing" && !context.detached
          && workers < (context.rateLimited ? 1 : concurrency)
          && next < pendingIds.length
        ) {
          const assetId = pendingIds[next];
          next += 1;
          workers += 1;
          void processOne(assetId).finally(() => {
            workers -= 1;
            maybeFinish();
            pump();
          });
        }
        maybeFinish();
      };
      const processOne = async (assetId) => {
        try {
          if (context.detached) return;
          // 每派一张新图前算「已花 + 这一步的估计」，超上限暂停（over-budget）。
          if (Number(context.run.costUsd || 0) + context.unrecordedCostUsd + perImageEstimateUsd(analysisModel) > capUsd) {
            pausedReason = "over-budget";
            return;
          }
          // 中途密钥被删 → no-key 暂停。
          const key = await credentialStore.readForRequest(context.entry.serviceId);
          if (!key) {
            pausedReason = "no-key";
            return;
          }
          if (serviceChanged(context)) {
            // 停在内存里：不再发任何请求（包括这张的结果回写）。
            context.detached = true;
            return;
          }
          const input = await context.client.getItemInput(context.projectId, context.runId, assetId);
          if (context.detached) return;
          if (!input.ok) {
            if (input.status === 410) {
              await recordResult(context, assetId, { status: "skipped", errorCode: "gone" });
            } else if (input.status === 422) {
              await recordResult(context, assetId, { status: "failed", errorCode: "unreadable" });
            } else {
              // 服务整体不可用：整次暂停，这张留 pending（继续时重做）。
              pausedReason = "library-unavailable";
            }
            return;
          }
          // 取输入要一次 HTTP 往返：这期间点了暂停 / 出了别的暂停原因，就不再
          // 发这张的 Claude 请求（还没花钱），条目留 pending，继续时重做。
          if (pausedReason || context.pausingNow || context.run.status === "pausing") return;
          const client = createClient({ apiKey: key, baseURL: context.entry.baseUrl, outboundFetch });
          const outcome = await analyzeImage(client, {
            model: analysisModel,
            image: input.payload.image,
            metadata: input.payload.metadata,
            systemPrompt: ANALYSIS_SYSTEM_PROMPT,
          });
          if (context.detached) return;
          const usageTokens = outcome.usage || {};
          if (outcome.ok) {
            await recordResult(context, assetId, {
              status: "done",
              fingerprint: input.payload.fingerprint,
              note: outcome.note,
              serviceId: context.entry.serviceId,
              model: outcome.model,
              inputTokens: Number(usageTokens.input_tokens || 0),
              outputTokens: Number(usageTokens.output_tokens || 0),
              costUsd: outcome.costUsd,
            });
            await recordLedger(outcome.costUsd);
            return;
          }
          if (outcome.code === "refusal" || outcome.code === "bad-output" || outcome.code === "rejected") {
            // 这一张记失败，接着跑下一张。bad-output 的放大重试已在 client 里做过。
            await recordResult(context, assetId, {
              status: "failed",
              fingerprint: input.payload.fingerprint,
              errorCode: outcome.code,
              serviceId: context.entry.serviceId,
              model: analysisModel,
              inputTokens: Number(usageTokens.input_tokens || 0),
              outputTokens: Number(usageTokens.output_tokens || 0),
              costUsd: outcome.costUsd || 0,
            });
            await recordLedger(outcome.costUsd || 0);
            return;
          }
          // 走到这里的都没把结果记到条目上（这张留 pending）；中途已收到的回答
          // 照样收费，先记账、随暂停记进 run。
          if (Number(outcome.costUsd) > 0) {
            context.unrecordedCostUsd += Number(outcome.costUsd);
            await recordLedger(outcome.costUsd);
          }
          if (outcome.code === "rate-limit") {
            if (!context.rateLimited) {
              // 第一次：并发降到 1，这张放回队尾重做，接着跑；同一次学习里
              // 再碰到就暂停。
              context.rateLimited = true;
              pendingIds.push(assetId);
              return;
            }
            pausedReason = "rate-limit";
            return;
          }
          pausedReason = PAUSE_REASONS.has(outcome.code) ? outcome.code : "unknown";
        } catch (error) {
          // 服务 HTTP 调不通（取输入 / 回写结果失败）→ 整次暂停。
          if (!context.detached) pausedReason = pausedReason || "library-unavailable";
        }
      };
      pump();
    });
    if (context.detached) {
      active = null;
      return;
    }
    if (pausedReason) {
      await pauseRun(context, pausedReason);
      active = null;
      context.finished = true;
    }
  }

  async function recordLedger(costUsd) {
    if (!ledgerDir || !(Number(costUsd) > 0)) return;
    await recordAiUsage(ledgerDir, { slot: "analysis", costUsd: Number(costUsd) }).catch(() => {});
  }

  async function recordResult(context, assetId, body) {
    const response = await context.client.postItemResult(context.projectId, context.runId, assetId, body);
    if (response.ok && response.payload?.run) {
      context.run = response.payload.run;
    } else if (response.status === 409) {
      // 条目已不是 pending（被扫尾改了状态等）：忽略这张的回写。
      logRun(context, `item ${assetId} result rejected (bad state).`);
    } else {
      throw new Error(`item result HTTP ${response.status}`);
    }
  }

  /** running → paused（自动暂停，reason 见 D.5）。 */
  async function pauseRun(context, reason) {
    const clean = PAUSE_REASONS.has(reason) ? reason : "unknown";
    if (context.run.status === "running" || context.run.status === "pausing") {
      const patched = await context.client.patchRun(context.projectId, context.runId, {
        to: "paused", reason: clean, ...unrecordedCostBody(context),
      }).catch(() => null);
      if (patched?.ok && patched.payload?.run) {
        context.run = patched.payload.run;
        context.unrecordedCostUsd = 0;
      }
      logRun(context, `paused (${clean}).`);
    }
  }

  function unrecordedCostBody(context) {
    return context.unrecordedCostUsd > 0 ? { addCostUsd: context.unrecordedCostUsd } : {};
  }

  /** 用户暂停：手上的请求都回来后 pausing → paused（user）。 */
  async function settlePause(context) {
    // pausing → paused 时服务保留原因 user；暂停那次 PATCH 没落地（还在
    // running）时这一条就是带原因 user 的 running → paused。
    const patched = await context.client.patchRun(context.projectId, context.runId, {
      to: "paused", reason: "user", ...unrecordedCostBody(context),
    }).catch(() => null);
    if (patched?.ok && patched.payload?.run) {
      context.run = patched.payload.run;
      context.unrecordedCostUsd = 0;
    }
    active = null;
    context.finished = true;
    logRun(context, `paused (${context.run.pauseReason || "user"}).`);
  }

  function noteLine(index, entry) {
    const note = entry.note || {};
    const star = entry.favorite ? "★ " : "";
    const palette = Array.isArray(note.palette) ? note.palette.map((swatch) => swatch.hex).join(" ") : "";
    return [
      `#${index + 1}`,
      `${star}${Number(entry.rating || 0)}`,
      String(note.subject || ""),
      (note.style_keywords || []).join(", "),
      palette,
      String(note.composition || ""),
      String(note.camera || ""),
      String(note.lighting || ""),
      String(note.material || ""),
      String(note.character || ""),
      (note.mood_keywords || []).join(", "),
      (note.prompt_techniques || []).join(" ; "),
    ].join(" | ");
  }

  function contextBlocks(contextText) {
    const fixed = (contextText?.locked || []).map((entry) => `- [${entry.section}] ${entry.text}`).join("\n");
    const removed = (contextText?.removed || []).map((entry) => `- [${entry.section}] ${entry.text}`).join("\n");
    return [
      `<fixed_entries>\n${fixed || "(none)"}\n</fixed_entries>`,
      `<removed_points>\n${removed || "(none)"}\n</removed_points>`,
    ];
  }

  function buildUserContent(notes, contextText) {
    const lines = notes.map((entry, index) => noteLine(index, entry));
    return [`<notes>\n${lines.join("\n") || "(no notes)"}\n</notes>`, ...contextBlocks(contextText)].join("\n\n");
  }

  /**
   * 汇总：条目全结束后转 summarize；取全部笔记（不只这次的）；超过 chunkSize
   * 条分批汇总再合并；输出过 normalizeGuideEntries 后引用号换回图 id，交给
   * applyGeneratedGuide。汇总那一次请求中途不打断（用户在汇总中暂停的，汇总
   * 照常落地）。
   */
  async function summarizePhase(context) {
    const languageCode = context.entry.language || "en";
    const capUsd = Number(context.run.capUsd ?? Number.POSITIVE_INFINITY);
    const summaryEstimate = tokenCostUsd(context.entry.summaryModel, {
      inputTokens: SUMMARY_FIXED_INPUT_TOKENS,
      outputTokens: SUMMARY_OUTPUT_TOKENS,
    }) || 0;
    const stop = async (reason) => {
      await pauseRun(context, reason);
      active = null;
      context.finished = true;
    };
    // 先取笔记再转阶段：「一张都没学成、也没有旧笔记」只能在 analyze 阶段转
    // failed（状态机那张表），先转了 summarize 就再也转不过去，run 会卡在
    // running。
    const notesResponse = await context.client.listNotes(context.projectId, context.libraryId).catch(() => null);
    if (!notesResponse?.ok) {
      await stop("library-unavailable");
      return;
    }
    const notes = Array.isArray(notesResponse.payload?.notes) ? notesResponse.payload.notes : [];
    const contextText = notesResponse.payload?.context || { locked: [], removed: [] };
    if (notes.length === 0) {
      if (context.run.phase === "analyze") {
        const failed = await context.client.patchRun(context.projectId, context.runId, {
          to: "failed", reason: "nothing-learned", ...unrecordedCostBody(context),
        }).catch(() => null);
        if (failed?.ok && failed.payload?.run) context.run = failed.payload.run;
        active = null;
        context.finished = true;
        logRun(context, "failed (nothing-learned).");
        return;
      }
      // 已在汇总阶段（暂停后继续时笔记全没了：图都移出了学习库）：停下等用户放弃。
      await stop("summary-error");
      return;
    }
    // 开始汇总前算「已花 + 这一步的估计」，超上限暂停（over-budget）。
    if (Number(context.run.costUsd || 0) + context.unrecordedCostUsd + summaryEstimate > capUsd) {
      await stop("over-budget");
      return;
    }
    if (context.run.phase === "analyze") {
      const phaseResponse = await context.client.patchRun(context.projectId, context.runId, { to: "running" }).catch(() => null);
      if (!phaseResponse?.ok) {
        await stop("library-unavailable");
        return;
      }
      context.run = phaseResponse.payload.run;
    }
    const key = await credentialStore.readForRequest(context.entry.serviceId);
    if (!key) {
      await stop("no-key");
      return;
    }
    if (serviceChanged(context)) {
      context.detached = true;
      active = null;
      return;
    }
    const client = createClient({ apiKey: key, baseURL: context.entry.baseUrl, outboundFetch });
    const validRefs = new Set(notes.map((_, index) => index + 1));
    let guide = null;
    let usage = null;
    let costUsd = 0;
    const overBudget = () => Number(context.run.costUsd || 0) + context.unrecordedCostUsd + costUsd + summaryEstimate > capUsd;
    const summarizeOnce = async (content, systemPrompt) => {
      const outcome = await summarizeGuide(client, {
        model: context.entry.summaryModel,
        userContent: content,
        systemPrompt,
      });
      // 成败都按收到的回答记账（失败的那几次服务端照样收费）。
      costUsd += Number(outcome.costUsd || 0);
      await recordLedger(outcome.costUsd);
      if (!outcome.ok) throw outcome;
      return outcome;
    };
    try {
      if (notes.length > chunkSize) {
        const partials = [];
        for (let start = 0; start < notes.length; start += chunkSize) {
          // 分批汇总每一次都先核上限（第一批在上面已经核过）。
          if (start > 0 && overBudget()) throw { code: "over-budget" };
          const outcome = await summarizeOnce(buildUserContent(notes.slice(start, start + chunkSize), { locked: [], removed: [] }), fillLanguage(SUMMARY_SYSTEM_PROMPT, languageCode));
          partials.push(outcome.guide);
          usage = outcome.usage;
        }
        if (overBudget()) throw { code: "over-budget" };
        const mergedContent = [
          "<partial_guides>",
          ...partials.map((partial, index) => `<partial index="${index + 1}">\n${JSON.stringify(partial)}\n</partial>`),
          "</partial_guides>",
          ...contextBlocks(contextText),
        ].join("\n\n");
        const outcome = await summarizeOnce(mergedContent, fillLanguage(MERGE_SYSTEM_PROMPT, languageCode));
        guide = outcome.guide;
        usage = outcome.usage;
      } else {
        const outcome = await summarizeOnce(buildUserContent(notes, contextText), fillLanguage(SUMMARY_SYSTEM_PROMPT, languageCode));
        guide = outcome.guide;
        usage = outcome.usage;
      }
    } catch (outcomeOrError) {
      const code = outcomeOrError?.code || "unknown";
      // 这次汇总已花的钱（含成功的分批）没落到手册上，随暂停记进 run；继续时
      // 汇总整个重做。
      context.unrecordedCostUsd += costUsd;
      // 汇总失败（summary-error、refusal）→ 暂停，继续时只重做汇总。
      const reason = code === "over-budget" ? "over-budget"
        : (code === "summary-error" || code === "refusal" || !PAUSE_REASONS.has(code) ? "summary-error" : code);
      await stop(reason);
      logRun(context, `summary stopped (${code}).`);
      return;
    }
    const normalized = normalizeGuideEntries(guide, { validRefs });
    const entries = normalized.entries.map((entry) => ({
      section: entry.section,
      text: entry.text,
      swatches: entry.swatches,
      sourceAssetIds: entry.sources.map((ref) => notes[ref - 1]?.assetId).filter(Boolean),
    }));
    if (serviceChanged(context)) {
      context.detached = true;
      active = null;
      return;
    }
    const guideResponse = await context.client.postGuide(context.projectId, context.runId, {
      entries,
      language: context.entry.language || "en",
      inputTokens: Number(usage?.input_tokens || 0),
      outputTokens: Number(usage?.output_tokens || 0),
      costUsd: costUsd + context.unrecordedCostUsd,
      droppedNoSource: normalized.droppedNoSource,
    }).catch(() => null);
    if (!guideResponse?.ok) {
      context.unrecordedCostUsd += costUsd;
      await stop("library-unavailable");
      return;
    }
    context.unrecordedCostUsd = 0;
    context.run = guideResponse.payload.run;
    active = null;
    context.finished = true;
    logRun(context, `done (items ${context.run.doneCount}/${context.run.itemCount}, guide revision ${context.run.guideRevisionAfter}).`);
  }

  /** 立刻改 pausing、不再派新的；手上的请求照常等回来、照常记结果和花费。 */
  async function pause({ runId }) {
    if (!active || active.runId !== String(runId)) return { ok: false };
    const context = active;
    context.pausingNow = true;
    if (context.run.status === "running" && !context.pausePromise) {
      context.pausePromise = context.client.patchRun(context.projectId, context.runId, { to: "pausing", reason: "user" })
        .then((patched) => {
          if (patched?.ok && patched.payload?.run) context.run = patched.payload.run;
        })
        .catch(() => {});
      await context.pausePromise;
    }
    return { ok: true };
  }

  /** 放弃：只认 paused。 */
  async function abandon({ runId }) {
    const known = knownRuns.get(String(runId));
    if (!known) return { ok: false };
    const client = serviceBoundClient();
    if (!client) return { ok: false };
    const runResponse = await client.getRun(known.projectId, String(runId)).catch(() => null);
    const run = runResponse?.payload?.run;
    if (!run || run.status !== "paused") return { ok: false };
    const patched = await client.patchRun(known.projectId, String(runId), { to: "canceled" }).catch(() => null);
    return { ok: Boolean(patched?.ok) };
  }

  /**
   * 状态 + 扫尾。自己内存里没在跑的 running/pausing run 一律改 paused
   * （interrupted）—— App 崩了、被强退、换过素材库都靠这一步收拾。
   */
  async function status({ project, libraryId }) {
    await sweepInterrupted(project, libraryId);
    const busyElsewhere = active && active.libraryId !== libraryId
      ? { libraryId: active.libraryId, libraryName: await activeLibraryName(project) }
      : null;
    let run = null;
    if (active && active.libraryId === libraryId) {
      run = shapeStatusRun(active.run);
    } else {
      const client = serviceBoundClient();
      if (client) {
        const state = await client.getLearningState(project, libraryId).catch(() => null);
        const openRun = state?.payload?.openRun || null;
        // 暂停着的学习也算「这个库的 run」（464 显示继续 / 放弃）。
        if (openRun && openRun.status === "paused") {
          run = shapeStatusRun(openRun);
          rememberRun(openRun, project, libraryId);
        }
      }
    }
    return { ok: true, run, busyElsewhere };
  }

  function shapeStatusRun(run) {
    if (!run) return null;
    return {
      id: run.id,
      libraryId: run.libraryId,
      status: run.status,
      phase: run.phase,
      itemCount: Number(run.itemCount || 0),
      doneCount: Number(run.doneCount || 0),
      failedCount: Number(run.failedCount || 0),
      skippedCount: Number(run.skippedCount || 0),
      costUsd: Number(run.costUsd || 0),
      estimateUsd: run.estimateUsd == null ? null : Number(run.estimateUsd),
      capUsd: run.capUsd == null ? null : Number(run.capUsd),
      pauseReason: run.pauseReason || "",
    };
  }

  return { quote, start, resume, pause, abandon, status };
}
