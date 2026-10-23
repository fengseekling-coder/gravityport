/**
 * Version of the browser extension shipped with this app build. vite reads
 * extensions/chatgpt-web-capture/manifest.json at build time and injects the
 * value as a constant; outside the bundler (unit tests, plain tsc) there is
 * no value, and the extension card then simply never claims "有新版扩展".
 */
declare const __GRAVITYPORT_BUNDLED_EXTENSION_VERSION__: string | undefined

export function bundledExtensionVersion(): string {
  return typeof __GRAVITYPORT_BUNDLED_EXTENSION_VERSION__ === "string"
    ? __GRAVITYPORT_BUNDLED_EXTENSION_VERSION__
    : ""
}
