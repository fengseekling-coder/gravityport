// GravityPort React UI flow (task 316, audit 7-4 interface small items):
// English leaks (sidebar 即梦 -> Jimeng, vendor chip, role-less reference
// hover title), the viewer's missing-original empty stage (the reveal button
// is asserted to exist but never clicked — it would open Finder), the three
// inspector fetches surfacing 500s as 加载失败 instead of looking like empty
// data, and the 查看 entry for version families that carry no generation
// records (badge stays hidden there; the generation-record control keeps it).
// Each ctx.runInPage boots a fresh page, so the language preference is
// persisted at the end of the Chinese round and read at the English boot
// (same pattern as inspector-header.mjs).
import { rm } from "node:fs/promises";
import { join } from "node:path";

export const name = "ui-polish-316";
export const description = "missing original shows the viewer empty stage -> three inspector fetches at 500 show 加载失败, never 暂无生成关系 -> version family without records gets 查看 and VersionCompare -> record-keeping control keeps its badge -> English sidebar shows Jimeng, vendor chip translates, role-less reference title translates, role stays raw";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const create = async (name, color, extra = {}) => ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(`${name}.png`, color),
      prompt: `ui polish ${name}`,
      ...extra,
    });

    const plain = await create("ui316-plain", [74, 127, 181]);
    const missing = await create("ui316-missing", [140, 90, 60]);
    const familyParent = await create("ui316-family-parent", [90, 140, 90]);
    const familyChild = await ctx.api(server.origin, "POST",
      `/api/assets/default/${encodeURIComponent(familyParent.asset.id)}/versions`,
      { version_change: "ui316 family child" });
    const controlParent = await create("ui316-control", [160, 120, 60]);
    await ctx.api(server.origin, "POST", "/api/generations", {
      projectId: "default",
      output_asset_id: controlParent.asset.id,
      provider: "e2e-provider",
      model: "e2e-model",
      effective_prompt: "ui316 control generation record",
    });
    const jimeng = await create("ui316-jimeng", [190, 80, 80], {
      source: { type: "web-jimeng", provider: "jimeng" },
    });
    const jimengStored = await ctx.api(server.origin, "GET",
      `/api/assets/default/${encodeURIComponent(jimeng.asset.id)}`);
    if (String(jimengStored?.asset?.source?.type || jimengStored?.asset?.source_type || "") !== "web-jimeng") {
      throw new Error(`jimeng source did not persist: ${JSON.stringify(jimengStored?.asset?.source || null)}`);
    }

    // Reference host: first reference carries no role (falls back to 参考图 N),
    // second carries a site-provided role that must stay untranslated.
    const rolelessRef = await create("ui316-ref-roleless", [80, 90, 160]);
    const roleRef = await create("ui316-ref-role", [90, 160, 90]);
    const host = await create("ui316-ref-host", [96, 74, 155], {
      references: [
        { reference_id: "ui316-ref-1", asset_id: rolelessRef.asset.id },
        { reference_id: "ui316-ref-2", asset_id: roleRef.asset.id, role: "草图" },
      ],
    });

    // The inspector only renders references that carry a thumbnailUrl; wait
    // for the derivative worker on both linked assets.
    for (const entry of [rolelessRef.asset, roleRef.asset]) {
      const deadline = Date.now() + 90000;
      for (;;) {
        const detail = await ctx.api(server.origin, "GET",
          `/api/assets/default/${encodeURIComponent(entry.id)}`);
        if (detail?.asset?.thumbnail_ready === true) break;
        if (Date.now() > deadline) throw new Error(`reference ${entry.id} never got a thumbnail`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    // Make every viewer URL for the missing asset 404. The derivative worker
    // may still be writing previews after the create returns, so first wait
    // for all three derivatives to be ready, delete original + derivatives,
    // then re-check the URLs and delete again until none of them serves.
    const missingDetail = await (async () => {
      const deadline = Date.now() + 90000;
      for (;;) {
        const detail = await ctx.api(server.origin, "GET",
          `/api/assets/default/${encodeURIComponent(missing.asset.id)}`);
        const asset = detail?.asset || {};
        if (asset.preview_ready === true && asset.medium_ready === true && asset.thumbnail_ready === true) return asset;
        if (Date.now() > deadline) throw new Error(`missing asset derivatives never settled: ${JSON.stringify({ preview: asset.preview_ready, medium: asset.medium_ready, thumbnail: asset.thumbnail_ready })}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    const deleteMissingFiles = async () => {
      await rm(missingDetail.image_path, { force: true });
      // Library URLs (/library/<project>/previews/…) map to disk under
      // <library>/assets/<project>/…; delete every derivative spelling.
      for (const url of viewerUrlsCandidate) {
        if (url === missingDetail.image_url) continue;
        await rm(join(ctx.libraryDir, "assets", url.replace(/^\/library\//, "").split("?")[0]), { force: true });
      }
      for (const dir of ["assets/default/mediums", "assets/default/previews", "assets/default/thumbnails", "mediums", "previews", "thumbnails"]) {
        await rm(join(ctx.libraryDir, dir, `${missing.asset.id}.webp`), { force: true });
      }
    };
    const viewerUrlsCandidate = [missingDetail.image_url, missingDetail.preview_url, missingDetail.medium_url]
      .filter((value, index, all) => value && all.indexOf(value) === index);
    await deleteMissingFiles();
    const viewerUrls = [missingDetail.image_url, missingDetail.preview_url, missingDetail.medium_url]
      .filter((value, index, all) => value && all.indexOf(value) === index);
    const missingUrlsDead = async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const statuses = await Promise.all(viewerUrls.map((url) => fetch(`${server.origin}${url}`, { headers: { "x-mosa-client-token": ctx.token } }).then((response) => response.status).catch(() => 0)));
        if (statuses.every((status) => status === 404)) return true;
        await deleteMissingFiles();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return false;
    };
    if (!(await missingUrlsDead())) {
      throw new Error(`missing asset URLs still serve: ${viewerUrls.join(", ")}`);
    }

    const config = {
      missingId: missing.asset.id,
      plainId: plain.asset.id,
      familyParentId: familyParent.asset.id,
      controlParentId: controlParent.asset.id,
      jimengId: jimeng.asset.id,
      hostId: host.asset.id,
    };

    const zh = await ctx.runInPage(server, `(${zhScenes.toString()})(${JSON.stringify(config)})`);
    if (zh?.pageError) throw new Error(`ui-polish-316 zh page error: ${zh.pageError}`);

    const en = await ctx.runInPage(server, `(${enScenes.toString()})(${JSON.stringify(config)})`);
    if (en?.pageError) throw new Error(`ui-polish-316 en page error: ${en.pageError}`);

    const problems = [];
    const expect = (condition, message) => { if (condition !== true) problems.push(message); };
    const missingStage = zh.missingStage || {};
    expect(missingStage.shown === true, `viewer empty stage never appeared: ${JSON.stringify(missingStage)}`);
    expect(missingStage.text === "原图找不到了", `empty stage copy is ${JSON.stringify(missingStage.text)}`);
    expect(missingStage.buttonLabel === "打开素材位置", `empty stage button is ${JSON.stringify(missingStage.buttonLabel)}`);
    const errorState = zh.errorState || {};
    expect(errorState.treeShowsFailure === true, "版本树 list does not show 加载失败 on 500s");
    expect(errorState.versionSectionShowsFailure === true, "版本 section does not show 加载失败 on 500s");
    expect(errorState.referenceSectionShowsFailure === true, "参考图 section does not show 加载失败 on 500s");
    expect(errorState.emptyTextGone === true, "暂无生成关系 still rendered while the fetches failed");
    const family = zh.family || {};
    expect(family.viewVisible === true, "version family without records shows no 查看 entry");
    expect(family.badgeAbsent === true, "version family without records must not show a badge");
    expect(family.comparePresent === true, `VersionCompare did not render: ${JSON.stringify(family)}`);
    const control = zh.control || {};
    expect(control.viewVisible === true, "generation-record asset lost its 查看 entry");
    expect(control.badgeText === "1", `generation-record badge is ${JSON.stringify(control.badgeText)}`);
    expect(en.sidebarJimeng === true, "English sidebar has no Jimeng group row");
    expect(en.sidebarChineseGone === true, "English sidebar still shows 即梦");
    expect(en.vendorChip === "Jimeng", `English vendor chip is ${JSON.stringify(en.vendorChip)}`);
    expect(en.rolelessTitle === "Reference 1", `English role-less reference title is ${JSON.stringify(en.rolelessTitle)}`);
    expect(en.roleTitle === "草图", `English role reference title must stay raw, got ${JSON.stringify(en.roleTitle)}`);
    if (problems.length) throw new Error(`ui-polish-316: ${problems.join("; ")} — ${JSON.stringify({ zh, en })}`);
    return {
      ok: true,
      missingStage: { text: missingStage.text, buttonLabel: missingStage.buttonLabel },
      english: { sidebarJimeng: en.sidebarJimeng, rolelessTitle: en.rolelessTitle },
    };
  } finally {
    await server.stop();
  }
}

// Runs inside the web driver window. Serialized with Function#toString, so it
// must stay self-contained: no imports, no closures over node-side values.
function zhScenes(config) {
  return (async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try { last = check(); } catch (error) { last = String(error); }
        if (last) return last;
        await sleep(60);
      }
      const media = document.querySelector(".image-viewer .viewer-image");
      const mediaState = media ? { tag: media.tagName, src: (media.getAttribute("src") || "").slice(-60), complete: media.complete, naturalWidth: media.naturalWidth } : null;
      let fetched = null;
      if (media && media.getAttribute("src")) {
        fetched = await fetch(media.getAttribute("src")).then((response) => response.status).catch((error) => String(error));
      }
      throw new Error("Timed out waiting for " + label + " | last=" + String(last)
        + " | viewerOpen=" + Boolean(document.querySelector(".image-viewer"))
        + " | media=" + JSON.stringify(mediaState)
        + " | mediaFetch=" + JSON.stringify(fetched));
    }
    const findCard = async (id) => {
      const grid = document.querySelector(".asset-grid");
      for (let step = 0; step < 60; step += 1) {
        const card = document.querySelector('.asset-grid [data-asset-id="' + id + '"]');
        if (card) return card;
        if (grid) grid.scrollTop += 300;
        await sleep(250);
      }
      throw new Error("card never mounted for " + id);
    };
    const openInspector = async (id) => {
      const card = await findCard(id);
      card.scrollIntoView({ block: "center" });
      card.click();
      await waitFor(() => document.querySelector(".details .asset-title"), "inspector for " + id);
    };
    const closeViewer = async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await waitFor(() => !document.querySelector(".image-viewer"), "viewer closed");
    };
    const treeHeading = () => Array.from(document.querySelectorAll(".details .field-heading"))
      .find((heading) => heading.querySelector("span")?.textContent === "版本树");
    const sections = () => Array.from(document.querySelectorAll(".details .detail-section"));

    await waitFor(() => document.querySelector(".asset-grid"), "gallery grid");
    const scenes = {};
    try {
      // Scene 1: the missing original shows the viewer's empty stage. The
      // reveal button is only asserted to exist — clicking it would open
      // Finder on the machine running the test.
      const missingCard = await findCard(config.missingId);
      missingCard.scrollIntoView({ block: "center" });
      missingCard.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await waitFor(() => document.querySelector(".image-viewer"), "viewer opened");
      const stage = await waitFor(() => document.querySelector(".viewer-missing"), "viewer empty stage");
      scenes.missingStage = {
        shown: true,
        text: (stage.querySelector("p")?.textContent || "").trim(),
        buttonLabel: (stage.querySelector("button")?.textContent || "").trim(),
      };
      await closeViewer();

      // Scene 2: all three inspector fetches answer 500. The UI must show
      // 加载失败 everywhere the empty texts used to pretend "no data".
      const realFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : String(input && input.url || "");
        if (url.includes("/versions") || url.includes("/generation-history") || url.includes("/recipes")) {
          return Promise.resolve(new Response("{}", { status: 500 }));
        }
        return realFetch.call(window, input, init);
      };
      await openInspector(config.plainId);
      await waitFor(() => {
        const tree = document.querySelector('.version-list[aria-label="版本树"]');
        return tree && tree.textContent.includes("加载失败");
      }, "版本树 shows 加载失败");
      const versionSection = sections().find((section) => section.querySelector('.version-list[aria-label="版本"]'));
      const referenceSection = sections().find((section) => {
        const heading = section.querySelector(".field-heading span");
        return heading && heading.textContent === "参考图";
      });
      scenes.errorState = {
        treeShowsFailure: (document.querySelector('.version-list[aria-label="版本树"]')?.textContent || "").includes("加载失败"),
        versionSectionShowsFailure: Boolean(versionSection) && versionSection.textContent.includes("加载失败"),
        referenceSectionShowsFailure: Boolean(referenceSection) && referenceSection.textContent.includes("加载失败"),
        emptyTextGone: !document.body.textContent.includes("暂无生成关系"),
      };
      window.fetch = realFetch;

      // Scene 3: a version family with no generation records still gets the
      // 查看 entry (no badge), and expanding it renders VersionCompare.
      await openInspector(config.familyParentId);
      const familyHeading = await waitFor(() => {
        const heading = treeHeading();
        if (heading && Array.from(heading.querySelectorAll(".section-action")).some((button) => button.textContent.trim() === "查看")) return heading;
        return null;
      }, "family 查看 entry");
      const familyView = Array.from(familyHeading.querySelectorAll(".section-action")).find((button) => button.textContent.trim() === "查看");
      familyView.click();
      await waitFor(() => document.querySelector(".version-compare"), "VersionCompare");
      scenes.family = {
        viewVisible: true,
        badgeAbsent: !familyHeading.querySelector(".settings-badge"),
        comparePresent: Boolean(document.querySelector(".version-compare")),
      };

      // Scene 4: the control asset keeps the old behaviour — the badge counts
      // its single generation record and 查看 stays. The button may read 收起
      // here: scene 3 left versionTreeOpen open and the state survives
      // selection changes.
      await openInspector(config.controlParentId);
      const controlHeading = await waitFor(() => {
        const heading = treeHeading();
        if (heading && heading.querySelector(".settings-badge")) return heading;
        return null;
      }, "control badge");
      scenes.control = {
        viewVisible: Array.from(controlHeading.querySelectorAll(".section-action")).some((button) => ["查看", "收起"].includes(button.textContent.trim())),
        badgeText: (controlHeading.querySelector(".settings-badge")?.textContent || "").trim(),
      };

      // Persist English for the next runInPage round (a fresh page reads it
      // at boot, like inspector-header.mjs).
      localStorage.setItem("gravityport.preferences", JSON.stringify({ appearance: "跟随系统", cardInfo: false, language: "en" }));
      return scenes;
    } catch (error) {
      return { pageError: String(error && error.message ? error.message : error), ...scenes };
    }
  })();
}

function enScenes(config) {
  return (async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try { last = check(); } catch (error) { last = String(error); }
        if (last) return last;
        await sleep(60);
      }
      throw new Error("Timed out waiting for " + label + " | last=" + String(last));
    }
    const findCard = async (id) => {
      const grid = document.querySelector(".asset-grid");
      for (let step = 0; step < 60; step += 1) {
        const card = document.querySelector('.asset-grid [data-asset-id="' + id + '"]');
        if (card) return card;
        if (grid) grid.scrollTop += 300;
        await sleep(250);
      }
      throw new Error("card never mounted for " + id);
    };
    const openInspector = async (id) => {
      const card = await findCard(id);
      card.scrollIntoView({ block: "center" });
      card.click();
      await waitFor(() => document.querySelector(".details .asset-title"), "inspector for " + id);
    };

    await waitFor(() => document.querySelector(".asset-grid"), "gallery grid (en)");
    const scenes = {};
    try {
      // The Jimeng smart-group row exists because the seeded asset carries
      // source.type web-jimeng; the row label must now read Jimeng.
      scenes.sidebarJimeng = await waitFor(() => {
        const rows = Array.from(document.querySelectorAll(".sidebar .group-row"));
        return rows.some((row) => row.getAttribute("aria-label") === "Jimeng" && (row.textContent || "").includes("Jimeng"));
      }, "Jimeng sidebar row");
      scenes.sidebarChineseGone = !Array.from(document.querySelectorAll(".sidebar .group-row"))
        .some((row) => (row.getAttribute("aria-label") || "").includes("即梦") || (row.textContent || "").includes("即梦"));

      // The vendor chip in the inspector tags row.
      await openInspector(config.jimengId);
      const chip = await waitFor(() => {
        const element = document.querySelector(".details .tags .tag-vendor");
        return element ? (element.textContent || "").trim() : null;
      }, "vendor chip");
      scenes.vendorChip = chip;

      // Reference hover titles: the role-less one translates, the site-provided
      // role stays raw.
      await openInspector(config.hostId);
      const titles = await waitFor(() => {
        const buttons = Array.from(document.querySelectorAll(".details .reference-thumbnail"));
        return buttons.length >= 2 ? buttons.map((button) => button.getAttribute("title")) : null;
      }, "reference titles");
      scenes.rolelessTitle = titles.find((title) => /^Reference \d+$/.test(title || "")) || null;
      scenes.roleTitle = titles.includes("草图") ? "草图" : null;

      // Back to Chinese so later rounds of this flow (screenshots etc.) are
      // not affected.
      localStorage.setItem("gravityport.preferences", JSON.stringify({ appearance: "跟随系统", cardInfo: false, language: "zh" }));
      return scenes;
    } catch (error) {
      return { pageError: String(error && error.message ? error.message : error), ...scenes };
    }
  })();
}
