// Image byte readers and decoded-size checks moved out of content.js (task 419). Pure moves; no behavior changes.
(function installMosaContentMedia(globalScope) {
  if (globalScope.MosaContentMedia) return;

  function createContentMedia(deps) {
    const runtimeSend = deps.runtimeSend;
    const isProvenGalleryBlobUrl = deps.isProvenGalleryBlobUrl;
    const candidateLookupKeys = deps.candidateLookupKeys;
    const imageLookupKeys = deps.imageLookupKeys;
    const DOM_MEDIA_GRACE_MS = deps.DOM_MEDIA_GRACE_MS;

    async function originalBytesFromUrl(url) {
      if (!url) throw new Error("无法保存图片：下载未完成或网站限制访问");
      if (url.startsWith("blob:")) {
        // A blob handle only resolves inside the page, not in the service worker.
        const response = await fetch(url);
        if (!response.ok) throw new Error(`blob/img fetch failed (${response.status})`);
        const blob = await response.blob();
        const buffer = await blob.arrayBuffer();
        return { mimeType: blob.type || "image/png", imageBase64: arrayBufferToBase64(buffer) };
      }
      const response = await runtimeSend({ type: "mosa.fetchImage", url });
      if (!response?.ok) throw new Error(response?.error || "Image download failed");
      return response.result;
    }

    async function canvasBytesFromImage(el) {
      if (!(el instanceof HTMLImageElement) || !el.complete || !el.naturalWidth) {
        throw new Error("无法保存图片：下载未完成或网站限制访问");
      }
      const canvas = document.createElement("canvas");
      canvas.width = el.naturalWidth;
      canvas.height = el.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法保存图片：下载未完成或网站限制访问");
      context.drawImage(el, 0, 0);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Canvas encoding failed")), "image/png");
      });
      const buffer = await blob.arrayBuffer();
      return { mimeType: blob.type || "image/png", imageBase64: arrayBufferToBase64(buffer) };
    }

    function renderedCandidateFor(candidate) {
      const keys = candidateLookupKeys(candidate);
      if (!keys.length) return null;
      for (const image of document.querySelectorAll("img")) {
        if (!(image instanceof HTMLImageElement) || !image.complete || !image.naturalWidth) continue;
        const src = image.currentSrc || image.src || "";
        if (!src) continue;
        const imageKeys = imageLookupKeys(src);
        if (!imageKeys.some((key) => keys.includes(key))) continue;
        return {
          ...candidate,
          key: src,
          imageUrl: src,
          el: image,
          width: image.naturalWidth || image.width || candidate?.width || 0,
          height: image.naturalHeight || image.height || candidate?.height || 0,
        };
      }
      return null;
    }

    async function waitForRenderedCandidate(candidate, timeoutMs = DOM_MEDIA_GRACE_MS) {
      const immediate = candidate?.el instanceof HTMLImageElement && candidate.el.complete && candidate.el.naturalWidth
        ? candidate
        : renderedCandidateFor(candidate);
      if (immediate) return immediate;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        const rendered = renderedCandidateFor(candidate);
        if (rendered) return rendered;
      }
      return null;
    }

    /**
     * Give the original provider bytes a very short head start so JPEG/WebP
     * generations keep their original encoding and do not balloon into a large
     * synchronous PNG data URL. A rendered DOM image remains the low-latency
     * fallback, and a tainted canvas can still wait for the bounded network read.
     */
    async function bytesFromUrlOrImg(candidate) {
      if (candidate.dataUrl) {
        const match = /^data:([^;]+);base64,(.+)$/i.exec(candidate.dataUrl);
        if (!match) throw new Error("Unsupported data URL");
        return { mimeType: match[1], imageBase64: match[2] };
      }

      const originalUrl = candidate.imageUrl || candidate.key || "";
      // A proven gallery blob is page-local: read its original bytes directly
      // instead of waiting for the lazy thumbnail <img> to decode.
      if (isProvenGalleryBlobUrl(originalUrl)) return originalBytesFromUrl(originalUrl);
      const originalPromise = /^https:/i.test(originalUrl)
        ? originalBytesFromUrl(originalUrl).then((value) => ({ value }), () => null)
        : null;
      const renderedPromise = waitForRenderedCandidate(candidate);
      if (originalPromise) {
        const fastOriginal = await Promise.race([
          originalPromise,
          renderedPromise.then(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 220)),
        ]);
        if (fastOriginal?.value) return fastOriginal.value;
      }
      const rendered = await renderedPromise;
      if (rendered?.el) {
        try {
          return await canvasBytesFromImage(rendered.el);
        } catch {
          // Some provider images taint canvas. Fall back to provider bytes.
        }
      }
      if (originalPromise) {
        const original = await originalPromise;
        if (original?.value) return original.value;
      }
      if (originalUrl) return originalBytesFromUrl(originalUrl);
      return canvasBytesFromImage(candidate.el);
    }

    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    /** Real pixel size of image bytes, decoded once and released immediately. */
    async function decodedImageDimensions(imageBase64, mimeType) {
      try {
        const binary = atob(String(imageBase64 || ""));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType || "image/png" }));
        const dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close?.();
        return dimensions;
      } catch {
        return null;
      }
    }

    return {
      originalBytesFromUrl,
      canvasBytesFromImage,
      renderedCandidateFor,
      waitForRenderedCandidate,
      bytesFromUrlOrImg,
      arrayBufferToBase64,
      decodedImageDimensions,
    };
  }

  globalScope.MosaContentMedia = { createContentMedia };
})(globalThis);
