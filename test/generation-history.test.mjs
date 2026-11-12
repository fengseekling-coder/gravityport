import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { pngBytes } from "./helpers/managed-media.mjs";
import { normalizeGenerationEvent, resolveGenerationRelationCandidates } from "../lib/generation-history.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

test("GPT relation resolver proposes lineage without turning proximity into fact", () => {
  const events = [
    {
      id: "gen-a",
      output_asset_id: "asset-a",
      provider: "chatgpt",
      provider_asset_id: "file-a",
      conversation_id: "conversation-a",
      message_id: "message-a",
      effective_prompt: "create a product poster",
      created_at: "2026-08-27T10:00:00.000Z",
    },
    {
      id: "gen-b",
      output_asset_id: "asset-b",
      provider: "chatgpt",
      conversation_id: "conversation-a",
      message_id: "message-b",
      effective_prompt: "生成一个蓝色汽车海报",
      created_at: "2026-08-27T10:05:00.000Z",
    },
    {
      id: "gen-c",
      output_asset_id: "asset-c",
      provider: "chatgpt",
      conversation_id: "conversation-a",
      message_id: "message-c",
      effective_prompt: "把背景换成黑色，其他保持不变",
      created_at: "2026-08-27T10:10:00.000Z",
    },
    {
      id: "gen-d",
      output_asset_id: "asset-d",
      provider: "chatgpt",
      conversation_id: "conversation-b",
      message_id: "message-d",
      effective_prompt: "把背景换成白色",
      created_at: "2026-08-27T10:11:00.000Z",
    },
    {
      id: "gen-e",
      output_asset_id: "asset-e",
      provider: "chatgpt",
      conversation_id: "conversation-a",
      message_id: "message-e",
      effective_prompt: "参考这张图做一个横版",
      references: [{ provider_asset_id: "file-a" }],
      created_at: "2026-08-27T10:20:00.000Z",
    },
  ];

  const candidates = resolveGenerationRelationCandidates({
    projectId: "default",
    events,
    relations: [],
    candidates: [],
    now: "2026-08-27T10:21:00.000Z",
  });

  assert.equal(candidates.some((candidate) => candidate.child_generation_id === "gen-b"), false, "a nearby fresh generation is not treated as a version automatically");
  assert.ok(candidates.some((candidate) => (
    candidate.child_generation_id === "gen-c"
    && candidate.parent_generation_id === "gen-b"
    && candidate.suggested_relation_type === "edited_from"
    && candidate.verification_level === "inferred"
  )), "an edit-like follow-up becomes a candidate, not a relation");
  assert.equal(candidates.some((candidate) => candidate.child_generation_id === "gen-d"), false, "candidate parents never cross conversations");
  assert.ok(candidates.some((candidate) => (
    candidate.child_generation_id === "gen-e"
    && candidate.parent_generation_id === "gen-a"
    && candidate.suggested_relation_type === "edited_from"
    && candidate.evidence?.parent_provider_asset_id === "file-a"
  )), "an observed reused provider asset strengthens the correct parent candidate");

  const dismissed = resolveGenerationRelationCandidates({
    projectId: "default",
    events,
    relations: [],
    candidates: [{
      project_id: "default",
      child_generation_id: "gen-e",
      parent_generation_id: "gen-a",
      suggested_relation_type: "based_on",
      confidence: 0.9,
      verification_level: "inferred",
      status: "dismissed",
      created_at: "2026-08-27T10:20:30.000Z",
      updated_at: "2026-08-27T10:20:30.000Z",
    }],
    now: "2026-08-27T10:22:00.000Z",
  });
  assert.equal(dismissed.find((candidate) => candidate.child_generation_id === "gen-e" && candidate.parent_generation_id === "gen-a")?.status, "dismissed", "dismissed guesses are not resurrected by a later resolver pass");
});

for (const [name, createStore] of [
  ["JSON", (root) => createJsonAssetStore({ projectRoot: root, managerDir: join(root, "manager"), assetsRoot: join(root, "json-assets") })],
  ["SQLite", (root) => createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: join(root, "sqlite-library"), initializeFreshLibrary: true })],
]) {
  test(`${name} store keeps the captured prompt and model when a replay without them rewrites the event`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `mosa-generation-replay-${name.toLowerCase()}-`));
    deferTestPathRemoval(root, { recursive: true, force: true });
    let store;
    t.after(async () => {
      store?.close?.();
    });
    await mkdir(join(root, "input"), { recursive: true });
    const firstPath = join(root, "input", "replay-first.png");
    const secondPath = join(root, "input", "replay-second.png");
    await writeFile(firstPath, await pngBytes());
    await writeFile(secondPath, await pngBytes());

    store = createStore(root);
    await store.ensureProject("default");
    const liveAsset = await store.createAsset({ projectId: "default", assetId: "replay-live", imagePath: firstPath });
    const lateAsset = await store.createAsset({ projectId: "default", assetId: "replay-late", imagePath: secondPath });

    // 1. A live capture stores prompt, model, ids, references, and status.
    const live = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: liveAsset.id,
      id: "gen-replay-live",
      provider: "chatgpt",
      capture_context_id: "ctx-replay",
      provider_asset_id: "file-replay-live",
      conversation_id: "conv-replay",
      message_id: "msg-replay-live",
      turn_index: 3,
      batch_id: "batch-replay",
      model: "gpt-image-1",
      user_prompt: "画一只猫",
      effective_prompt: "a seated tabby cat, studio light",
      prompt_status: "visible-caption",
      prompt_scope: "output",
      generation_status: "completed",
      capture_channel: "chrome-extension",
      verification_level: "observed",
      references: [{ provider_asset_id: "ref-file-1" }],
      evidence: { source: "web-capture", note: "live capture" },
      created_at: "2026-10-08T10:00:00.000Z",
    });
    assert.equal(live.effective_prompt, "a seated tabby cat, studio light");
    assert.equal(live.model, "gpt-image-1");

    // 2. The same id replays without live data (reopened conversation page):
    // empty prompt/model/ids and not-available must not erase the stored values.
    const replay = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: liveAsset.id,
      id: "gen-replay-live",
      provider: "chatgpt",
      capture_context_id: "ctx-replay",
      conversation_id: "conv-replay",
      message_id: "",
      turn_index: null,
      batch_id: "",
      model: "",
      user_prompt: "",
      effective_prompt: "",
      prompt_status: "not-available",
      generation_status: "unknown",
      capture_channel: "",
      verification_level: "inferred",
      references: [],
      created_at: "2026-10-08T11:00:00.000Z",
    });
    assert.equal(replay.effective_prompt, "a seated tabby cat, studio light", "stored prompt survives an empty replay");
    assert.equal(replay.prompt_status, "visible-caption", "status follows the kept prompt, not the replay's not-available");
    assert.equal(replay.model, "gpt-image-1");
    assert.equal(replay.user_prompt, "画一只猫");
    assert.equal(replay.batch_id, "batch-replay");
    assert.equal(replay.message_id, "msg-replay-live");
    assert.equal(replay.turn_index, 3);
    assert.equal(replay.capture_channel, "chrome-extension");
    assert.equal(replay.verification_level, "observed", "a weaker verification claim cannot demote the stored one");
    assert.deepEqual(replay.references, [{ provider_asset_id: "ref-file-1" }], "an empty references replay keeps the stored ones");
    assert.deepEqual(replay.evidence, { source: "web-capture", note: "live capture" });
    assert.equal(replay.generation_status, "completed", "an unknown replay status keeps the stored execution status");
    const afterReplay = (await store.listGenerationEvents("default", { assetId: liveAsset.id })).find((event) => event.id === "gen-replay-live");
    assert.equal(afterReplay.effective_prompt, "a seated tabby cat, studio light", "the stored row (not just the return value) keeps the prompt");
    assert.equal(afterReplay.model, "gpt-image-1");
    assert.equal(afterReplay.prompt_status, "visible-caption");

    // 3. A replay that carries real values still wins over the stored ones.
    const refreshed = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: liveAsset.id,
      id: "gen-replay-live",
      provider: "chatgpt",
      capture_context_id: "ctx-replay",
      conversation_id: "conv-replay",
      model: "gpt-image-2",
      user_prompt: "画一只狗",
      effective_prompt: "a seated bulldog, studio light",
      prompt_status: "user-message",
      verification_level: "user_confirmed",
      references: [{ provider_asset_id: "ref-file-2" }],
      evidence: { source: "web-capture", note: "recovered from message" },
      created_at: "2026-10-08T12:00:00.000Z",
    });
    assert.equal(refreshed.effective_prompt, "a seated bulldog, studio light", "a non-empty new prompt replaces the stored one");
    assert.equal(refreshed.prompt_status, "user-message");
    assert.equal(refreshed.model, "gpt-image-2");
    assert.equal(refreshed.user_prompt, "画一只狗");
    assert.equal(refreshed.verification_level, "user_confirmed", "a stronger verification claim upgrades the record");
    assert.deepEqual(refreshed.references, [{ provider_asset_id: "ref-file-2" }]);
    assert.deepEqual(refreshed.evidence, { source: "web-capture", note: "recovered from message" });

    // 4. A record first captured without a prompt gains it on a later replay.
    await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: lateAsset.id,
      id: "gen-replay-late",
      provider: "chatgpt",
      conversation_id: "conv-replay",
      model: "gpt-image-1",
      effective_prompt: "",
      prompt_status: "not-available",
      created_at: "2026-10-08T13:00:00.000Z",
    });
    const filled = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: lateAsset.id,
      id: "gen-replay-late",
      provider: "chatgpt",
      conversation_id: "conv-replay",
      model: "",
      user_prompt: "晚到的指令",
      effective_prompt: "a late recovered prompt",
      prompt_status: "generation-tool-prompt",
      created_at: "2026-10-08T14:00:00.000Z",
    });
    assert.equal(filled.effective_prompt, "a late recovered prompt", "a later replay fills the missing prompt");
    assert.equal(filled.prompt_status, "generation-tool-prompt", "the status follows the recovered prompt");
    assert.equal(filled.model, "gpt-image-1", "the earlier model survives the fill-in replay");
    assert.equal(filled.user_prompt, "晚到的指令");

    // 5. The merge never manufactures "prompt present, status not-available",
    // even when a contradictory replay pairs a prompt with the negative status.
    const contradictory = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: lateAsset.id,
      id: "gen-replay-late",
      provider: "chatgpt",
      conversation_id: "conv-replay",
      effective_prompt: "a late recovered prompt",
      prompt_status: "not-available",
      created_at: "2026-10-08T15:00:00.000Z",
    });
    assert.notEqual(contradictory.prompt_status, "not-available", "a stored prompt is never downgraded to not-available");
    const replayedNoPromptEver = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: liveAsset.id,
      id: "gen-replay-live",
      provider: "chatgpt",
      conversation_id: "conv-replay",
      effective_prompt: "",
      prompt_status: "",
      created_at: "2026-10-08T16:00:00.000Z",
    });
    assert.equal(replayedNoPromptEver.effective_prompt, "a seated bulldog, studio light");
    assert.equal(replayedNoPromptEver.prompt_status, "user-message", "keeping the stored prompt keeps its status");
  });

  test(`${name} store keeps generation events independent from deduplicated assets`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `mosa-generation-${name.toLowerCase()}-`));
    deferTestPathRemoval(root, { recursive: true, force: true });
    let store;
    t.after(async () => {
      store?.close?.();
    });
    await mkdir(join(root, "input"), { recursive: true });
    const firstPath = join(root, "input", "first.png");
    const secondPath = join(root, "input", "second.png");
    await writeFile(firstPath, await pngBytes());
    await writeFile(secondPath, await pngBytes());

    store = createStore(root);
    await store.ensureProject("default");
    const sharedAsset = await store.createAsset({ projectId: "default", assetId: "shared-output", imagePath: firstPath });
    const childAsset = await store.createAsset({ projectId: "default", assetId: "child-output", imagePath: secondPath });

    const observedA = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: sharedAsset.id,
      provider: "chatgpt",
      capture_context_id: "chatgpt:conversation-a:call-a",
      provider_asset_id: "file-observed-a",
      conversation_id: "conversation-a",
      message_id: "message-a",
      effective_prompt: "observed prompt a",
      prompt_scope: "output",
      generation_status: "completed",
      verification_level: "observed",
      created_at: "2026-08-27T10:00:00.000Z",
    });
    const observedB = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: sharedAsset.id,
      provider: "chatgpt",
      capture_context_id: "chatgpt:conversation-b:call-b",
      conversation_id: "conversation-b",
      message_id: "message-b",
      effective_prompt: "observed prompt b",
      verification_level: "observed",
      created_at: "2026-08-27T11:00:00.000Z",
    });

    assert.notEqual(observedA.id, observedB.id, "one media asset may represent several independent generations");
    const sharedEvents = await store.listGenerationEvents("default", { assetId: sharedAsset.id });
    assert.equal(sharedEvents.length, 2);
    assert.deepEqual(sharedEvents.map((event) => event.capture_context_id), [
      "chatgpt:conversation-a:call-a",
      "chatgpt:conversation-b:call-b",
    ]);
    assert.ok(sharedEvents.every((event) => event.provider_generation_call_id === ""), "MOSA capture context must not impersonate a provider call id");
    assert.equal(sharedEvents.find((event) => event.id === observedA.id)?.prompt_scope, "output");
    assert.equal(sharedEvents.find((event) => event.id === observedA.id)?.generation_status, "completed");

    const verifiedChild = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: childAsset.id,
      provider: "openai",
      provider_generation_call_id: "ig_verified_child",
      provider_response_id: "resp_verified_child",
      user_prompt: "make the background black",
      effective_prompt: "make the background black",
      verification_level: "provider_verified",
      created_at: "2026-08-27T12:00:00.000Z",
    });
    const attemptedDowngrade = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: childAsset.id,
      provider: "openai",
      provider_generation_call_id: "ig_verified_child",
      provider_response_id: "spoofed-response",
      effective_prompt: "untrusted overwrite",
      verification_level: "observed",
      created_at: "2026-08-27T12:00:00.000Z",
    });
    assert.equal(attemptedDowngrade.verification_level, "provider_verified");
    assert.equal(attemptedDowngrade.provider_response_id, "resp_verified_child");
    assert.equal(attemptedDowngrade.effective_prompt, "make the background black");

    await store.recordGenerationRelation({
      project_id: "default",
      child_generation_id: verifiedChild.id,
      parent_generation_id: observedA.id,
      relation_type: "edited_from",
      verification_level: "provider_verified",
      evidence: { source: "trusted-provider-link" },
      created_at: "2026-08-27T12:00:01.000Z",
    });
    const relationDowngrade = await store.recordGenerationRelation({
      project_id: "default",
      child_generation_id: verifiedChild.id,
      parent_generation_id: observedA.id,
      relation_type: "edited_from",
      verification_level: "inferred",
      evidence: { source: "untrusted-guess" },
      created_at: "2026-08-27T12:00:02.000Z",
    });
    assert.equal(relationDowngrade.verification_level, "provider_verified");
    assert.deepEqual(relationDowngrade.evidence, { source: "trusted-provider-link" });

    const lineage = await store.getGenerationLineage("default", verifiedChild.id);
    assert.equal(lineage.events.length, 2);
    assert.equal(lineage.relations.length, 1);
    assert.equal(lineage.relations[0].verification_level, "provider_verified");
    const child = lineage.events.find((event) => event.id === verifiedChild.id);
    assert.deepEqual(child.parent_generation_ids, [observedA.id]);

    await assert.rejects(
      store.recordGenerationRelation({
        project_id: "default",
        child_generation_id: observedA.id,
        parent_generation_id: verifiedChild.id,
        relation_type: "edited_from",
        verification_level: "inferred",
      }),
      /cycle/i,
    );

    const upgraded = await store.recordGenerationEvent({
      ...observedA,
      effective_prompt: "better recovered observed prompt",
    });
    assert.equal(upgraded.id, observedA.id);
    const afterUpgrade = await store.listGenerationEvents("default", { captureContextId: observedA.capture_context_id });
    assert.equal(afterUpgrade.length, 1, "re-observing one generation updates evidence instead of duplicating history");
    assert.equal(afterUpgrade[0].effective_prompt, "better recovered observed prompt");

    const unrelatedProvider = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: childAsset.id,
      provider: "gemini",
      conversation_id: "conversation-a",
      message_id: "gemini-message-a",
      effective_prompt: "same conversation id on another provider",
      verification_level: "observed",
      created_at: "2026-08-27T13:00:00.000Z",
    });
    const sameContextCandidate = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: childAsset.id,
      provider: "chatgpt",
      conversation_id: "conversation-a",
      message_id: "message-candidate",
      effective_prompt: "same ChatGPT conversation candidate",
      references: [{ provider_asset_id: "file-observed-a", role: "" }],
      verification_level: "observed",
      created_at: "2026-08-27T13:10:00.000Z",
    });
    const assetHistory = await store.getAssetGenerationHistory("default", sharedAsset.id);
    assert.ok(assetHistory.context_events.every((event) => event.id !== unrelatedProvider.id), "context candidates stay within the same provider and conversation");
    assert.ok(assetHistory.context_events.some((event) => event.id === sameContextCandidate.id), "same-provider same-conversation generations are exposed as unlinked candidates");
    assert.ok(assetHistory.relation_candidates.some((candidate) => (
      candidate.child_generation_id === sameContextCandidate.id
      && candidate.parent_generation_id === observedA.id
      && candidate.suggested_relation_type === "based_on"
      && candidate.verification_level === "inferred"
      && candidate.status === "suggested"
      && candidate.confidence >= 0.55
      && candidate.evidence?.parent_provider_asset_id === "file-observed-a"
    )), "a reused provider asset becomes an inferred based_on candidate, not a confirmed edge");
    assert.equal(assetHistory.relations.some((relation) => (
      relation.child_generation_id === sameContextCandidate.id
      && relation.parent_generation_id === observedA.id
    )), false, "reference evidence must not silently become a formal relation");

    await assert.rejects(
      store.deleteGenerationRelation({
        project_id: "default",
        child_generation_id: verifiedChild.id,
        parent_generation_id: observedA.id,
        relation_type: "edited_from",
      }),
      /provider-verified/i,
      "provider-verified lineage edges stay immutable from the management surface",
    );
    await store.recordGenerationRelation({
      project_id: "default",
      child_generation_id: sameContextCandidate.id,
      parent_generation_id: observedA.id,
      relation_type: "variant_of",
      verification_level: "user_confirmed",
      evidence: { user_selected_parent: true },
    });
    const confirmedHistory = await store.getAssetGenerationHistory("default", sharedAsset.id);
    assert.equal(confirmedHistory.relation_candidates.some((candidate) => (
      candidate.child_generation_id === sameContextCandidate.id
      && candidate.parent_generation_id === observedA.id
    )), false, "confirmed candidates leave the possible-relation surface");
    await store.deleteGenerationRelation({
      project_id: "default",
      child_generation_id: sameContextCandidate.id,
      parent_generation_id: observedA.id,
      relation_type: "variant_of",
    });
    const detachedLineage = await store.getAssetGenerationHistory("default", sharedAsset.id);
    assert.ok(detachedLineage.context_events.some((event) => event.id === sameContextCandidate.id), "deleting a user-managed relation keeps the generation available in the same-conversation context");
    assert.equal(detachedLineage.relation_candidates.some((candidate) => (
      candidate.child_generation_id === sameContextCandidate.id
      && candidate.parent_generation_id === observedA.id
    )), false, "a dismissed candidate is not resurrected after the relation is removed");

    const childEventIds = new Set((await store.listGenerationEvents("default", { assetId: childAsset.id })).map((event) => event.id));
    await store.deleteAsset("default", childAsset.id);
    assert.equal((await store.listGenerationEvents("default", { assetId: childAsset.id })).length, childEventIds.size,
      "moving an asset to Trash preserves its generation history for restore");
    await store.permanentlyDeleteAsset("default", childAsset.id);
    assert.equal((await store.listGenerationEvents("default", { assetId: childAsset.id })).length, 0,
      "permanently deleting an asset removes its generation events in every backend");
    const remainingHistory = await store.getAssetGenerationHistory("default", sharedAsset.id);
    assert.equal(remainingHistory.relations.some((relation) => (
      childEventIds.has(relation.child_generation_id) || childEventIds.has(relation.parent_generation_id)
    )), false, "relations referencing deleted generation events must be removed");
    assert.equal(remainingHistory.relation_candidates.some((candidate) => (
      childEventIds.has(candidate.child_generation_id) || childEventIds.has(candidate.parent_generation_id)
    )), false, "relation candidates referencing deleted generation events must be removed");
  });

  test(`${name} store separates distinct providerToolCallIds in one captureContextId while keeping legacy event ids stable`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `mosa-generation-ctx-tool-${name.toLowerCase()}-`));
    deferTestPathRemoval(root, { recursive: true, force: true });
    let store;
    t.after(async () => {
      store?.close?.();
    });
    await mkdir(join(root, "input"), { recursive: true });
    const imgPath = join(root, "input", "dedup-out.png");
    await writeFile(imgPath, await pngBytes());

    store = createStore(root);
    await store.ensureProject("default");
    const asset = await store.createAsset({
      projectId: "default",
      assetId: "copy-1-mw703gcg-9451a83e-mw704yxs-768af462",
      imagePath: imgPath,
    });

    // 1. Only captureContextId, no providerToolCallId -> id is identical to the pre-380 value.
    const contextOnly = normalizeGenerationEvent({
      project_id: "default",
      output_asset_id: asset.id,
      provider: "openai",
      capture_context_id: "ctx-372-dedup",
    });
    assert.equal(contextOnly.id, "gen-4fb8e2b31e4d2c81eafe75b0");

    // 2. Legacy compatibility: insert a record whose id was derived by the pre-380
    // algorithm (anchor without provider_tool_call_id) while carrying a provider_tool_call_id,
    // then record the same generation again through the new code -> still 1 record, legacy id kept.
    const legacySeed = await store.recordGenerationEvent({
      project_id: "default",
      id: "gen-4fb8e2b31e4d2c81eafe75b0",
      output_asset_id: asset.id,
      provider: "openai",
      capture_context_id: "ctx-372-dedup",
      provider_tool_call_id: "call-372-dedup-1",
      effective_prompt: "initial legacy capture",
      verification_level: "observed",
      created_at: "2026-11-07T15:00:00.000Z",
    });
    assert.equal(legacySeed.id, "gen-4fb8e2b31e4d2c81eafe75b0");

    const reobservedLegacy = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: asset.id,
      provider: "openai",
      capture_context_id: "ctx-372-dedup",
      provider_tool_call_id: "call-372-dedup-1",
      effective_prompt: "re-observed legacy capture",
      verification_level: "observed",
      created_at: "2026-11-07T15:01:00.000Z",
    });
    assert.equal(reobservedLegacy.id, "gen-4fb8e2b31e4d2c81eafe75b0");
    assert.equal(reobservedLegacy.effective_prompt, "re-observed legacy capture");
    const afterReobserve = await store.listGenerationEvents("default", {
      assetId: asset.id,
      captureContextId: "ctx-372-dedup",
    });
    assert.equal(afterReobserve.length, 1);

    // 3. Same captureContextId, two different providerToolCallIds, same image (task 372 lines 480 & 481)
    // -> two distinct records, each keeping its own provider_tool_call_id.
    const secondCall = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: asset.id,
      provider: "openai",
      capture_context_id: "ctx-372-dedup",
      provider_tool_call_id: "call-372-dedup-2",
      effective_prompt: "second call in same context",
      verification_level: "observed",
      created_at: "2026-11-07T15:02:00.000Z",
    });
    assert.notEqual(secondCall.id, reobservedLegacy.id);
    assert.equal(secondCall.provider_tool_call_id, "call-372-dedup-2");

    // 4. Recording the same captureContextId + providerToolCallId twice -> still one record for that call.
    const secondCallReplay = await store.recordGenerationEvent({
      project_id: "default",
      output_asset_id: asset.id,
      provider: "openai",
      capture_context_id: "ctx-372-dedup",
      provider_tool_call_id: "call-372-dedup-2",
      effective_prompt: "second call updated prompt",
      verification_level: "observed",
      created_at: "2026-11-07T15:03:00.000Z",
    });
    assert.equal(secondCallReplay.id, secondCall.id);

    const allEvents = await store.listGenerationEvents("default", {
      assetId: asset.id,
      captureContextId: "ctx-372-dedup",
    });
    assert.equal(allEvents.length, 2);
    assert.deepEqual(
      allEvents.map((event) => event.provider_tool_call_id),
      ["call-372-dedup-1", "call-372-dedup-2"],
    );
  });
}
