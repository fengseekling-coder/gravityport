// Build-time switch for the maintainer's own preview packages: released builds
// keep the AI settings page and the learning library behind the
// `gravityport.dev.ai-generation` localStorage switch (off by default), while a
// local package built with GRAVITYPORT_LOCAL_AI=1 shows both. CI and release
// builds never set it. Only the exact string "1" counts.
export function localAiBuildFromEnv(env) {
  return env?.GRAVITYPORT_LOCAL_AI === "1"
}
