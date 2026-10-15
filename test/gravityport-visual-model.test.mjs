// Visual model description tests.
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let vm; // visual-model exports

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-gp-vm-"));
  const sources = [join(uiRoot, "src", "visual-model.ts")];
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources,
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  vm = await import(join(compileRoot, "visual-model.js"));
  after(async () => { await rm(compileRoot, { recursive: true, force: true }); });
});

describe("describeVisualModel — null status", () => {
  it("returns checking label and empty everything", () => {
    const result = vm.describeVisualModel(null, { install: true, cancel: true, remove: true, toggle: true });
    assert.equal(result.label, "正在检查本地视觉模型…");
    assert.deepEqual(result.details, []);
    assert.equal(result.progress, null);
    assert.equal(result.note, "");
    assert.deepEqual(result.actions, []);
  });
});

describe("describeVisualModel — state labels", () => {
  const cases = [
    ["ready", "已启用，可用于视觉搜索与相似关系"],
    ["runtime-unavailable", "模型已安装，但当前构建尚无可用本地推理运行时"],
    ["loading", "正在启动本地推理运行时…"],
    ["error", "本地视觉模型加载失败，请重新安装或更换模型包"],
    ["disabled", "已安装，尚未启用"],
    ["not-installed", "未安装视觉模型"],
    ["unknown-state", "本地视觉能力不可用"],
  ];
  for (const [state, expected] of cases) {
    it(`state "${state}" → "${expected}"`, () => {
      const result = vm.describeVisualModel(
        { state, installed: false, enabled: false },
        { install: false, cancel: false, remove: false, toggle: false },
      );
      assert.equal(result.label, expected);
    });
  }
});

describe("describeVisualModel — progress phases", () => {
  const phaseCases = [
    ["preparing", "正在下载"],
    ["downloading", "正在下载"],
    ["verifying", "正在校验"],
    ["installing", "正在安装"],
  ];
  for (const [phase, expectedLabel] of phaseCases) {
    it(`phase "${phase}" → "${expectedLabel}"`, () => {
      const result = vm.describeVisualModel(
        {
          state: "not-installed",
          installed: false,
          enabled: false,
          distribution: { action: "install", progress: { phase, percent: 42 } },
        },
        { install: false, cancel: false, remove: false, toggle: false },
      );
      assert.equal(result.progress?.phaseLabel, expectedLabel);
    });
  }
});

describe("describeVisualModel — progress percent clamping", () => {
  it("clamps -5 to 0", () => {
    const result = vm.describeVisualModel(
      {
        state: "not-installed",
        installed: false,
        enabled: false,
        distribution: { progress: { phase: "downloading", percent: -5 } },
      },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.equal(result.progress?.percent, 0);
  });

  it("clamps 150 to 100", () => {
    const result = vm.describeVisualModel(
      {
        state: "not-installed",
        installed: false,
        enabled: false,
        distribution: { progress: { phase: "downloading", percent: 150 } },
      },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.equal(result.progress?.percent, 100);
  });

  it("treats non-numeric percent as 0", () => {
    const result = vm.describeVisualModel(
      {
        state: "not-installed",
        installed: false,
        enabled: false,
        distribution: { progress: { phase: "downloading", percent: "abc" } },
      },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.equal(result.progress?.percent, 0);
  });
});

describe("describeVisualModel — cancel action", () => {
  it("includes cancel when caps.cancel is true during active progress", () => {
    const result = vm.describeVisualModel(
      {
        state: "not-installed",
        installed: false,
        enabled: false,
        distribution: { progress: { phase: "downloading", percent: 50 } },
      },
      { install: true, cancel: true, remove: true, toggle: true },
    );
    assert.ok(result.actions.includes("cancel"));
  });

  it("omits cancel when caps.cancel is false", () => {
    const result = vm.describeVisualModel(
      {
        state: "not-installed",
        installed: false,
        enabled: false,
        distribution: { progress: { phase: "downloading", percent: 50 } },
      },
      { install: true, cancel: false, remove: true, toggle: true },
    );
    assert.ok(!result.actions.includes("cancel"));
  });
});

describe("describeVisualModel — install and update actions", () => {
  it("shows install when action is install and caps.install is true", () => {
    const result = vm.describeVisualModel(
      {
        state: "not-installed",
        installed: false,
        enabled: false,
        distribution: { action: "install" },
      },
      { install: true, cancel: false, remove: false, toggle: false },
    );
    assert.ok(result.actions.includes("install"));
  });

  it("shows update when action is update and caps.install is true", () => {
    const result = vm.describeVisualModel(
      {
        state: "ready",
        installed: true,
        enabled: true,
        distribution: { action: "update" },
      },
      { install: true, cancel: false, remove: false, toggle: false },
    );
    assert.ok(result.actions.includes("update"));
  });

  it("omits install/update when caps.install is false", () => {
    const result = vm.describeVisualModel(
      {
        state: "not-installed",
        installed: false,
        enabled: false,
        distribution: { action: "install" },
      },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.ok(!result.actions.includes("install"));
    assert.ok(!result.actions.includes("update"));
  });
});

describe("describeVisualModel — enable/disable actions", () => {
  it("shows disable when installed and enabled", () => {
    const result = vm.describeVisualModel(
      { state: "ready", installed: true, enabled: true },
      { install: false, cancel: false, remove: false, toggle: true },
    );
    assert.ok(result.actions.includes("disable"));
  });

  it("shows enable when installed but not enabled", () => {
    const result = vm.describeVisualModel(
      { state: "disabled", installed: true, enabled: false },
      { install: false, cancel: false, remove: false, toggle: true },
    );
    assert.ok(result.actions.includes("enable"));
  });

  it("omits enable/disable when caps.toggle is false", () => {
    const result = vm.describeVisualModel(
      { state: "ready", installed: true, enabled: true },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.ok(!result.actions.includes("disable"));
    assert.ok(!result.actions.includes("enable"));
  });
});

describe("describeVisualModel — remove action", () => {
  it("shows remove when installed and caps.remove is true", () => {
    const result = vm.describeVisualModel(
      { state: "ready", installed: true, enabled: true },
      { install: false, cancel: false, remove: true, toggle: false },
    );
    assert.ok(result.actions.includes("remove"));
  });

  it("omits remove when caps.remove is false", () => {
    const result = vm.describeVisualModel(
      { state: "ready", installed: true, enabled: true },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.ok(!result.actions.includes("remove"));
  });
});

describe("describeVisualModel — notes", () => {
  it('note: distribution.error → "暂时无法获取视觉能力包发布信息"', () => {
    const result = vm.describeVisualModel(
      {
        state: "not-installed",
        installed: false,
        enabled: false,
        distribution: { action: "unavailable", error: new Error("network") },
      },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.equal(result.note, "暂时无法获取视觉能力包发布信息");
  });

  it('note: not-installed + unavailable action → "当前平台暂未发布可安装的视觉能力包"', () => {
    const result = vm.describeVisualModel(
      {
        state: "not-installed",
        installed: false,
        enabled: false,
        distribution: { action: "unavailable" },
      },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.equal(result.note, "当前平台暂未发布可安装的视觉能力包");
  });

  it("note: empty when none of the above", () => {
    const result = vm.describeVisualModel(
      { state: "ready", installed: true, enabled: true },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.equal(result.note, "");
  });
});

describe("describeVisualModel — size formatting", () => {
  it("0 bytes → no size shown in active_pack line", () => {
    const result = vm.describeVisualModel(
      {
        state: "ready",
        installed: true,
        enabled: true,
        active_pack: { id: "model-x", revision: "r1", total_bytes: 0 },
      },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.equal(result.details[0], "model-x · r1");
  });

  it("5.25 MB (not ≥100MB) → one decimal", () => {
    const result = vm.describeVisualModel(
      {
        state: "ready",
        installed: true,
        enabled: true,
        active_pack: { id: "model-x", revision: "r1", total_bytes: 5.25 * 1024 * 1024 },
      },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.ok(result.details[0].includes("5.3 MB"));
  });

  it("150 MB (≥100MB) → no decimal", () => {
    const result = vm.describeVisualModel(
      {
        state: "ready",
        installed: true,
        enabled: true,
        active_pack: { id: "model-x", revision: "r1", total_bytes: 150 * 1024 * 1024 },
      },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.ok(result.details[0].includes("150 MB"));
  });

  it("release size → always no decimal", () => {
    const result = vm.describeVisualModel(
      {
        state: "not-installed",
        installed: false,
        enabled: false,
        distribution: { release: { id: "rel-1", total_size: 125 * 1024 * 1024 } },
      },
      { install: false, cancel: false, remove: false, toggle: false },
    );
    assert.ok(result.details[0].includes("125 MB"));
  });
});

describe("applyVisualPackProgress", () => {
  it("does not mutate the original status", () => {
    const original = {
      state: "ready",
      installed: true,
      enabled: true,
      distribution: { progress: { phase: "downloading", percent: 30 } },
    };
    const result = vm.applyVisualPackProgress(original, { phase: "verifying", percent: 60 });
    assert.notStrictEqual(result, original);
    assert.equal(original.distribution.progress.phase, "downloading");
    assert.equal(result?.distribution.progress.phase, "verifying");
  });

  it("changes action to installing when phase is active", () => {
    const result = vm.applyVisualPackProgress(
      { state: "not-installed", installed: false, enabled: false, distribution: { action: "install" } },
      { phase: "installing", percent: 90 },
    );
    assert.equal(result?.distribution.action, "installing");
  });

  it("action unchanged when progress is null", () => {
    const result = vm.applyVisualPackProgress(
      { state: "not-installed", installed: false, enabled: false, distribution: { action: "install" } },
      null,
    );
    assert.equal(result?.distribution.action, "install");
  });

  it("returns null when status is null", () => {
    const result = vm.applyVisualPackProgress(null, { phase: "downloading", percent: 50 });
    assert.equal(result, null);
  });
});

describe("visualModelActionLabel", () => {
  const cases = [
    ["install", "安装视觉能力包"],
    ["update", "更新视觉能力包"],
    ["cancel", "取消"],
    ["enable", "启用"],
    ["disable", "停用"],
    ["remove", "删除视觉能力包"],
  ];
  for (const [action, expected] of cases) {
    it(`"${action}" → "${expected}"`, () => {
      assert.equal(vm.visualModelActionLabel(action), expected);
    });
  }
});

describe("describeVisualModel — actions during an active download", () => {
  const downloading = {
    state: "disabled",
    installed: true,
    enabled: false,
    distribution: { action: "update", progress: { phase: "downloading", percent: 30 } },
  };

  it("never offers install/update mid-download, even without the cancel bridge", () => {
    const result = vm.describeVisualModel(downloading, { install: true, cancel: false, remove: true, toggle: true });
    assert.ok(!result.actions.includes("update"));
    assert.ok(!result.actions.includes("install"));
    assert.ok(!result.actions.includes("cancel"));
  });

  it("keeps enable/remove for an installed pack while an update downloads", () => {
    const result = vm.describeVisualModel(downloading, { install: true, cancel: true, remove: true, toggle: true });
    assert.deepEqual(result.actions, ["cancel", "enable", "remove"]);
  });
});
