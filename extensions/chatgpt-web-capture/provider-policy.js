(function installMosaProviderPolicy(root) {
  const FLOW_PATH = /^\/(?:fx\/(?:(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})?)\/)?tools\/)?flow(?:\/|$)/;
  // Flow moved from labs.google/fx/... to its dedicated product domain. The
  // dedicated host is the Flow app itself (the same whole-host rule as the
  // Gemini and AI Studio hosts); labs.google keeps the explicit /flow route
  // gate because that host also serves unrelated Labs experiments.
  const FLOW_HOSTS = new Set(["labs.google", "flow.google.com"]);
  // The tRPC media redirect endpoint kept its procedure name across the
  // migration; only the /fx prefix may differ between the two Flow hosts.
  const FLOW_MEDIA_REDIRECT_PATHS = new Set([
    "/fx/api/trpc/media.getMediaUrlRedirect",
    "/api/trpc/media.getMediaUrlRedirect",
  ]);
  const VIDEO_PROVIDERS = new Set(["flow", "google-ai-studio", "jimeng", "midjourney"]);

  function providerForPageUrl(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch {
      return "";
    }
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (host === "chatgpt.com" || host === "chat.openai.com") return "chatgpt";
    if (host === "gemini.google.com") return "gemini";
    if (host === "aistudio.google.com") return "google-ai-studio";
    if (host === "flow.google.com") return "flow";
    if (host === "labs.google" && FLOW_PATH.test(url.pathname.toLowerCase())) return "flow";
    if (host === "jimeng.jianying.com") return "jimeng";
    if (host === "www.midjourney.com") return "midjourney";
    return "";
  }

  function isFlowMediaRedirectUrl(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch {
      return false;
    }
    return url.protocol === "https:"
      && FLOW_HOSTS.has(url.hostname.toLowerCase())
      && FLOW_MEDIA_REDIRECT_PATHS.has(url.pathname)
      && Boolean(url.searchParams.get("name"));
  }

  function supportsVideo(provider) {
    return VIDEO_PROVIDERS.has(String(provider || "").trim().toLowerCase());
  }

  root.MosaProviderPolicy = Object.freeze({
    FLOW_PATH,
    isFlowMediaRedirectUrl,
    providerForPageUrl,
    supportsVideo,
  });
})(globalThis);
