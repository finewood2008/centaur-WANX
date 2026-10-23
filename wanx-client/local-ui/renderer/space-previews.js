(() => {
  // Only visible images are fetched, one at a time. Keep resized pixels in memory,
  // never persist private previews or load original images via public URLs.
  window.createSpacePreviews = ({ request }) => {
    const cache = new Map(), queue = new Map();
    let observer, scope, generation = 0, mountRevision = 0, running = false, enabled = false;
    const key = item => `${item.id}:${item.version || 0}:${item.digest || `${item.modified}:${item.size}`}`;
    const eligible = item => item.kind === "file" && /\.(png|jpe?g|gif|webp)$/i.test(item.name) && item.size > 0 && item.size <= 16 * 1024 * 1024;
    function reset() {
      generation++; mountRevision++; observer?.disconnect(); queue.clear();
      for (const value of cache.values()) if (value) URL.revokeObjectURL(value);
      cache.clear();
    }
    function paint(token, url) {
      if (!enabled) return;
      for (const node of document.querySelectorAll("[data-space-thumbnail]")) {
        if (node.dataset.spaceThumbnail !== token) continue;
        const image = document.createElement("img");
        image.src = url; image.alt = ""; image.draggable = false;
        image.className = "space-thumbnail"; node.replaceChildren(image);
      }
    }
    async function drain() {
      if (running || !enabled) return;
      running = true;
      try {
        while (enabled && queue.size) {
          const [token, item] = queue.entries().next().value; queue.delete(token);
          if (cache.has(token)) continue;
          const epoch = generation;
          let url, bitmap;
          try {
            const result = await request(item.id);
            if (epoch !== generation) continue;
            if (!/^image\/(png|jpeg|gif|webp)$/.test(result.type)) throw Error("Unsupported thumbnail");
            const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
            bitmap = await createImageBitmap(new Blob([bytes], { type: result.type }));
            if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 50_000_000) throw Error("Image dimensions too large");
            const ratio = Math.min(192 / bitmap.width, 192 / bitmap.height, 1);
            const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * ratio)), Math.max(1, Math.round(bitmap.height * ratio)));
            canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const blob = await canvas.convertToBlob({ type: "image/png" });
            if (epoch !== generation) continue;
            if (blob.size > 256 * 1024) throw Error("Thumbnail too large");
            url = URL.createObjectURL(blob);
            cache.set(token, url); paint(token, url);
          } catch {
            // A bad/unsupported image keeps its normal file icon. Do not break navigation.
            if (epoch === generation) cache.set(token, null);
          } finally { bitmap?.close(); }
          if (epoch === generation) while (cache.size > 64) {
            const oldest = cache.keys().next().value, value = cache.get(oldest);
            if (value) URL.revokeObjectURL(value); cache.delete(oldest);
          }
        }
      } finally { running = false; }
    }
    return { key, eligible, image: item => cache.get(key(item)), reset,
      mount(items, nextScope, show) {
        observer?.disconnect(); queue.clear();
        if (scope !== nextScope) { reset(); scope = nextScope; }
        const mounted = ++mountRevision;
        enabled = show && typeof IntersectionObserver !== "undefined" && typeof createImageBitmap !== "undefined" && typeof OffscreenCanvas !== "undefined";
        if (!enabled) return;
        const byKey = new Map(items.filter(eligible).map(item => [key(item), item]));
        const epoch = generation;
        observer = new IntersectionObserver(entries => {
          if (epoch !== generation || mounted !== mountRevision || !enabled) return;
          for (const entry of entries) {
            const token = entry.target.dataset.spaceThumbnail;
            if (!entry.isIntersecting) { queue.delete(token); continue; }
            const item = byKey.get(token);
            if (!item) continue;
            if (cache.get(token)) paint(token, cache.get(token));
            else if (!cache.has(token)) queue.set(token, item);
          }
          void drain();
        }, { root: document.querySelector(".space-file-list") });
        for (const node of document.querySelectorAll("[data-space-thumbnail]")) observer.observe(node);
      },
    };
  };
})();
