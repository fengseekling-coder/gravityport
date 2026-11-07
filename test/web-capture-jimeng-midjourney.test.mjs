import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";
import { generationSessionKey } from "../lib/generation-session.mjs";
import { sourceSearchDisplayName } from "../lib/asset-search-scope.mjs";
import {
  createBackgroundHarness,
  senderFor,
  fakeImageBase64,
  CHATGPT_TAB_URL,
  JIMENG_TAB_URL,
  MIDJOURNEY_TAB_URL,
} from "./helpers/background-harness.mjs";

const extensionRoot = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionRoot), "utf8"));
const providerPolicySource = await readFile(new URL("provider-policy.js", extensionRoot), "utf8");
const providerJimengSource = await readFile(new URL("provider-jimeng.js", extensionRoot), "utf8");
const providerMidjourneySource = await readFile(new URL("provider-midjourney.js", extensionRoot), "utf8");
const jimengHookSource = await readFile(new URL("jimeng-page-hook.js", extensionRoot), "utf8");
// The two minimal fixtures below copy the 330 read-only response sample's
// field layout and text; only ids and media URLs are synthetic.
const realJimengSample = {
  "imageSample_图片生成": {
    type: 1,
    image: {
      item_list: [{
        common_attr: {
          prompt: "抽象构成主义艺术海报，大面积红黑撞色，几何圆形与斜切矩形交错，粗颗粒丝网印刷质感，留白克制，包豪斯风格，高级感",
          description: "抽象构成主义艺术海报，大面积红黑撞色，几何圆形与斜切矩形交错，粗颗粒丝网印刷质感，留白克制，包豪斯风格，高级感",
        },
        aigc_image_params: {
          reference_prompt: "抽象构成主义艺术海报，大面积红黑撞色，几何圆形与斜切矩形交错，粗颗粒丝网印刷质感，留白克制，包豪斯风格，高级感",
          text2image_params: {
            prompt: "抽象构成主义艺术海报，大面积红黑撞色，几何圆形与斜切矩形交错，粗颗粒丝网印刷质感，留白克制，包豪斯风格，高级感",
            model_config: { model_name: "Seedream 5.0 Surge" },
          },
        },
      }],
    },
  },
  "agentSample_智能体": {
    type: 10,
    agent_conversation_session: {
      conversation_session: {
        scene: "creation_agent_v33",
        "mapping_按消息": [
          { id: "msg-3", "author.role": "user", parent_message_id: "", text: "A bold graphic poster on a solid vivid red background, futuristic high-end 3D render / 3D illustration style, minimal clean layout, like a promotional poster. Overall scene: a vertical poster for Teachers’ Day with a single large centerpiece: a futuristic meta…（截断）" },
          { id: "msg-2", "author.role": "assistant", parent_message_id: "msg-3", mentions_submit_id: "submit-1", text: "我把提示词重新优化了优先级，先锁死全红底主视觉和金属音符长城重工结构，再把每段文字的要求写得更干净明确，避开多余干扰，用你面板指定的5.0Pro 1.5k参数重新提交这版完整带排版的海报。" },
          { id: "msg-1", "author.role": "tool", parent_message_id: "msg-2", mentions_submit_id: "submit-1", text: "[工具返回 JSON，略]" },
          { id: "msg-4", "author.role": "assistant", parent_message_id: "msg-1", text: "已提交生成，这版是全要素完整版，把重工金属音符长城主视觉和你写好的全部精准文字排版都整合进去了，很快就能出这张亮红底高级教师节宣传海报。" },
          { id: "msg-5", "author.role": "assistant", parent_message_id: "msg-4", text: "" },
        ],
      },
      submit_id_data_map: {
        "submit-1": {
          submit_id: "submit-1",
          generate_type: 1,
          model_info: { model_name: "Seedream 5.0 Pro" },
          item_list: [{
            common_attr: { prompt: "Vertical 9:16 premium Teachers Day advertising poster, 100% solid vivid bright flat red background, no scenery no people, ultra clean minimal layout, high detail 3D CGI rende…（截断）" },
          }],
        },
      },
    },
  },
};

const jimengSampleTime = Date.parse("2026-11-01T10:00:00Z");
function addSampleMedia(item, identity) {
  item.common_attr.id = identity;
  item.common_attr.create_time = Math.floor(jimengSampleTime / 1000);
  item.image = { large_images: [{
    image_url: "https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/abc~tplv-fake-aigc_resize:0:0.png?x-signature=fake",
    width: 1440,
    height: 2560,
  }] };
}

function jimengImageSample() {
  const record = structuredClone(realJimengSample["imageSample_图片生成"]);
  record.image.mode = "workbench";
  record.image.metrics_extra = JSON.stringify({ promptSource: "custom", prompt: "不该被读到" });
  record.image.history_record_id = "8100000000000000001";
  record.image.created_time = Math.floor(jimengSampleTime / 1000);
  addSampleMedia(record.image.item_list[0], "8100000000000000011");
  return { data: { asset_list: [record] } };
}

function jimengAgentSample() {
  const record = structuredClone(realJimengSample["agentSample_智能体"]);
  const session = record.agent_conversation_session;
  const mapping = {};
  for (const message of session.conversation_session["mapping_按消息"]) {
    mapping[message.id] = {
      author: { role: message["author.role"] },
      metadata: { parent_message_id: message.parent_message_id },
      content: { content_parts: [{ text: message.mentions_submit_id
        ? `${message.text} ${message.mentions_submit_id}` : message.text }] },
    };
  }
  delete session.conversation_session["mapping_按消息"];
  session.conversation_session.mapping = mapping;
  const submit = session.submit_id_data_map["submit-1"];
  submit.history_record_id = "8200000000000000001";
  submit.created_time = Math.floor(jimengSampleTime / 1000);
  addSampleMedia(submit.item_list[0], "8200000000000000011");
  return { data: { asset_list: [record] } };
}

test("Jimeng sample: ordinary generation preserves submitted words and model", () => {
  const { records } = jimeng.extractJimengResponse(JSON.stringify(jimengImageSample()));
  assert.equal(records.length, 1);
  const prompt = realJimengSample["imageSample_图片生成"].image.item_list[0].common_attr.prompt;
  assert.equal(records[0].prompt, prompt);
  assert.equal(records[0].userMessage, prompt);
  assert.equal(records[0].promptKind, "submitted");
  assert.equal(records[0].model, "Seedream 5.0 Surge");
  assert.notEqual(records[0].userMessage, "不该被读到");
});

// Field layout and original prompt text from the 331 get_history_by_ids_final
// real-time sample; placeholders are replaced by test-only media identifiers.
function jimengAgentPollSample(nowMs) {
  const prompt = "Minimalist flat vector illustration, a chubby cute white kitten sitting upright on a bright blue windowsill, soft rounded shapes, clean color blocks with no outlines, limited palette of white, sky blue, cobalt blue, warm cream and light wood tones, a small green potted plant on the sill, soft morning light coming through the window, calm cozy gentle mood, pink nose and tiny pink inner ears, tail curled neatly around front paws, simple geometric composition, lots of negative space, no text, no people, no realistic textures";
  const userMessage = "帮我画一张图：一只白色小猫坐在蓝色窗台上，扁平插画风格，只要一张";
  return {
    data: {
      "submit-live": {
        mode: "creation_agent_v33",
        status: 50,
        submit_id: "submit-live",
        history_record_id: "history-live",
        created_time: Math.floor(nowMs / 1000),
        model_info: { model_name: "Seedream 5.0 Pro" },
        metrics_extra: JSON.stringify({
          userMessageId: "msg-user-live", prompt: userMessage, isAddImage: 0,
          conversationId: "conv-live", hasRejectedAudit: 0, referenceCnt: 0,
          position: "page_bottom_box", enterFrom: "click",
        }),
        item_list: [{
          common_attr: { id: "8100000000000000021", prompt, description: prompt },
          aigc_image_params: {
            aigc_mode: "creation_agent_v33",
            reference_prompt: prompt,
            text2image_params: { prompt, model_config: { model_name: "Seedream 5.0 Pro" } },
          },
          image: { large_images: [{
            image_url: "https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/kitten~tplv-fake-aigc_resize:0:0.png?x-signature=fake",
            width: 1440, height: 2560,
          }] },
        }],
      },
    },
  };
}

test("Jimeng real-time agent poll reads the model prompt and metrics user instruction separately", () => {
  const nowMs = jimengSampleTime;
  const records = jimeng.extractJimengResponse(JSON.stringify(jimengAgentPollSample(nowMs))).records;
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.promptKind, "agent");
  assert.match(record.prompt, /^Minimalist flat vector illustration, a chubby cute white kitten/);
  assert.equal(record.userMessage, "帮我画一张图：一只白色小猫坐在蓝色窗台上，扁平插画风格，只要一张");
  assert.equal(record.model, "Seedream 5.0 Pro");
  const payload = jimeng.basePayload(record, "image", record.image.url);
  assert.equal(payload.promptStatus, "generation-tool-prompt");
  assert.equal(payload.promptSource, "jimeng-agent-prompt");
  assert.equal(payload.userMessage, record.userMessage);
});

test("Jimeng real-time agent poll recognizes item-level aigc_mode without record mode", () => {
  const response = jimengAgentPollSample(jimengSampleTime);
  delete response.data["submit-live"].mode;
  const [record] = jimeng.extractJimengResponse(JSON.stringify(response)).records;
  assert.equal(record.promptKind, "agent");
  assert.equal(record.userMessage, "帮我画一张图：一只白色小猫坐在蓝色窗台上，扁平插画风格，只要一张");
});

test("Jimeng malformed agent metrics never substitutes model prompt for user instruction", () => {
  const response = jimengAgentPollSample(jimengSampleTime);
  response.data["submit-live"].metrics_extra = "{not json";
  const [record] = jimeng.extractJimengResponse(JSON.stringify(response)).records;
  assert.equal(record.promptKind, "agent");
  assert.equal(record.userMessage, "");
  assert.match(record.prompt, /^Minimalist flat vector illustration/);
});

test("Jimeng sample: agent submit prompt stays separate from its invoking user turn", () => {
  const { records } = jimeng.extractJimengResponse(JSON.stringify(jimengAgentSample()));
  assert.equal(records.length, 1);
  assert.match(records[0].prompt, /^Vertical 9:16 premium Teachers Day advertising poster/);
  assert.match(records[0].userMessage, /^A bold graphic poster on a solid vivid red background/);
  assert.equal(records[0].promptKind, "agent");
  assert.equal(records[0].model, "Seedream 5.0 Pro");
});

test("Jimeng agent: broken parent link stops instead of using assistant text", () => {
  const response = jimengAgentSample();
  response.data.asset_list[0].agent_conversation_session.conversation_session.mapping["msg-2"].metadata.parent_message_id = "";
  const [record] = jimeng.extractJimengResponse(JSON.stringify(response)).records;
  assert.equal(record.userMessage, "");
  assert.equal(record.promptKind, "agent");
  assert.match(record.prompt, /^Vertical 9:16/);
});

test("Jimeng agent: a parent cycle terminates without an instruction", () => {
  const response = jimengAgentSample();
  const mapping = response.data.asset_list[0].agent_conversation_session.conversation_session.mapping;
  mapping["msg-2"].metadata.parent_message_id = "msg-1";
  mapping["msg-1"].metadata.parent_message_id = "msg-2";
  const [record] = jimeng.extractJimengResponse(JSON.stringify(response)).records;
  assert.equal(record.userMessage, "");
});

test("Jimeng agent: mention-only content parts are skipped between text parts", () => {
  const response = jimengAgentSample();
  response.data.asset_list[0].agent_conversation_session.conversation_session.mapping["msg-3"].content.content_parts = [
    { text: "参考" }, { mention: { material: {} } }, { text: "视频的运镜" },
  ];
  const [record] = jimeng.extractJimengResponse(JSON.stringify(response)).records;
  assert.equal(record.userMessage, "参考视频的运镜");
});

test("Jimeng sample: a JSON prompt is retained verbatim", () => {
  const response = jimengImageSample();
  const json = '{ "layout": "poster", "background": "vivid red", "aesthetic_style": "Bauhaus geometry" }';
  response.data.asset_list[0].image.item_list[0].common_attr.prompt = json;
  const [record] = jimeng.extractJimengResponse(JSON.stringify(response)).records;
  assert.equal(record.prompt, json);
  assert.equal(record.userMessage, json);
});

test("Jimeng sample: description alone is not a prompt", () => {
  const response = jimengImageSample();
  const item = response.data.asset_list[0].image.item_list[0];
  item.common_attr.prompt = "";
  delete item.aigc_image_params;
  const [record] = jimeng.extractJimengResponse(JSON.stringify(response)).records;
  assert.equal(record.prompt, "");
  assert.equal(record.userMessage, "");
});

test("Jimeng payloads label submitted, agent, and unavailable prompts consistently", () => {
  const submitted = jimeng.extractJimengResponse(JSON.stringify(jimengImageSample())).records[0];
  const agent = jimeng.extractJimengResponse(JSON.stringify(jimengAgentSample())).records[0];
  const empty = { ...submitted, prompt: "", userMessage: "" };
  for (const makePayload of [
    (record) => jimeng.basePayload(record, "image", record.image.url),
    (record) => jimeng.manualPayload("image", record.image.url, record),
  ]) {
    const a = makePayload(submitted);
    assert.equal(a.promptStatus, "provider-visible-prompt");
    assert.equal(a.promptSource, "jimeng-submitted-prompt");
    assert.equal(a.userMessage, submitted.prompt);
    const b = makePayload(agent);
    assert.equal(b.promptStatus, "generation-tool-prompt");
    assert.equal(b.promptSource, "jimeng-agent-prompt");
    assert.equal(b.userMessage, agent.userMessage);
    const c = makePayload(empty);
    assert.equal(c.promptStatus, "not-available");
    assert.equal(c.promptSource, "");
  }
});

// Everything below runs on synthetic fixtures: no real account, token, or
// signature values are embedded; URL query strings carry fake placeholders.

function createProviderSandbox(source, filename) {
  const sandbox = {
    URL,
    location: { href: "https://jimeng.jianying.com/ai-tool/generate" },
    atob: (value) => Buffer.from(String(value), "base64").toString("binary"),
    btoa: (value) => Buffer.from(String(value), "binary").toString("base64"),
  };
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInNewContext(source, sandbox, { filename });
  return sandbox;
}

const jimeng = createProviderSandbox(providerJimengSource, "provider-jimeng.js").MosaJimengCapture;
const midjourney = createProviderSandbox(providerMidjourneySource, "provider-midjourney.js").MosaMidjourneyCapture;

function jimengPollFixture(nowMs) {
  const hqVideoUrl = "https://v3-dreamnia.jimeng.com/fake/video-src-key.mp4?fake=1";
  return {
    ret: 0,
    data: {
      "7468000000000000001": {
        status: 50,
        create_time: Math.floor(nowMs / 1000),
        prompt: "海边小镇的黄昏，胶片感",
        model_name: "图片 2.1",
        item_list: [
          {
            item_id: "7468000000000000011",
            image: {
              large_images: [
                {
                  image_url: "https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/key-AAAA~tplv-fake-aigc_resize:360:360.webp?lk3s=fake&x-expires=1&x-signature=fake",
                  width: 360,
                  height: 360,
                },
                {
                  image_url: "https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/key-AAAA~tplv-fake-aigc_resize:2400:2400.webp?lk3s=fake&x-expires=1&x-signature=fake",
                  width: 816,
                  height: 1456,
                },
              ],
            },
          },
          {
            item_id: "7468000000000000012",
            video: {
              video_model: JSON.stringify({
                video_list: {
                  video_1: { main_url: Buffer.from("https://v3-dreamnia.jimeng.com/fake/low.mp4?fake").toString("base64") },
                  video_2: { main_url: Buffer.from(hqVideoUrl).toString("base64") },
                },
              }),
              transcoded_video: { origin: { video_url: "https://v3-dreamnia.jimeng.com/fake/watermarked.mp4?fake" } },
            },
          },
        ],
      },
      "7467000000000000001": {
        status: 50,
        create_time: Math.floor(nowMs / 1000) - 86_400,
        prompt: "上周生成的旧图",
        item_list: [
          {
            item_id: "7467000000000000011",
            image: {
              large_images: [
                {
                  image_url: "https://p9-dreamina-sign.byteimg.com/tos-cn-i-fake/key-BBBB~tplv-fake-aigc_resize:360:360.webp?lk3s=fake&x-expires=1&x-signature=fake",
                  width: 360,
                  height: 360,
                },
              ],
            },
          },
        ],
      },
    },
  };
}

test("provider policy recognizes Jimeng and Midjourney pages and videos", () => {
  const sandbox = { URL };
  vm.runInNewContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  const policy = sandbox.MosaProviderPolicy;
  assert.equal(policy.providerForPageUrl("https://jimeng.jianying.com/ai-tool/generate?type=image"), "jimeng");
  assert.equal(policy.providerForPageUrl("https://jimeng.jianying.com/ai-tool/asset"), "jimeng");
  assert.equal(policy.providerForPageUrl("https://www.midjourney.com/imagine"), "midjourney");
  assert.equal(policy.providerForPageUrl("https://www.midjourney.com/jobs/abc123"), "midjourney");
  assert.equal(policy.providerForPageUrl("https://evil.example/?next=https://jimeng.jianying.com/"), "");
  assert.equal(policy.providerForPageUrl("https://jianying.com/"), "");
  assert.equal(policy.providerForPageUrl("https://midjourney.com/imagine"), "");
  assert.equal(policy.supportsVideo("jimeng"), true);
  assert.equal(policy.supportsVideo("midjourney"), true);
  assert.equal(policy.supportsVideo("chatgpt"), false);
});

test("manifest declares the two new sites, their CDNs, and 0.15.45", () => {
  assert.equal(manifest.version, "0.15.45");
  for (const host of [
    "https://jimeng.jianying.com/*",
    "https://*.byteimg.com/*",
    "https://*.jimeng.com/*",
    "https://*.vlabvod.com/*",
    "https://www.midjourney.com/*",
    "https://cdn.midjourney.com/*",
  ]) assert.ok(manifest.host_permissions.includes(host), `missing ${host}`);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);

  const jimengHook = manifest.content_scripts.find((entry) => entry.js?.includes("jimeng-page-hook.js"));
  assert.deepEqual(jimengHook?.matches, ["https://jimeng.jianying.com/*"]);
  assert.equal(jimengHook?.world, "MAIN");
  assert.equal(jimengHook?.run_at, "document_start");
  const jimengProvider = manifest.content_scripts.find((entry) => entry.js?.includes("provider-jimeng.js"));
  assert.deepEqual(jimengProvider?.js, ["provider-policy.js", "provider-jimeng.js"]);
  assert.equal(jimengProvider?.run_at, "document_idle");
  const mjProvider = manifest.content_scripts.find((entry) => entry.js?.includes("provider-midjourney.js"));
  assert.deepEqual(mjProvider?.js, ["provider-policy.js", "provider-midjourney.js"]);
  assert.deepEqual(mjProvider?.matches, ["https://www.midjourney.com/*"]);
  assert.equal(mjProvider?.world, undefined, "Midjourney adapter must stay in the isolated world");
});

test("jimeng extractor picks the largest image variant and the watermark-free video", () => {
  const nowMs = Date.parse("2026-10-23T10:00:00Z");
  const { records } = jimeng.extractJimengResponse(JSON.stringify(jimengPollFixture(nowMs)));
  assert.equal(records.length, 3);

  const image = records.find((record) => record.identity === "7468000000000000011");
  assert.ok(image, "fresh image item extracted");
  assert.equal(image.image.kind, "image");
  assert.match(image.image.url, /aigc_resize:2400:2400\.webp/, "the 360 thumbnail must lose to the 2400 variant");
  assert.equal(image.prompt, "海边小镇的黄昏，胶片感");
  assert.equal(image.model, "图片 2.1");
  assert.equal(image.historyId, "7468000000000000001");
  assert.equal(image.generationStatus, "completed");
  assert.equal(jimeng.isFreshGeneration(image.capturedAtMs, nowMs), true);

  const video = records.find((record) => record.identity === "7468000000000000012");
  assert.ok(video, "fresh video item extracted");
  assert.equal(video.video.kind, "video");
  assert.equal(video.video.url, "https://v3-dreamnia.jimeng.com/fake/video-src-key.mp4?fake=1",
    "the highest-bitrate base64 main_url wins over the watermarked origin URL");

  const old = records.find((record) => record.identity === "7467000000000000011");
  assert.ok(old, "history item is still extracted (baseline bookkeeping)");
  assert.equal(jimeng.isFreshGeneration(old.capturedAtMs, nowMs), false,
    "records created before the content script started are never auto-captured");
  assert.equal(jimeng.isFreshGeneration(null, nowMs), false,
    "records without a parseable timestamp fail closed to baseline");
});

test("jimeng extractor reads the live get_asset_list shape (created_time, common_attr.prompt, nested model_config)", () => {
  // Key layout observed on jimeng.jianying.com /mweb/v1/get_asset_list on
  // 2026-10-23; every value here is made up.
  const nowMs = Date.parse("2026-10-23T10:00:00Z");
  const sign = "?lk3s=fake&x-expires=1&x-signature=fake";
  const response = {
    ret: "0",
    data: {
      has_more: false,
      asset_list: [{
        id: "a1",
        type: 1,
        image: {
          history_record_id: "8100000000000000001",
          created_time: Math.floor(nowMs / 1000) + 30,
          item_list: [{
            common_attr: {
              id: "8100000000000000011",
              prompt: "红色背景上的金属数字 77",
              create_time: Math.floor(nowMs / 1000) + 30,
              cover_url: `https://p26-dreamina-sign.byteimg.com/tos-cn-i-fake/abc~tplv-fake-aigc_resize:640:640.jpeg${sign}`,
            },
            image: {
              format: "png",
              large_images: [{
                image_url: `https://p26-dreamina-sign.byteimg.com/tos-cn-i-fake/abc~tplv-fake-aigc_resize:2400:2400.webp${sign}`,
                width: 816,
                height: 1456,
              }],
            },
            aigc_image_params: {
              text2image_params: { model_config: { model_name: "图片 4.0" } },
            },
          }],
        },
      }],
    },
  };
  const { records } = jimeng.extractJimengResponse(JSON.stringify(response));
  assert.equal(records.length, 1);
  const [record] = records;
  assert.match(record.image.url, /aigc_resize:2400:2400/);
  assert.equal(record.prompt, "红色背景上的金属数字 77");
  assert.equal(record.model, "图片 4.0");
  assert.equal(record.historyId, "8100000000000000001");
  assert.ok(record.capturedAtMs, "created_time feeds the freshness gate");
  assert.equal(jimeng.isFreshGeneration(record.capturedAtMs, nowMs), true, "a record created after the script started is captured");
});

test("jimeng original images (aigc_resize:0:0.png) take their size from the response and win", () => {
  // get_history_by_ids on 2026-10-23 answered a fresh 9:16 generation with a
  // single large image at aigc_resize:0:0.png and width 1440 / height 2560.
  const nowMs = Date.parse("2026-10-23T18:24:00Z");
  const sign = "?lk3s=fake&x-expires=1&x-signature=fake";
  const response = {
    ret: "0",
    data: {
      "ce68fe50-0000-4000-8000-000000000000": {
        history_record_id: "8200000000000000001",
        created_time: Math.floor(nowMs / 1000) + 5,
        status: 50,
        item_list: [{
          common_attr: {
            id: "8200000000000000011",
            prompt: "一只橘猫趴在窗台上晒太阳",
            create_time: Math.floor(nowMs / 1000) + 5,
            cover_url: `https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/cat~tplv-fake-aigc_resize:640:640.jpeg${sign}`,
          },
          image: {
            large_images: [{
              image_url: `https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/cat~tplv-fake-aigc_resize:0:0.png${sign}`,
              width: 1440,
              height: 2560,
            }],
          },
        }],
      },
    },
  };
  const { records } = jimeng.extractJimengResponse(JSON.stringify(response));
  assert.equal(records.length, 1);
  const [record] = records;
  assert.match(record.image.url, /aigc_resize:0:0\.png/, "the full-size original is chosen");
  assert.equal(record.image.width, 1440);
  assert.equal(record.image.height, 2560);
  assert.equal(record.historyId, "8200000000000000001");
  assert.equal(jimeng.isFreshGeneration(record.capturedAtMs, nowMs), true);
});

test("jimeng media URL gate accepts only the ByteDance media hosts", () => {
  const info = jimeng.mediaUrlInfo("https://p3-dreamina-sign.byteimg.com/tos-cn-i-fake/key-CCCC~tplv-fake-aigc_resize:720:1280.webp?x-signature=fake");
  assert.equal(info.kind, "image");
  assert.equal(info.width, 720);
  assert.equal(info.height, 1280);
  assert.equal(info.resourceId, "key-CCCC");
  const bare = jimeng.mediaUrlInfo("https://p9-static-sign.byteimg.com/tos-cn-i-fake/key.webp");
  assert.equal(bare.kind, "image");
  assert.equal(bare.resourceId, "", "URLs without a ~tplv resource id carry no dedup identity");
  assert.equal(jimeng.mediaUrlInfo("https://evil.example/tos-cn-i-fake/key-DDDD~tplv-fake-aigc_resize:360:360.webp"), null);
  assert.equal(jimeng.mediaUrlInfo("http://p3-dreamina-sign.byteimg.com/key~tplv.webp"), null, "http is refused");
  const video = jimeng.mediaUrlInfo("https://v26-web.jimeng.com/fake/video.mp4?fake");
  assert.equal(video.kind, "video");
  const vlab = jimeng.mediaUrlInfo("https://v3-default.vlabvod.com/fake/abc.mp4");
  assert.equal(vlab.kind, "video");
});

test("jimeng page hook observes /mweb/v1/ responses read-only through a one-shot port", async () => {
  const hookMessages = [];
  const seenFetchCalls = [];
  const originalFetch = async (input, init) => {
    seenFetchCalls.push({ input, init });
    return {
      url: String(typeof input === "string" ? input : input?.url || ""),
      clone() {
        return {
          text: async () => JSON.stringify({ ret: 0, data: { ok: 1 } }),
        };
      },
    };
  };
  const portMessages = [];
  const sandbox = {
    URL,
    location: { origin: "https://jimeng.jianying.com", href: "https://jimeng.jianying.com/ai-tool/generate?type=image" },
    fetch: originalFetch,
    XMLHttpRequest: function FakeXHR() {
      this.open = () => {};
      this.send = () => {};
      this.addEventListener = () => {};
    },
    MessageChannel: function FakeChannel() {
      this.port1 = {
        postMessage: (message) => portMessages.push(message),
        addEventListener: () => {},
        start: () => {},
      };
      this.port2 = {};
    },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.postMessage = (message, origin, transfer) => {
    hookMessages.push({ message, origin, transfer });
  };
  vm.runInNewContext(jimengHookSource, sandbox, { filename: "jimeng-page-hook.js" });

  const requestInit = { method: "POST", credentials: "include" };
  await sandbox.window.fetch("https://jimeng.jianying.com/mweb/v1/get_history_by_ids", requestInit);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seenFetchCalls.length, 1);
  assert.equal(seenFetchCalls[0].init, requestInit, "the hook must not modify or re-issue the page request");
  assert.equal(portMessages.length, 1);
  assert.equal(portMessages[0].type, "jimeng-api-response");
  assert.equal(portMessages[0].url, "https://jimeng.jianying.com/mweb/v1/get_history_by_ids");

  portMessages.length = 0;
  await sandbox.window.fetch("https://jimeng.jianying.com/mweb/v2/other", requestInit);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(portMessages.length, 0, "non-/mweb/v1 responses are not observed");

  // The port was offered exactly once via a transient window message.
  assert.equal(hookMessages.length, 1);
  assert.equal(hookMessages[0].message.source, "mosa-jimeng-hook");
  assert.equal(hookMessages[0].origin, "https://jimeng.jianying.com");
  assert.equal(Array.isArray(hookMessages[0].transfer) && hookMessages[0].transfer.length, 1);
});

test("midjourney URL parser derives the full-size original and job identity", () => {
  const preview = midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/0_2_640_960.webp?method=shortest");
  assert.equal(preview.kind, "image");
  assert.equal(preview.jobId, "2c0ab4d1e5f64789abcd1234ef567890");
  assert.equal(preview.index, 2);
  assert.equal(preview.isPreview, true);
  assert.equal(preview.originalUrl, "https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/0_2.png");
  assert.equal(midjourney.midjourneyAssetIdentity(preview), "2c0ab4d1e5f64789abcd1234ef567890:2");

  const upscale = midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/0_1.png");
  assert.equal(upscale.isPreview, false);
  assert.equal(upscale.originalUrl, "https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/0_1.png");

  const video = midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/0_0.mp4");
  assert.equal(video.kind, "video");
  assert.equal(midjourney.midjourneyAssetIdentity(video), "2c0ab4d1e5f64789abcd1234ef567890:0");

  assert.equal(midjourney.parseMidjourneyMediaUrl("https://evil.example/2c0ab4d1e5f64789abcd1234ef567890/0_0_640_640.webp"), null);
  assert.equal(midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/not-a-job/0_0_640_640.webp"), null);
  assert.equal(midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/2c0ab4d1e5f64789abcd1234ef567890/logo.svg"), null);
});

test("midjourney URL parser accepts the live-site format (UUID job ids, 0_<n>_640_N previews)", () => {
  // Shape observed on www.midjourney.com/imagine on 2026-10-23 (job id is a
  // made-up UUID; only the format matters).
  const live = midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3_640_N.webp?method=shortest");
  assert.ok(live, "a live preview URL parses");
  assert.equal(live.jobId, "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d");
  assert.equal(live.index, 3);
  assert.equal(live.isPreview, true);
  assert.equal(live.originalUrl, "https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3.png");
  assert.equal(midjourney.midjourneyAssetIdentity(live), "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d:3");
  const original = midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3.png");
  assert.equal(original.isPreview, false);
  assert.equal(midjourney.parseMidjourneyMediaUrl("https://cdn.midjourney.com/1b2c3d4e-5f60/0_0_640_N.webp"), null, "a truncated id is rejected");
});

test("background re-derives the original from a live-format preview URL", async () => {
  const harness = await createBackgroundHarness();
  const fetched = [];
  harness.fetchHarness.setMediaHandler((url, init) => {
    fetched.push({ url: String(url), init });
    return new Response(new Uint8Array(256), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  });

  const preview = "https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3_640_N.webp";
  const result = await harness.context.fetchMidjourneyOriginal(preview);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, "https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3.png");
  assert.equal(fetched[0].init.credentials, "include");
  assert.equal(fetched[0].init.cache, "no-cache");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.finalUrl, "https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3.png");

  // Invalid preview URLs reject
  await assert.rejects(harness.context.fetchMidjourneyOriginal("https://not-midjourney.com/1b2c3d4e/0_0.png"), /Unsupported Midjourney preview URL/);
  await assert.rejects(harness.context.fetchMidjourneyOriginal("https://cdn.midjourney.com/invalid-uuid/0_0.png"), /Unsupported Midjourney preview URL/);
  await assert.rejects(harness.context.fetchMidjourneyOriginal("https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/not-a-preview.png"), /Unsupported Midjourney preview URL/);
});

test("midjourney baseline rules separate lazy history from fresh generations", () => {
  const now = 1_000_000;
  assert.equal(midjourney.isScrollBaselineInsertion(now, now - 500), true, "insertion right after a scroll is history");
  assert.equal(midjourney.isScrollBaselineInsertion(now, now - 5_000), false, "a card appearing well after scrolling is fresh");
  assert.equal(midjourney.isScrollBaselineInsertion(now, -Infinity), false);
  assert.equal(midjourney.isBatchBaselineInsertion(1), false, "one new job card is a fresh generation");
  assert.equal(midjourney.isBatchBaselineInsertion(2), false, "an upscale pair is still a fresh generation");
  assert.equal(midjourney.isBatchBaselineInsertion(4), true, "a page of lazy-loaded history is baseline");
  assert.match(providerMidjourneySource, /firstScanDone/, "the first scan baselines whatever the page already shows");
});

test("background gates the new providers and downloads Midjourney originals with cookies", async () => {
  const harness = await createBackgroundHarness({ appOnline: true });
  await harness.triggerInstalled({ reason: "install" });

  // 1. Context menus cover jimeng and midjourney patterns, including save-video.
  const saveImage = harness.createdContextMenus.find((menu) => menu.id === "mosa-save-image");
  const saveVideo = harness.createdContextMenus.find((menu) => menu.id === "mosa-save-video");
  assert.ok(saveImage && saveVideo);
  assert.deepEqual(JSON.parse(JSON.stringify(saveVideo.contexts)), ["video"]);
  for (const pattern of ["https://jimeng.jianying.com/*", "https://www.midjourney.com/*"]) {
    assert.ok(saveImage.documentUrlPatterns.includes(pattern), `save-image menu covers ${pattern}`);
    assert.ok(saveVideo.documentUrlPatterns.includes(pattern), `save-video menu covers ${pattern}`);
  }

  // 2. Fetch original via message dispatch: only midjourney provider is allowed.
  harness.fetchHarness.setMediaHandler(() => {
    return new Response(new Uint8Array(256), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  });

  const preview = "https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3_640_N.webp";
  const midjourneySender = senderFor(MIDJOURNEY_TAB_URL);
  const mjResponse = await harness.dispatchMessage({ type: "mosa.fetchMidjourneyOriginal", previewUrl: preview }, midjourneySender);
  assert.equal(mjResponse.ok, true);
  assert.equal(mjResponse.finalUrl, "https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3.png");

  // Non-midjourney tab cannot call mosa.fetchMidjourneyOriginal
  const chatgptSender = senderFor(CHATGPT_TAB_URL);
  const chatgptResponse = await harness.dispatchMessage({ type: "mosa.fetchMidjourneyOriginal", previewUrl: preview }, chatgptSender);
  assert.equal(chatgptResponse.ok, false);
  assert.equal(chatgptResponse.error, "GravityPort rejected a message from an unsupported sender.");

  // 3. Provider gating: jimeng and midjourney images with media_variant pass to ingest route.
  let ingestPayload = null;
  harness.fetchHarness.setAppHandler((url, init) => {
    if (url.pathname === "/api/ingest/web-capture") {
      ingestPayload = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, assetId: "asset-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return null;
  });

  const jimengSender = senderFor(JIMENG_TAB_URL);
  const jimengCapture = await harness.dispatchMessage({
    type: "mosa.ingest",
    payload: {
      provider: "jimeng",
      mediaKind: "image",
      imageBase64: fakeImageBase64(128),
      mediaVariant: "upscale",
    },
  }, jimengSender);
  assert.equal(jimengCapture.ok, true);
  assert.equal(ingestPayload.provider, "jimeng");
  assert.equal(ingestPayload.media_variant, "upscale");

  // 4. Remote media allowed domains check in assertAllowedRemoteMediaUrl
  for (const trusted of [
    "https://cdn.midjourney.com/1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d/0_3.png",
    "https://p16-va.byteimg.com/tos-maliva-p/image.png",
    "https://sf16-sg.jimeng.com/image.png",
    "https://v2.vlabvod.com/video.mp4",
  ]) {
    assert.doesNotThrow(() => harness.context.assertAllowedRemoteMediaUrl(trusted));
  }
  assert.throws(() => harness.context.assertAllowedRemoteMediaUrl("https://evil.com/leak.png"), /Unsupported media host/);
});

async function noiseImage(seed, width = 640, height = 900) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * (31 + seed) + (i % 249)) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

test("app ingest accepts jimeng and midjourney images with sourceType and media variant", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-jm-mj-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const created = [];
  const store = {
    createAsset: async (input) => {
      const asset = { id: input.assetId, project_id: "default", ...input, source: { ...input.source } };
      created.push(asset);
      return asset;
    },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };

  const jimengResult = await ingestWebCapture({
    store,
    tempRoot: join(root, "jimeng"),
    input: {
      provider: "jimeng",
      imageBytes: await noiseImage(7),
      mimeType: "image/jpeg",
      prompt: "海边小镇的黄昏，胶片感",
      prompt_status: "provider-visible-prompt",
      prompt_source: "jimeng-visible-prompt",
      conversationId: "7468000000000000001",
      providerAssetId: "7468000000000000011",
      model: "图片 2.1",
      pageUrl: "https://jimeng.jianying.com/ai-tool/generate?type=image",
    },
  });
  assert.equal(jimengResult.status, "imported");
  assert.equal(jimengResult.asset.sourceType, "web-jimeng");
  assert.equal(jimengResult.asset.source.provider, "jimeng");
  assert.equal(jimengResult.asset.prompt, "海边小镇的黄昏，胶片感");
  assert.equal(jimengResult.asset.source.prompt_status, "provider-visible-prompt");
  assert.equal(jimengResult.asset.source.model, "图片 2.1");
  assert.match(jimengResult.asset.assetId, /^web-jimeng-[a-f0-9]{12}$/);
  assert.deepEqual(jimengResult.asset.tags, ["jimeng", "web-capture", "auto-archived"]);

  const mjResult = await ingestWebCapture({
    store,
    tempRoot: join(root, "midjourney"),
    input: {
      provider: "midjourney",
      imageBytes: await noiseImage(13),
      mimeType: "image/jpeg",
      prompt: "a lighthouse in a storm --ar 2:3 --v 7",
      prompt_status: "provider-visible-prompt",
      prompt_source: "midjourney-visible-prompt",
      conversationId: "2c0ab4d1e5f64789abcd1234ef567890",
      providerAssetId: "2c0ab4d1e5f64789abcd1234ef567890:2",
      mediaVariant: "preview",
    },
  });
  assert.equal(mjResult.status, "imported");
  assert.equal(mjResult.asset.sourceType, "web-midjourney");
  assert.equal(mjResult.asset.source.media_variant, "preview", "a preview-only Midjourney capture is marked in the source record");
  assert.equal(jimengResult.asset.source.media_variant, "", "an unset variant stays empty");

  // An untrusted provider-visible prompt for a legacy provider is still dropped.
  const droppedPrompt = await ingestWebCapture({
    store,
    tempRoot: join(root, "jimeng-untrusted"),
    input: {
      provider: "jimeng",
      imageBytes: await noiseImage(21),
      mimeType: "image/jpeg",
      prompt: "should not be trusted",
      prompt_status: "user-message",
    },
  });
  assert.equal(droppedPrompt.asset.prompt, "");
});

test("app ingest accepts jimeng and midjourney videos", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-jm-mj-video-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sampleMp4 = (() => {
    const bytes = Buffer.alloc(96 * 1024, 0);
    bytes.writeUInt32BE(24, 0);
    bytes.write("ftyp", 4, "ascii");
    bytes.write("isom", 8, "ascii");
    return bytes;
  })();
  const created = [];
  const store = {
    createAsset: async (input) => {
      const asset = { id: input.assetId, project_id: "default", ...input, source: { ...input.source } };
      created.push(asset);
      return asset;
    },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };
  const result = await ingestWebCapture({
    store,
    tempRoot: join(root, "jimeng"),
    input: {
      provider: "jimeng",
      mediaKind: "video",
      mediaBytes: sampleMp4,
      mimeType: "video/mp4",
      durationSeconds: 5.4,
      width: 1080,
      height: 1920,
      conversationId: "7468000000000000001",
      providerAssetId: "7468000000000000012",
    },
  });
  assert.equal(result.status, "imported");
  assert.equal(result.asset.sourceType, "web-jimeng");
  assert.equal(result.asset.source.media_kind, "video");
  assert.equal(result.asset.business_fields.duration_seconds, 5.4);
  assert.match(result.asset.assetId, /^web-jimeng-video-[a-f0-9]{12}$/);

  const mjVideo = await ingestWebCapture({
    store,
    tempRoot: join(root, "midjourney"),
    input: {
      provider: "midjourney",
      mediaKind: "video",
      mediaBytes: sampleMp4,
      mimeType: "video/mp4",
      conversationId: "2c0ab4d1e5f64789abcd1234ef567890",
      providerAssetId: "2c0ab4d1e5f64789abcd1234ef567890:0",
      mediaVariant: "original",
    },
  });
  assert.equal(mjVideo.status, "imported");
  assert.equal(mjVideo.asset.sourceType, "web-midjourney");
  assert.equal(mjVideo.asset.source.media_variant, "original");
});

test("generation sessions group by jimeng record and midjourney job id", () => {
  assert.equal(
    generationSessionKey({ source: { type: "web-jimeng", conversation_id: "7468000000000000001" } }),
    "web-jimeng:7468000000000000001",
  );
  assert.equal(
    generationSessionKey({ source: { type: "web-midjourney", conversation_id: "2c0ab4d1e5f64789abcd1234ef567890" } }),
    "web-midjourney:2c0ab4d1e5f64789abcd1234ef567890",
  );
  assert.equal(generationSessionKey({ source: { type: "web-midjourney" } }), "");
  assert.equal(sourceSearchDisplayName("web-jimeng"), "即梦");
  assert.equal(sourceSearchDisplayName("web-midjourney"), "Midjourney");
});

// ---- Review 294: page hand-off rules and the Midjourney batch fix, run in a vm
// with a controllable clock. Timers and Date share one fake clock, so a test can
// move minutes forward without waiting.

const providerPageStartMs = 1_700_000_000_000;

async function flushPageMicrotasks() {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fakePageClock(startMs = providerPageStartMs) {
  const timers = [];
  let nextId = 1;
  const clock = { now: startMs, timers };
  const add = (fn, ms, repeat) => {
    const delay = Math.max(0, Number(ms) || 0);
    timers.push({ id: nextId, at: clock.now + delay, delay, repeat, fn, cancelled: false });
    nextId += 1;
    return nextId - 1;
  };
  const cancel = (id) => {
    const timer = timers.find((candidate) => candidate.id === id);
    if (timer) timer.cancelled = true;
  };
  clock.setTimeout = (fn, ms) => add(fn, ms, false);
  clock.setInterval = (fn, ms) => add(fn, ms, true);
  clock.clearTimeout = cancel;
  clock.clearInterval = cancel;
  clock.advance = async (ms) => {
    // Settle the page's startup promises (settings, watchdog) before any timer
    // runs, as a real page would have done before the user scrolls.
    await flushPageMicrotasks();
    const target = clock.now + ms;
    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock.now = Math.max(clock.now, due.at);
      if (due.repeat) due.at += Math.max(1, due.delay);
      else due.cancelled = true;
      due.fn();
      await flushPageMicrotasks();
    }
    clock.now = target;
    await flushPageMicrotasks();
  };
  return clock;
}

function fakeClockDate(clock) {
  return class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock.now);
    }

    static now() {
      return clock.now;
    }
  };
}

function midjourneyPage({ respond }) {
  const clock = fakePageClock();
  const images = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  class FakeImage {
    constructor(src) {
      this.currentSrc = src;
      this.src = src;
      this.complete = true;
      this.naturalWidth = 1024;
      this.naturalHeight = 1024;
      this.width = 512;
      this.height = 512;
      this.parentElement = null;
    }

    getBoundingClientRect() {
      return { top: 0, left: 0, right: 512, bottom: 512, width: 512, height: 512 };
    }

    getAttribute() { return ""; }
  }
  const sent = [];
  const document = {
    images,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: (type, fn) => { documentListeners.set(type, [...(documentListeners.get(type) || []), fn]); },
    documentElement: {},
    body: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {} }),
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      sendMessage: (message) => {
        sent.push(message);
        return Promise.resolve(respond(message));
      },
      onMessage: { addListener() {} },
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
  };
  const sandbox = {
    URL,
    Date: fakeClockDate(clock),
    Blob,
    Promise,
    chrome,
    document,
    location: { href: "https://www.midjourney.com/imagine", origin: "https://www.midjourney.com" },
    HTMLImageElement: FakeImage,
    HTMLVideoElement: class FakeVideo {},
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    innerWidth: 1280,
    innerHeight: 900,
    console: { info() {}, log() {}, warn() {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInContext(providerMidjourneySource, sandbox, { filename: "provider-midjourney.js" });
  return {
    clock,
    images,
    sent,
    ingests: () => sent.filter((message) => message.type === "mosa.ingest"),
    fireDocument: (type) => { for (const fn of documentListeners.get(type) || []) fn({}); },
    fireWindow: (type) => { for (const fn of windowListeners.get(type) || []) fn({}); },
    sandbox,
  };
}

function midjourneyJobId(index) {
  return `0${String(index).padStart(7, "0")}-1111-4222-8333-${String(index).padStart(12, "0")}`;
}

function addMidjourneyJob(page, jobId, count = 4) {
  for (let index = 0; index < count; index += 1) {
    page.images.push(new page.sandbox.HTMLImageElement(`https://cdn.midjourney.com/${jobId}/0_${index}_640_N.webp?method=shortest`));
  }
  page.fireDocument("load");
}

const midjourneyAutoSettings = (message) => (message.type === "mosa.getSettings"
  ? { ok: true, settings: { autoCapture: true } }
  : null);

test("Midjourney: six works in a row, each with its earlier works still on screen, are all captured", async () => {
  const page = midjourneyPage({
    respond: (message) => midjourneyAutoSettings(message)
      || (message.type === "mosa.fetchMidjourneyOriginal" ? { ok: false, error: "blocked" } : { ok: true, result: { status: "imported" } }),
  });
  await page.clock.advance(9_000);
  for (let index = 1; index <= 6; index += 1) {
    addMidjourneyJob(page, midjourneyJobId(index));
    await page.clock.advance(400);
  }
  const jobs = new Set(page.ingests().map((message) => message.payload.providerAssetId.split(":")[0]));
  assert.equal(jobs.size, 6, "every one of the six works is sent to GravityPort");
  assert.equal(page.ingests().length, 24, "four images per work, once each");
});

test("Midjourney: three never-seen works appearing in one tick are history and are not captured", async () => {
  const page = midjourneyPage({
    respond: (message) => midjourneyAutoSettings(message)
      || (message.type === "mosa.fetchMidjourneyOriginal" ? { ok: false, error: "blocked" } : { ok: true, result: { status: "imported" } }),
  });
  await page.clock.advance(9_000);
  for (let index = 1; index <= 3; index += 1) addMidjourneyJob(page, midjourneyJobId(index));
  await page.clock.advance(400);
  assert.equal(page.ingests().length, 0, "a batch of three new works is history");
});

test("Midjourney: a work that appears within 1.2 s of scrolling is history; a later one is captured", async () => {
  const page = midjourneyPage({
    respond: (message) => midjourneyAutoSettings(message)
      || (message.type === "mosa.fetchMidjourneyOriginal" ? { ok: false, error: "blocked" } : { ok: true, result: { status: "imported" } }),
  });
  await page.clock.advance(9_000);
  page.fireWindow("scroll");
  page.fireDocument("scroll");
  addMidjourneyJob(page, midjourneyJobId(1));
  await page.clock.advance(400);
  assert.equal(page.ingests().length, 0, "right after a scroll the new work is history");

  await page.clock.advance(2_000);
  addMidjourneyJob(page, midjourneyJobId(2));
  await page.clock.advance(400);
  assert.equal(page.ingests().length, 4, "a work that appears after the scroll window is captured");
});

test("Midjourney: a queued answer keeps the key, so the work is not sent again", async () => {
  const page = midjourneyPage({
    respond: (message) => midjourneyAutoSettings(message)
      || (message.type === "mosa.fetchMidjourneyOriginal" ? { ok: false, error: "blocked" } : { ok: true, result: { status: "queued", reason: "mosa-unavailable" } }),
  });
  await page.clock.advance(9_000);
  addMidjourneyJob(page, midjourneyJobId(1));
  await page.clock.advance(400);
  assert.equal(page.ingests().length, 4);
  await page.clock.advance(180_000);
  assert.equal(page.ingests().length, 4, "three minutes later the queued work is still not re-sent");
});

test("Midjourney: a retryable failure is tried again twice, 60 s apart, then the key is kept", async () => {
  const page = midjourneyPage({
    respond: (message) => midjourneyAutoSettings(message)
      || (message.type === "mosa.fetchMidjourneyOriginal" ? { ok: false, error: "blocked" } : { ok: false, error: "GravityPort is closed", retryable: true }),
  });
  await page.clock.advance(9_000);
  addMidjourneyJob(page, midjourneyJobId(1));
  await page.clock.advance(400);
  assert.equal(page.ingests().length, 4, "first send of each of the four images");

  await page.clock.advance(70_000);
  assert.equal(page.ingests().length, 8, "first automatic retry, after 60 s");
  await page.clock.advance(70_000);
  assert.equal(page.ingests().length, 12, "second automatic retry, 60 s after the first");
  await page.clock.advance(600_000);
  assert.equal(page.ingests().length, 12, "no third automatic retry");
});

test("Midjourney: a refused answer (not retryable) is never sent again automatically", async () => {
  const page = midjourneyPage({
    respond: (message) => midjourneyAutoSettings(message)
      || (message.type === "mosa.fetchMidjourneyOriginal" ? { ok: false, error: "blocked" } : { ok: false, error: "bad image", retryable: false }),
  });
  await page.clock.advance(9_000);
  addMidjourneyJob(page, midjourneyJobId(1));
  await page.clock.advance(400);
  await page.clock.advance(600_000);
  assert.equal(page.ingests().length, 4, "a refusal keeps the key for the rest of the page's life");
});

test("Midjourney: the batch count skips works already captured in this page", () => {
  const seam = midjourney;
  const entry = (jobId) => ({ info: { jobId } });
  const baseline = new Set(["old-job"]);
  const handled = new Set(["job-1", "job-2"]);
  const entries = [entry("job-1"), entry("job-1"), entry("job-2"), entry("job-3"), entry("old-job")];
  const ids = seam.newJobIdsForBatch(entries, baseline, handled);
  assert.deepEqual([...ids], ["job-3"], "only the genuinely new work counts toward a batch");
  assert.equal(seam.isBatchBaselineInsertion(ids.size), false);
});

function jimengPage({ respond }) {
  const clock = fakePageClock();
  const hookListeners = [];
  const portListeners = [];
  const sent = [];
  const window = {
    addEventListener: (type, fn) => { if (type === "message") hookListeners.push(fn); },
    postMessage: () => {},
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      sendMessage: (message) => {
        sent.push(message);
        return Promise.resolve(respond(message));
      },
      onMessage: { addListener() {} },
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
  };
  const sandbox = {
    URL,
    Date: fakeClockDate(clock),
    Blob,
    Promise,
    chrome,
    window,
    location: { href: "https://jimeng.jianying.com/ai-tool/generate", origin: "https://jimeng.jianying.com" },
    document: {
      images: [],
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener() {},
      documentElement: {},
      body: { appendChild() {} },
      createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {} }),
    },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    innerWidth: 1280,
    innerHeight: 900,
    console: { info() {}, log() {}, warn() {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInContext(providerJimengSource, sandbox, { filename: "provider-jimeng.js" });
  return {
    clock,
    sent,
    ingests: (mediaKind) => sent.filter((message) => message.type === "mosa.ingest"
      && message.payload?.mediaKind === mediaKind),
    // Hands the page the hook's message port, then a Jimeng API response text.
    deliverResponse: (text) => {
      const port = {
        listeners: [],
        addEventListener(type, fn) { if (type === "message") this.listeners.push(fn); },
        start() {},
      };
      for (const listener of hookListeners) {
        listener({ origin: "https://jimeng.jianying.com", data: { source: "mosa-jimeng-hook", type: "hook-port" }, ports: [port] });
      }
      for (const listener of port.listeners) listener({ data: { type: "jimeng-api-response", text } });
      portListeners.push(port);
    },
  };
}

test("Jimeng: a queued image is not sent again, even minutes later", async () => {
  const page = jimengPage({
    respond: (message) => (message.type === "mosa.getSettings" ? { ok: true, settings: { autoCapture: true } }
      : { ok: true, result: { status: "queued", reason: "mosa-unavailable" } }),
  });
  await page.clock.advance(1_000);
  page.deliverResponse(JSON.stringify(jimengPollFixture(page.clock.now)));
  await page.clock.advance(400);
  const first = page.ingests("image").length;
  assert.ok(first >= 1, "the fresh Jimeng image is sent once");
  await page.clock.advance(180_000);
  assert.equal(page.ingests("image").length, first, "a queued image is not re-sent by the page");
});

test("Jimeng: late agent instruction upgrades a previously auto-captured identity once", async () => {
  const page = jimengPage({
    respond: (message) => message.type === "mosa.getSettings"
      ? { ok: true, settings: { autoCapture: true } } : { ok: true },
  });
  await page.clock.advance(1_000);
  const early = jimengAgentSample();
  const earlySession = early.data.asset_list[0].agent_conversation_session;
  earlySession.conversation_session.mapping = {};
  earlySession.submit_id_data_map["submit-1"].created_time = Math.floor(page.clock.now / 1000);
  page.deliverResponse(JSON.stringify(early));
  await page.clock.advance(400);
  assert.equal(page.ingests("image").length, 1);
  assert.equal(page.ingests("image")[0].payload.userMessage, undefined);

  const late = jimengAgentSample();
  late.data.asset_list[0].agent_conversation_session.submit_id_data_map["submit-1"].created_time =
    Math.floor(page.clock.now / 1000);
  page.deliverResponse(JSON.stringify(late));
  await page.clock.advance(400);
  let upgrades = page.sent.filter((message) => message.type === "mosa.upgradeMetadata");
  assert.equal(upgrades.length, 1);
  assert.equal(upgrades[0].payload.prompt, "");
  assert.match(upgrades[0].payload.userMessage, /^A bold graphic poster/);
  assert.equal(upgrades[0].payload.providerAssetId, "8200000000000000011");
  assert.equal(upgrades[0].payload.generationContextId, "8200000000000000001");
  page.deliverResponse(JSON.stringify(late));
  await page.clock.advance(400);
  upgrades = page.sent.filter((message) => message.type === "mosa.upgradeMetadata");
  assert.equal(upgrades.length, 1);
  assert.equal(page.ingests("image").length, 1);
});

test("Jimeng: a retryable failure is retried twice, 60 s apart, and no more", async () => {
  const page = jimengPage({
    respond: (message) => (message.type === "mosa.getSettings" ? { ok: true, settings: { autoCapture: true } }
      : { ok: false, error: "GravityPort is closed", retryable: true }),
  });
  await page.clock.advance(1_000);
  page.deliverResponse(JSON.stringify(jimengPollFixture(page.clock.now)));
  await page.clock.advance(400);
  const first = page.ingests("image").length;
  assert.ok(first >= 1);
  await page.clock.advance(70_000);
  assert.equal(page.ingests("image").length, first * 2, "one automatic retry after 60 s");
  await page.clock.advance(70_000);
  assert.equal(page.ingests("image").length, first * 3, "a second automatic retry 60 s later");
  await page.clock.advance(600_000);
  assert.equal(page.ingests("image").length, first * 3, "then the key is kept");
});

const providerSitesSource = await readFile(new URL("provider-sites.js", extensionRoot), "utf8");

function geminiPage({ respond }) {
  const clock = fakePageClock();
  const sent = [];
  const images = [];
  const modelResponse = { tagName: "MODEL-RESPONSE", parentElement: null };
  class FakeImage {
    constructor(src) {
      this.currentSrc = src;
      this.src = src;
      this.complete = true;
      this.naturalWidth = 1024;
      this.naturalHeight = 1024;
      this.width = 512;
      this.height = 512;
      this.tagName = "IMG";
      this.parentElement = modelResponse;
    }

    getBoundingClientRect() {
      return { top: 0, left: 0, right: 512, bottom: 512, width: 512, height: 512 };
    }

    getAttribute() { return ""; }
  }
  const document = {
    images,
    documentElement: { tagName: "HTML", parentElement: null },
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    body: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {} }),
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      sendMessage: (message) => {
        sent.push(message);
        return Promise.resolve(respond(message));
      },
      onMessage: { addListener() {} },
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
  };
  const sandbox = {
    URL,
    Date: fakeClockDate(clock),
    Blob,
    Promise,
    chrome,
    document,
    location: { href: "https://gemini.google.com/app/conv1", origin: "https://gemini.google.com", hostname: "gemini.google.com" },
    HTMLImageElement: FakeImage,
    HTMLVideoElement: class FakeVideo {},
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    innerWidth: 1280,
    innerHeight: 900,
    console: { info() {}, log() {}, warn() {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(providerPolicySource, sandbox, { filename: "provider-policy.js" });
  vm.runInContext(providerSitesSource, sandbox, { filename: "provider-sites.js" });
  return {
    clock,
    sent,
    images,
    ingests: () => sent.filter((message) => message.type === "mosa.ingest"),
    addImage: (src) => images.push(new FakeImage(src)),
  };
}

const geminiFigureUrl = "https://lh3.googleusercontent.com/gemini-figure-one";

test("Google (Gemini): a queued image is not sent again, even minutes later", async () => {
  const page = geminiPage({
    respond: (message) => (message.type === "mosa.getSettings" ? { ok: true, settings: { autoCapture: true } }
      : { ok: true, result: { status: "queued", reason: "mosa-unavailable" } }),
  });
  await page.clock.advance(1_000);
  page.addImage(geminiFigureUrl);
  await page.clock.advance(5_000);
  assert.equal(page.ingests().length, 1, "the visible image is sent once");
  await page.clock.advance(180_000);
  assert.equal(page.ingests().length, 1, "a queued image is not re-sent by the page");
});

test("Google (Gemini): a retryable failure is retried twice, 60 s apart, and no more", async () => {
  const page = geminiPage({
    respond: (message) => (message.type === "mosa.getSettings" ? { ok: true, settings: { autoCapture: true } }
      : { ok: false, error: "GravityPort is closed", retryable: true }),
  });
  await page.clock.advance(1_000);
  page.addImage(geminiFigureUrl);
  await page.clock.advance(5_000);
  assert.equal(page.ingests().length, 1);
  await page.clock.advance(70_000);
  assert.equal(page.ingests().length, 2, "one automatic retry after 60 s");
  await page.clock.advance(70_000);
  assert.equal(page.ingests().length, 3, "a second automatic retry 60 s later");
  await page.clock.advance(600_000);
  assert.equal(page.ingests().length, 3, "then the key is kept");
});

test("Google (Gemini): a refused answer is never retried automatically", async () => {
  const page = geminiPage({
    respond: (message) => (message.type === "mosa.getSettings" ? { ok: true, settings: { autoCapture: true } }
      : { ok: false, error: "bad image", retryable: false }),
  });
  await page.clock.advance(1_000);
  page.addImage(geminiFigureUrl);
  await page.clock.advance(5_000);
  await page.clock.advance(600_000);
  assert.equal(page.ingests().length, 1);
});
