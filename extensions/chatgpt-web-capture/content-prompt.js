// Prompt extraction and resolution moved out of content.js (task 423). Pure moves; no behavior changes.
(function installMosaContentPrompt(globalScope) {
  if (globalScope.MosaContentPrompt) return;

  function createContentPrompt(deps) {
    const currentConversationId = deps.currentConversationId;
    const chatGptImageProxyInfo = deps.chatGptImageProxyInfo;
    const isWeakChatPrompt = deps.isWeakChatPrompt;
    const looksLikeGenerationCaption = deps.looksLikeGenerationCaption;
    const conversationTurnForNode = deps.conversationTurnForNode;
    const nearestPrecedingUserScope = deps.nearestPrecedingUserScope;
    const cleanPromptText = deps.cleanPromptText;
    const normalizeGenerationStatus = deps.normalizeGenerationStatus;
    const extractPlaceHints = deps.extractPlaceHints;
    const promptMentionsPlace = deps.promptMentionsPlace;
    const findBoundPromptForImage = deps.findBoundPromptForImage;
    const findGenerationEvidenceForCandidate = deps.findGenerationEvidenceForCandidate;
    const generationRegistryForPage = deps.generationRegistryForPage;
    const CHATGPT_TURN_SELECTOR = deps.CHATGPT_TURN_SELECTOR;
    const CHATGPT_MESSAGE_SELECTOR = deps.CHATGPT_MESSAGE_SELECTOR;

    function buildStoredPrompt({ generationPrompt, generationStatus = "", userMessage, via }) {
      const gen = cleanPromptText(generationPrompt);
      const user = cleanPromptText(userMessage).slice(0, 8000);
      const places = extractPlaceHints(user);
      const trustedGeneration = generationStatus === "generation-tool-prompt";
      const visibleCaption = generationStatus === "visible-caption";
      const genOk = gen && (trustedGeneration || visibleCaption);
      const resolvedStatus = trustedGeneration
        ? "generation-tool-prompt"
        : visibleCaption
          ? "visible-caption"
          : "not-available";

      // Heuristics are useful recovery evidence, but they are not provider facts.
      // Never upgrade text merely because it looks like a generation prompt.
      if (gen && !genOk && looksLikeGenerationCaption(gen)) {
        return {
          prompt: "",
          candidatePrompt: gen,
          promptStatus: "not-available",
          userMessage: user,
          promptSource: "heuristic-generation-caption",
        };
      }

      // Real generation caption that matches place intent.
      if (genOk && places.length && promptMentionsPlace(gen, places)) {
        return {
          prompt: gen,
          promptStatus: resolvedStatus,
          userMessage: user,
          promptSource: via || "bound-place-match",
        };
      }

      // Caption present but may be stale vs user place request — still store caption as main prompt,
      // never replace it with the short chat line alone.
      if (genOk && places.length && !promptMentionsPlace(gen, places)) {
        return {
          prompt: gen,
          promptStatus: resolvedStatus,
          userMessage: user,
          promptSource: "bound-caption-place-mismatch",
        };
      }

      if (genOk) {
        return {
          prompt: gen,
          promptStatus: resolvedStatus,
          userMessage: user,
          promptSource: via || "generation",
        };
      }

      // A user turn is context, not ChatGPT's revised generation prompt.
      return {
        prompt: "",
        promptStatus: "not-available",
        userMessage: user || (isWeakChatPrompt(gen) ? "" : gen),
        promptSource: user || gen ? "awaiting-generation-caption" : "none",
      };
    }

    // The tool chip a prompt was sent with (ChatGPT's "Create image" system
    // hint) renders inside the user bubble as its own line, before or after the
    // text. Only a whole first/last line that is exactly a chip label goes; the
    // same words typed inside the message (e.g. "@创建图像 …") stay.
    const SYSTEM_HINT_LABEL_LINES = new Set(["创建图像", "創建圖像", "建立圖像", "Create image"]);

    function stripSystemHintLabelLines(text) {
      const lines = String(text || "").split(/\r?\n/);
      while (lines.length && (SYSTEM_HINT_LABEL_LINES.has(lines[0].trim()) || !lines[0].trim())) lines.shift();
      while (lines.length && (SYSTEM_HINT_LABEL_LINES.has(lines[lines.length - 1].trim()) || !lines[lines.length - 1].trim())) lines.pop();
      return lines.join("\n").trim();
    }

    function userMessageForCandidate(candidate) {
      const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
      if (!image) return "";
      const nearest = nearestPrecedingUserScope(image);
      return stripSystemHintLabelLines(nearest?.innerText || "");
    }

    function messageScopeForCandidate(candidate) {
      const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
      if (!image) return null;
      return image.closest(
        `${CHATGPT_MESSAGE_SELECTOR}, [data-message-author-role="assistant"], [data-message-author-role="tool"], [data-message-id], ${CHATGPT_TURN_SELECTOR}, article`,
      );
    }

    function domCaptionForCandidate(candidate) {
      const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
      if (!image) return "";
      const scope = messageScopeForCandidate(candidate);
      const directSources = [image.getAttribute("alt"), image.getAttribute("aria-label")];
      for (const source of directSources) {
        const text = String(source || "").replace(/\s+/g, " ").trim();
        const match = /model caption\s*:\s*(.+)$/i.exec(text);
        const caption = cleanPromptText(match?.[0] || text);
        if (looksLikeGenerationCaption(caption)) return caption;
      }
      const scopeText = String(scope?.innerText || "").replace(/\s+/g, " ").trim();
      const scopedMatch = /model caption\s*:\s*(.+)$/i.exec(scopeText);
      const scopedCaption = cleanPromptText(scopedMatch?.[0] || "");
      if (looksLikeGenerationCaption(scopedCaption)) return scopedCaption;
      return "";
    }

    function messageIdsForCandidate(candidate) {
      const image = candidate?.el instanceof HTMLImageElement ? candidate.el : null;
      if (!image) return [];
      const directMessage = image.closest?.("[data-message-id]");
      const direct = String(directMessage?.getAttribute?.("data-message-id") || "").trim();
      if (direct) return [direct];
      const searchMessage = image.closest?.(CHATGPT_MESSAGE_SELECTOR);
      const searchIds = String(searchMessage?.getAttribute?.("data-chatgpt-search-message-ids") || "")
        .trim().split(/[\s,]+/).filter(Boolean);
      if (searchIds.length) return [...new Set(searchIds)];
      const turn = conversationTurnForNode(image);
      const nestedMessage = String(turn?.querySelector?.("[data-message-id]")?.getAttribute?.("data-message-id") || "").trim();
      if (nestedMessage) return [nestedMessage];
      const testId = String(turn?.getAttribute?.("data-testid") || "").trim();
      return testId.startsWith("conversation-turn-") ? [testId.slice("conversation-turn-".length)] : [];
    }

    function messageIdForCandidate(candidate) {
      const ids = messageIdsForCandidate(candidate);
      return ids.length === 1 ? ids[0] : "";
    }

    // Task 353 (2026-11-03): there is no "ask the page hook to re-read the
    // conversation" recovery anymore — the endpoints answered 404 and the
    // page's own conversation reads carry no prompt. Prompts live only in the
    // real-time push, which the hook binds while it arrives; persisted
    // bindings (chrome.storage.session) carry them across refreshes/tabs.

    function resolvePrompt(imageUrl, candidate) {
      const userMessage = userMessageForCandidate(candidate);
      const providerAssetId = chatGptImageProxyInfo(imageUrl)?.assetId || "";
      const registry = generationRegistryForPage();
      const generationEvidence = findGenerationEvidenceForCandidate(candidate);

      const bound = findBoundPromptForImage(imageUrl);
      if (bound?.prompt) {
        const built = buildStoredPrompt({
          generationPrompt: bound.prompt,
          generationStatus: bound.promptStatus,
          userMessage,
          via: `bound:${bound.via || "network"}`,
        });
        return {
          ...built,
          promptSource: bound.promptSource || built.promptSource,
          promptPriority: Number(bound.promptPriority) || 0,
          promptScope: bound.promptScope || "output",
          generationStatus: normalizeGenerationStatus(bound.generationStatus),
          model: bound.model || "",
          conversationId: bound.conversationId || "",
          messageId: bound.messageId || "",
          generationContextId: bound.generationContextId || "",
          providerToolCallId: bound.providerToolCallId || "",
          providerGenerationCallId: bound.providerGenerationCallId || "",
          providerResponseId: bound.providerResponseId || "",
          generationRequestPrompt: bound.generationRequestPrompt || generationEvidence?.generationRequestPrompt || "",
          providerAssetId: bound.assetId || providerAssetId,
        };
      }

      // Preview/blob URLs can lose their provider asset identity. Use the
      // containing message only when the registry proves there is exactly one
      // generation attempt in that message. Error + retry messages with several
      // attempts intentionally fail closed here instead of borrowing a sibling
      // attempt's prompt.
      const domMessageIds = messageIdsForCandidate(candidate);
      const domMessageId = domMessageIds.length === 1 ? domMessageIds[0] : "";
      const messageBound = domMessageIds.length === 1
        ? registry?.resolvedForMessage?.(currentConversationId(), domMessageIds[0])
        : registry?.resolvedForMessages?.(currentConversationId(), domMessageIds);
      if (messageBound?.isGeneration) {
        const built = buildStoredPrompt({
          generationPrompt: messageBound.prompt,
          generationStatus: messageBound.promptStatus,
          userMessage,
          via: `message:${messageBound.via || "registry"}`,
        });
        return {
          ...built,
          promptSource: messageBound.promptSource || built.promptSource,
          promptPriority: Number(messageBound.promptPriority) || 0,
          promptScope: messageBound.promptScope || "attempt",
          generationStatus: normalizeGenerationStatus(messageBound.generationStatus),
          model: messageBound.model || "",
          conversationId: messageBound.conversationId || currentConversationId(),
          messageId: messageBound.messageId || domMessageId,
          generationContextId: messageBound.generationContextId || "",
          providerToolCallId: messageBound.providerToolCallId || "",
          providerGenerationCallId: messageBound.providerGenerationCallId || "",
          providerResponseId: messageBound.providerResponseId || "",
          generationRequestPrompt: messageBound.generationRequestPrompt || "",
          providerAssetId: messageBound.assetId || providerAssetId,
        };
      }

      // Cached ChatGPT routes can render an image without replaying the
      // conversation response. Keep the fallback inside that image's own
      // message and accept only the explicit Model caption marker.
      const domCaption = domCaptionForCandidate(candidate);
      if (domCaption) {
        const built = buildStoredPrompt({
          generationPrompt: domCaption,
          generationStatus: "visible-caption",
          userMessage,
          via: "dom-message-caption",
        });
        return {
          ...built,
          promptPriority: 425,
          promptScope: "output",
          generationStatus: normalizeGenerationStatus(generationEvidence?.generationStatus),
          model: "",
          conversationId: currentConversationId(),
          messageId: messageIdForCandidate(candidate),
          generationContextId: "",
          providerToolCallId: "",
          providerGenerationCallId: "",
          providerResponseId: "",
          generationRequestPrompt: generationEvidence?.generationRequestPrompt || "",
          providerAssetId,
        };
      }

      const built = buildStoredPrompt({
        generationPrompt: "",
        userMessage,
        via: "user-fallback",
      });
      return {
        ...built,
        promptPriority: 0,
        promptScope: "",
        generationStatus: normalizeGenerationStatus(generationEvidence?.generationStatus),
        model: "",
        conversationId: currentConversationId(),
        messageId: "",
        generationContextId: "",
        providerToolCallId: "",
        providerGenerationCallId: "",
        providerResponseId: "",
        generationRequestPrompt: generationEvidence?.generationRequestPrompt || "",
        providerAssetId,
      };
    }
    return {
      buildStoredPrompt,
      SYSTEM_HINT_LABEL_LINES,
      stripSystemHintLabelLines,
      userMessageForCandidate,
      messageScopeForCandidate,
      domCaptionForCandidate,
      messageIdsForCandidate,
      messageIdForCandidate,
      resolvePrompt,
    };
  }

  globalScope.MosaContentPrompt = { createContentPrompt };
})(globalThis);
