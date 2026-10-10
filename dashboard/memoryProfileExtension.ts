import path from "node:path";
import { normalizePath, type Plugin } from "vite";

/** Compose WANX's optional profile visualization without patching memory sources. */
export function memoryProfileExtension(root: string): Plugin {
  const panel = path.join(root, "src/pages/Agent/Memory/MemoryPanel.tsx");
  return {
    name: "wanx-memory-profile-visualization",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "./ProfileOverview" &&
        importer &&
        normalizePath(importer.split("?")[0]) === normalizePath(panel)
      ) {
        return path.join(root, "src/extensions/memory/ProfileWithRadar.tsx");
      }
    },
  };
}
