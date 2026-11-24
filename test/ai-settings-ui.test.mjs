// AI settings UI pure functions (task 468): visibleServiceIds, addableServices,
// connectedServiceIds, modelGroups, analysisCostMultiple, priceWithoutMonth,
// formatMonthUsd, testPurposeFor, and useRowNote. The real TypeScript module
// (web/gravityport/src/ai-settings-model.ts) is compiled with tsc and imported
// directly — nothing is hand-copied.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AI_MODELS, AI_PRESET_SERVICES } from "../lib/ai/model-catalog.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let ADD_CUSTOM_SERVICE_VALUE;
let visibleServiceIds;
let addableServices;
let connectedServiceIds;
let modelGroups;
let analysisCostMultiple;
let priceWithoutMonth;
let formatMonthUsd;
let testPurposeFor;
let useRowNote;

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-ai-settings-ui-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "ai-settings-model.ts"),
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  const mod = await import(join(compileRoot, "ai-settings-model.js"));
  ({
    ADD_CUSTOM_SERVICE_VALUE,
    visibleServiceIds,
    addableServices,
    connectedServiceIds,
    modelGroups,
    analysisCostMultiple,
    priceWithoutMonth,
    formatMonthUsd,
    testPurposeFor,
    useRowNote,
  } = mod);
  after(async () => {
    await rm(compileRoot, { recursive: true, force: true });
  });
});

function makeState(overrides = {}) {
  const baseServices = AI_PRESET_SERVICES.map((service) => ({
    id: service.id,
    label: service.label,
    format: service.format,
    baseUrl: service.baseUrl,
    ...(service.keyUrl ? { keyUrl: service.keyUrl } : {}),
    hasKey: false,
    last4: "",
    lastTest: null,
  }));
  const servicePatches = overrides.servicePatches || {};
  const customServices = overrides.customServices || [];
  const services = [
    ...baseServices.map((service) => ({ ...service, ...(servicePatches[service.id] || {}) })),
    ...customServices.map((custom) => ({
      hasKey: false,
      last4: "",
      lastTest: null,
      ...custom,
    })),
  ];
  return {
    available: overrides.available ?? true,
    services,
    slots: {
      analysis: { serviceId: "", model: "", summaryModel: "", ...(overrides.slots?.analysis || {}) },
      brain: { serviceId: "", model: "", ...(overrides.slots?.brain || {}) },
      image: { serviceId: "", model: "", ...(overrides.slots?.image || {}) },
    },
    catalog: {
      services: AI_PRESET_SERVICES,
      models: overrides.models || AI_MODELS,
    },
    priceLines: { analysis: [], brain: [], image: [], ...(overrides.priceLines || {}) },
    monthTotals: { analysis: 0, brain: 0, image: 0, ...(overrides.monthTotals || {}) },
  };
}

describe("ai-settings-model: visibleServiceIds", () => {
  it("shows only Claude when only Claude has a key", () => {
    const state = makeState({
      servicePatches: { claude: { hasKey: true, last4: "7Q2F" } },
    });
    assert.deepEqual(visibleServiceIds(state), ["claude"]);
  });

  it("shows Claude, OpenAI, Gemini in preset order when all three have keys", () => {
    const state = makeState({
      servicePatches: {
        gemini: { hasKey: true, last4: "4hTe" },
        claude: { hasKey: true, last4: "7Q2F" },
        openai: { hasKey: true, last4: "x9Lm" },
      },
    });
    assert.deepEqual(visibleServiceIds(state), ["claude", "openai", "gemini"]);
  });

  it("shows custom services even without a key, in state.services order after presets", () => {
    const state = makeState({
      servicePatches: { claude: { hasKey: true, last4: "7Q2F" } },
      customServices: [
        { id: "custom-a", label: "网关 A", format: "claude", baseUrl: "http://127.0.0.1:9001" },
        { id: "custom-b", label: "网关 B", format: "openai", baseUrl: "http://127.0.0.1:9002" },
      ],
    });
    assert.deepEqual(visibleServiceIds(state), ["claude", "custom-a", "custom-b"]);
  });

  it("hides Ollama when untested and unselected, shows it when tested or selected", () => {
    const untested = makeState();
    assert.deepEqual(visibleServiceIds(untested), []);

    const tested = makeState({
      servicePatches: {
        ollama: { lastTest: { ok: false, code: "ollama-offline", at: "2026-11-24T00:00:00Z", models: [] } },
      },
    });
    assert.deepEqual(visibleServiceIds(tested), ["ollama"]);

    const selected = makeState({
      slots: { brain: { serviceId: "ollama", model: "llama3" } },
    });
    assert.deepEqual(visibleServiceIds(selected), ["ollama"]);
  });

  it("shows a preset without a key when selected by learning or present in opened", () => {
    const selectedPreset = makeState({
      slots: { analysis: { serviceId: "claude", model: "claude-haiku-5-5", summaryModel: "claude-sonnet-5-5" } },
    });
    assert.deepEqual(visibleServiceIds(selectedPreset), ["claude"]);

    const openedPreset = makeState();
    assert.deepEqual(visibleServiceIds(openedPreset, { opened: ["openai", "gemini"] }), ["openai", "gemini"]);
  });
});

describe("ai-settings-model: addableServices", () => {
  it("lists only Ollama and Other service when the three cloud presets are visible", () => {
    const state = makeState();
    assert.deepEqual(addableServices(state, ["claude", "openai", "gemini"]), [
      { value: "ollama", label: "本机 Ollama" },
      { value: ADD_CUSTOM_SERVICE_VALUE, label: "其它服务…" },
    ]);
  });

  it("lists all five options in preset order when nothing is visible", () => {
    const state = makeState();
    assert.deepEqual(addableServices(state, []), [
      { value: "claude", label: "Claude" },
      { value: "openai", label: "OpenAI" },
      { value: "gemini", label: "Gemini" },
      { value: "ollama", label: "本机 Ollama" },
      { value: ADD_CUSTOM_SERVICE_VALUE, label: "其它服务…" },
    ]);
  });
});

describe("ai-settings-model: modelGroups", () => {
  it("keeps OpenAI preset analysis group to catalog models only even with 60 tested ids", () => {
    const sixtyIds = Array.from({ length: 60 }, (_, index) => `openai-raw-${index + 1}`);
    const state = makeState({
      servicePatches: {
        openai: {
          hasKey: true,
          last4: "x9Lm",
          lastTest: { ok: true, code: "ok", at: "2026-11-24T00:00:00Z", models: sixtyIds },
        },
      },
    });
    const groups = modelGroups(state, "analysis");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].serviceId, "openai");
    assert.equal(groups[0].heading, "OpenAI · 暂不支持学习");
    assert.deepEqual(groups[0].options, [
      { value: "gpt-5-nano", label: "GPT-5 nano", hint: "默认" },
    ]);
  });

  it("builds Claude-format custom, OpenAI-format custom, and Ollama groups with accurate hints", () => {
    const state = makeState({
      servicePatches: {
        claude: { hasKey: true, last4: "7Q2F" },
        gemini: { hasKey: true, last4: "4hTe" },
        ollama: {
          lastTest: { ok: true, code: "ok", at: "2026-11-24T00:00:00Z", models: ["llama3.2", "qwen2.5"] },
        },
      },
      customServices: [
        {
          id: "custom-claude",
          label: "公司网关",
          format: "claude",
          baseUrl: "http://127.0.0.1:9001",
          hasKey: true,
          last4: "1111",
          lastTest: {
            ok: true,
            code: "ok",
            at: "2026-11-24T00:00:00Z",
            models: ["claude-haiku-5-5", "claude-opus-5-5"],
          },
        },
        {
          id: "custom-openai",
          label: "OpenAI 网关",
          format: "openai",
          baseUrl: "http://127.0.0.1:9002",
          hasKey: true,
          last4: "2222",
          lastTest: {
            ok: true,
            code: "ok",
            at: "2026-11-24T00:00:00Z",
            models: ["flow-model-a", "flow-model-b"],
          },
        },
      ],
    });

    assert.deepEqual(connectedServiceIds(state), ["claude", "gemini", "ollama", "custom-claude", "custom-openai"]);

    const analysisGroups = modelGroups(state, "analysis");
    assert.deepEqual(
      analysisGroups.map((group) => [group.serviceId, group.heading]),
      [
        ["claude", "Claude"],
        ["gemini", "Gemini · 暂不支持学习"],
        ["ollama", "本机 Ollama · 暂不支持学习"],
        ["custom-claude", "公司网关"],
        ["custom-openai", "OpenAI 网关 · 暂不支持学习"],
      ],
    );

    const claudePreset = analysisGroups.find((group) => group.serviceId === "claude");
    assert.deepEqual(claudePreset.options, [
      { value: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "默认" },
      { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "单价 20 倍" },
    ]);

    const claudeCustom = analysisGroups.find((group) => group.serviceId === "custom-claude");
    assert.deepEqual(claudeCustom.options, [
      { value: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "默认" },
      { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "单价 20 倍" },
      { value: "claude-opus-5-5", label: "claude-opus-5-5", hint: "单价未知" },
    ]);

    const openaiCustom = analysisGroups.find((group) => group.serviceId === "custom-openai");
    assert.deepEqual(openaiCustom.options, [
      { value: "gpt-5-nano", label: "GPT-5 nano", hint: "默认" },
      { value: "flow-model-a", label: "flow-model-a", hint: "单价未知" },
      { value: "flow-model-b", label: "flow-model-b", hint: "单价未知" },
    ]);

    const ollamaGroup = analysisGroups.find((group) => group.serviceId === "ollama");
    assert.deepEqual(ollamaGroup.options, [
      { value: "llama3.2", label: "llama3.2" },
      { value: "qwen2.5", label: "qwen2.5" },
    ]);

    // Image excludes Claude, Ollama, and Claude-format custom services.
    const imageGroups = modelGroups(state, "image");
    assert.deepEqual(
      imageGroups.map((group) => group.serviceId),
      ["gemini", "custom-openai"],
    );
  });

  it("restricts summary group to the analysis service (empty when unset) and marks unsupported heading", () => {
    const emptySummary = makeState({
      servicePatches: { claude: { hasKey: true, last4: "7Q2F" } },
    });
    assert.deepEqual(modelGroups(emptySummary, "summary"), []);

    const claudeSelected = makeState({
      servicePatches: {
        claude: { hasKey: true, last4: "7Q2F" },
        openai: { hasKey: true, last4: "x9Lm" },
      },
      slots: { analysis: { serviceId: "claude", model: "claude-haiku-5-5", summaryModel: "claude-sonnet-5-5" } },
    });
    const claudeSummary = modelGroups(claudeSelected, "summary");
    assert.equal(claudeSummary.length, 1);
    assert.equal(claudeSummary[0].serviceId, "claude");
    assert.equal(claudeSummary[0].heading, "Claude");
    assert.deepEqual(claudeSummary[0].options, [
      { value: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "默认" },
    ]);

    const openaiSelected = makeState({
      servicePatches: { openai: { hasKey: true, last4: "x9Lm" } },
      slots: { analysis: { serviceId: "openai", model: "gpt-5-nano", summaryModel: "gpt-5-mini" } },
    });
    const openaiSummary = modelGroups(openaiSelected, "summary");
    assert.equal(openaiSummary.length, 1);
    assert.equal(openaiSummary[0].heading, "OpenAI · 暂不支持学习");
  });
});

describe("ai-settings-model: analysisCostMultiple", () => {
  it("computes 20x for Sonnet vs Haiku and returns null for defaults or unknown models", () => {
    const state = makeState({
      servicePatches: {
        claude: { hasKey: true, last4: "7Q2F" },
        openai: { hasKey: true, last4: "x9Lm" },
      },
    });
    assert.deepEqual(analysisCostMultiple(state, "claude", "claude-sonnet-5-5"), {
      multiple: 20,
      referenceId: "claude-haiku-5-5",
      referenceLabel: "Claude Haiku 5.5",
    });
    assert.equal(analysisCostMultiple(state, "claude", "claude-haiku-5-5"), null);
    assert.equal(analysisCostMultiple(state, "claude", "unknown-model-id"), null);
    assert.equal(analysisCostMultiple(state, "openai", "gpt-5-nano"), null);
  });
});

describe("ai-settings-model: priceWithoutMonth, formatMonthUsd, testPurposeFor", () => {
  it("strips the trailing month segment from all four templates and leaves others unchanged", () => {
    const cases = [
      [
        { template: "单价 输入 {input} · 输出 {output}（每百万 token）· 本月 {month}", params: { input: "$0.10", output: "$0.50", month: "$0.00" } },
        { template: "单价 输入 {input} · 输出 {output}（每百万 token）", params: { input: "$0.10", output: "$0.50", month: "$0.00" } },
      ],
      [
        { template: "单价 图像输出 {output}（每百万 token）· 本月 {month}", params: { output: "$30.00", month: "$1.20" } },
        { template: "单价 图像输出 {output}（每百万 token）", params: { output: "$30.00", month: "$1.20" } },
      ],
      [
        { template: "单价 约 {price} 一张（1K）· 本月 {month}", params: { price: "$0.034", month: "$0.34" } },
        { template: "单价 约 {price} 一张（1K）", params: { price: "$0.034", month: "$0.34" } },
      ],
      [
        { template: "单价未知 · 本月 {month}", params: { month: "$0.00" } },
        { template: "单价未知", params: { month: "$0.00" } },
      ],
    ];
    for (const [input, expected] of cases) {
      assert.deepEqual(priceWithoutMonth(input), expected);
    }

    const plain = { template: "本机运行，不收费", params: {} };
    assert.deepEqual(priceWithoutMonth(plain), plain);
    const noMonth = { template: "单价 输入 {input} · 输出 {output}（每百万 token）", params: { input: "$2.00", output: "$10.00" } };
    assert.deepEqual(priceWithoutMonth(noMonth), noMonth);
  });

  it("formats monthly USD with cent rounding", () => {
    assert.equal(formatMonthUsd(0), "$0.00");
    assert.equal(formatMonthUsd(0.004), "$0.00");
    assert.equal(formatMonthUsd(0.005), "$0.01");
    assert.equal(formatMonthUsd(0.63), "$0.63");
    assert.equal(formatMonthUsd(12.345), "$12.35");
  });

  it("picks image purpose only when the service is used exclusively by image", () => {
    const onlyImage = makeState({
      slots: { image: { serviceId: "gemini", model: "gemini-nano-banana-2.1" } },
    });
    assert.equal(testPurposeFor(onlyImage, "gemini"), "image");

    const learningAndImage = makeState({
      slots: {
        analysis: { serviceId: "gemini", model: "gemini-2.5-flash-lite", summaryModel: "gemini-3.5-flash-lite" },
        image: { serviceId: "gemini", model: "gemini-nano-banana-2.1" },
      },
    });
    assert.equal(testPurposeFor(learningAndImage, "gemini"), "text");

    const unused = makeState();
    assert.equal(testPurposeFor(unused, "gemini"), "text");
  });
});

describe("ai-settings-model: useRowNote", () => {
  it("returns each of the seven note kinds with expected tone and params", () => {
    // 1. no-key
    const noKeyState = makeState({
      slots: { brain: { serviceId: "claude", model: "claude-haiku-5-5" } },
    });
    assert.deepEqual(useRowNote(noKeyState, "brain"), {
      kind: "no-key",
      tone: "danger",
      params: { serviceId: "claude", service: "Claude" },
    });

    // 2. test-failed
    const testFailedState = makeState({
      servicePatches: {
        openai: {
          hasKey: true,
          last4: "x9Lm",
          lastTest: { ok: false, code: "auth", at: "2026-11-24T00:00:00Z", models: [] },
        },
      },
      slots: { image: { serviceId: "openai", model: "gpt-image-2" } },
    });
    assert.deepEqual(useRowNote(testFailedState, "image"), {
      kind: "test-failed",
      tone: "danger",
      params: { serviceId: "openai", service: "OpenAI" },
    });

    // 3. learning-unsupported (analysis only, not summary)
    const unsupportedState = makeState({
      servicePatches: { openai: { hasKey: true, last4: "x9Lm" } },
      slots: { analysis: { serviceId: "openai", model: "gpt-5-nano", summaryModel: "gpt-5-mini" } },
    });
    assert.deepEqual(useRowNote(unsupportedState, "analysis"), {
      kind: "learning-unsupported",
      tone: "danger",
      params: { service: "OpenAI" },
    });
    assert.equal(useRowNote(unsupportedState, "summary"), null);

    // 4. analysis-expensive
    const expensiveState = makeState({
      servicePatches: { claude: { hasKey: true, last4: "7Q2F" } },
      slots: { analysis: { serviceId: "claude", model: "claude-sonnet-5-5", summaryModel: "claude-sonnet-5-5" } },
    });
    assert.deepEqual(useRowNote(expensiveState, "analysis"), {
      kind: "analysis-expensive",
      tone: "danger",
      params: { n: "20", reference: "Claude Haiku 5.5", referenceId: "claude-haiku-5-5" },
    });

    // 5. learning-unknown-price
    const learningUnknownState = makeState({
      customServices: [
        { id: "custom-c", label: "公司网关", format: "claude", baseUrl: "http://127.0.0.1:9001", hasKey: true, last4: "1111" },
      ],
      slots: { analysis: { serviceId: "custom-c", model: "claude-haiku-5-5", summaryModel: "claude-opus-5-5" } },
    });
    assert.deepEqual(useRowNote(learningUnknownState, "summary"), {
      kind: "learning-unknown-price",
      tone: "danger",
      params: { model: "claude-opus-5-5" },
    });

    // 6. unknown-price (brain / image)
    const brainUnknownState = makeState({
      customServices: [
        { id: "custom-c", label: "公司网关", format: "claude", baseUrl: "http://127.0.0.1:9001", hasKey: true, last4: "1111" },
      ],
      slots: { brain: { serviceId: "custom-c", model: "claude-opus-5-5" } },
    });
    assert.deepEqual(useRowNote(brainUnknownState, "brain"), {
      kind: "unknown-price",
      tone: "info",
      params: { model: "claude-opus-5-5" },
    });

    // 7. image-needs-service
    const claudeOnlyState = makeState({
      servicePatches: { claude: { hasKey: true, last4: "7Q2F" } },
      slots: { analysis: { serviceId: "claude", model: "claude-haiku-5-5", summaryModel: "claude-sonnet-5-5" } },
    });
    assert.deepEqual(useRowNote(claudeOnlyState, "image"), {
      kind: "image-needs-service",
      tone: "info",
      params: {},
    });
  });

  it("enforces priority: no-key beats analysis-expensive; learning-unsupported beats learning-unknown-price", () => {
    const noKeyAndExpensive = makeState({
      slots: { analysis: { serviceId: "claude", model: "claude-sonnet-5-5", summaryModel: "claude-sonnet-5-5" } },
    });
    assert.equal(useRowNote(noKeyAndExpensive, "analysis")?.kind, "no-key");

    const unsupportedAndUnknown = makeState({
      customServices: [
        { id: "custom-o", label: "OpenAI 网关", format: "openai", baseUrl: "http://127.0.0.1:9002", hasKey: true, last4: "2222" },
      ],
      slots: { analysis: { serviceId: "custom-o", model: "flow-model-a", summaryModel: "flow-model-b" } },
    });
    assert.equal(useRowNote(unsupportedAndUnknown, "analysis")?.kind, "learning-unsupported");
  });
});
