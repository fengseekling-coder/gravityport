import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { bundledPackagesPlugin } from "./bundled-packages-plugin.mjs"

// The extension status card compares the reporting extension against the
// version this build ships (task 225); read it from the packaged manifest
// instead of hardcoding it.
const bundledExtensionVersion = String(
  (JSON.parse(readFileSync(new URL("../../extensions/chatgpt-web-capture/manifest.json", import.meta.url), "utf8")) as { version?: string }).version || "",
)

// The supplied Figma Make JSX and CSS are the sole visual source of truth.
// Build to a separate location while integrating data services; the existing
// MOSA shell must not be replaced with an unverified/empty UI bundle.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Lists the npm packages in the bundle for the desktop license file.
    // Tailwind's base CSS is inlined by @tailwindcss/vite, so it is named here.
    bundledPackagesPlugin({ root: fileURLToPath(new URL(".", import.meta.url)), inlinedPackages: ["tailwindcss"] }),
  ],
  define: {
    __GRAVITYPORT_BUNDLED_EXTENSION_VERSION__: JSON.stringify(bundledExtensionVersion),
  },
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome120",
  },
})
