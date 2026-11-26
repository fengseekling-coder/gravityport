/**
 * Whether this bundle is a local preview build with the AI line switched on.
 * vite injects the constant from GRAVITYPORT_LOCAL_AI at build time (see
 * local-build-flags.mjs); release and CI builds never set it, and outside the
 * bundler (unit tests, plain tsc) there is no value, so it reads as false.
 */
declare const __GRAVITYPORT_LOCAL_AI_BUILD__: boolean | undefined

export function localAiBuild(): boolean {
  return typeof __GRAVITYPORT_LOCAL_AI_BUILD__ === "boolean" && __GRAVITYPORT_LOCAL_AI_BUILD__
}
