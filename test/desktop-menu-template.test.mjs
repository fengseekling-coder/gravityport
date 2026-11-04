import assert from "node:assert/strict";
import test from "node:test";
import { buildMenuTemplate, GRAVITYPORT_APP_MENU_LABEL } from "../desktop/menu-template.mjs";

// 任务 351 第 1 条：Windows 按 Alt 时应用菜单第一项显示 "GravityPort"，
// 非 macOS 去掉 Mac 专有的 services/hide 项；macOS 菜单保持原样。
// 这里的 id 序列就是 351 改动前 desktop/main.mjs buildMenu 的模板，
// darwin 分支必须与它逐项一致。

function flattenIds(template) {
  return template.map((top) => [
    top.id,
    top.submenu.map((item) => item.id),
  ]);
}

const DARWIN_APP_SUBMENU_IDS = [
  "mosa-menu-about",
  "mosa-menu-app-separator-1",
  "mosa-menu-services",
  "mosa-menu-app-separator-2",
  "mosa-menu-hide",
  "mosa-menu-hide-others",
  "mosa-menu-show-all",
  "mosa-menu-app-separator-3",
  "mosa-menu-quit",
];

const DARWIN_TEMPLATE_IDS = [
  ["mosa-menu-app", DARWIN_APP_SUBMENU_IDS],
  ["mosa-menu-file", ["mosa-menu-close"]],
  ["mosa-menu-edit", [
    "mosa-menu-undo",
    "mosa-menu-redo",
    "mosa-menu-edit-separator-1",
    "mosa-menu-cut",
    "mosa-menu-copy",
    "mosa-menu-paste",
    "mosa-menu-paste-match-style",
    "mosa-menu-delete",
    "mosa-menu-select-all",
  ]],
  ["mosa-menu-view", [
    "mosa-menu-search",
    "mosa-menu-view-separator-1",
    "mosa-menu-reset-zoom",
    "mosa-menu-zoom-in",
    "mosa-menu-zoom-out",
    "mosa-menu-view-separator-2",
    "mosa-menu-toggle-fullscreen",
  ]],
  ["mosa-menu-window", [
    "mosa-menu-minimize",
    "mosa-menu-window-zoom",
    "mosa-menu-window-separator-1",
    "mosa-menu-bring-all-to-front",
  ]],
];

test("darwin menu template keeps the pre-351 item ids, roles, accelerators and search wiring", () => {
  const onSearch = () => {};
  const template = buildMenuTemplate({ platform: "darwin", locale: "zh", onSearch });

  assert.deepEqual(flattenIds(template), DARWIN_TEMPLATE_IDS);

  const appSubmenu = template[0].submenu;
  assert.deepEqual(
    appSubmenu.filter((item) => item.type !== "separator").map((item) => item.role),
    ["about", "services", "hide", "hideOthers", "unhide", "quit"],
  );
  // 351 前 app 菜单 label 是 app.name；按任务单改为固定产品名。
  assert.equal(template[0].label, GRAVITYPORT_APP_MENU_LABEL);
  assert.equal(template[0].label, "GravityPort");

  const search = template.find((top) => top.id === "mosa-menu-view").submenu[0];
  assert.equal(search.id, "mosa-menu-search");
  assert.equal(search.accelerator, "CmdOrCtrl+F");
  assert.equal(search.click, onSearch);

  // 标签走 desktop i18n（zh）。
  assert.equal(appSubmenu[0].label, "关于 GravityPort");
  assert.equal(appSubmenu[appSubmenu.length - 1].label, "退出 GravityPort");
});

test("win32 menu template drops Mac-only roles and shows GravityPort without stray separators", () => {
  const template = buildMenuTemplate({ platform: "win32", locale: "en", onSearch: () => {} });

  assert.equal(template[0].label, "GravityPort");
  assert.equal(template[0].id, "mosa-menu-app");

  const macOnlyRoles = new Set(["services", "hide", "hideOthers", "unhide"]);
  for (const top of template) {
    const submenu = top.submenu;
    for (const [index, item] of submenu.entries()) {
      assert.equal(macOnlyRoles.has(item.role), false, `${item.id} must not use a Mac-only role on win32`);
      if (item.type === "separator") {
        assert.ok(index > 0 && index < submenu.length - 1, `${item.id} must not sit at the head or tail of ${top.id}`);
        assert.notEqual(submenu[index - 1]?.type, "separator", `${item.id} must not follow a separator in ${top.id}`);
      }
    }
  }

  // 非 macOS 应用菜单只留「关于」和「退出」（中间一条分隔线）。
  const appEntries = template[0].submenu;
  assert.deepEqual(
    appEntries.filter((item) => item.type !== "separator").map((item) => item.id),
    ["mosa-menu-about", "mosa-menu-quit"],
  );
  assert.equal(appEntries.filter((item) => item.type === "separator").length, 1);

  // 其余菜单与 macOS 共用同一模板（id 一致，只是 app 子菜单收窄）。
  assert.deepEqual(
    flattenIds(template).slice(1),
    DARWIN_TEMPLATE_IDS.slice(1),
  );
});

test("menu template labels follow the desktop i18n locale", () => {
  const zh = buildMenuTemplate({ platform: "win32", locale: "zh", onSearch: () => {} });
  const en = buildMenuTemplate({ platform: "win32", locale: "en", onSearch: () => {} });

  assert.equal(zh[0].submenu[0].label, "关于 GravityPort");
  assert.equal(en[0].submenu[0].label, "About GravityPort");
  assert.equal(zh[1].label, "文件");
  assert.equal(en[1].label, "File");
});
