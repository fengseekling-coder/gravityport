import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// The supplied Figma Make JSX and CSS are the sole visual source of truth.
// Build to a separate location while integrating data services; the existing
// MOSA shell must not be replaced with an unverified/empty UI bundle.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome120",
  },
})
