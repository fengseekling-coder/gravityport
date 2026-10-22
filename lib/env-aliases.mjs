/**
 * User-facing environment switches carry the GravityPort name. The older
 * MOSA_* spellings stay accepted as undocumented aliases because existing
 * installs may already set them; when both are present the GRAVITYPORT_*
 * value wins. Internal-only variables keep their MOSA_* names.
 */
export const GRAVITYPORT_ENV_ALIASES = Object.freeze({
  GRAVITYPORT_DISABLE_TELEMETRY: "MOSA_DISABLE_TELEMETRY",
  GRAVITYPORT_DISABLE_BRIDGES: "MOSA_DISABLE_BRIDGES",
  GRAVITYPORT_LIBRARY_DIR: "MOSA_LIBRARY_DIR",
  GRAVITYPORT_LIBRARY_LOCATION_FILE: "MOSA_LIBRARY_LOCATION_FILE",
  GRAVITYPORT_WEB_CAPTURE_TOKEN: "MOSA_WEB_CAPTURE_TOKEN",
  GRAVITYPORT_WEB_CAPTURE_ORIGINS: "MOSA_WEB_CAPTURE_ORIGINS",
});

/**
 * Read a switch by its GravityPort name, falling back to the legacy alias.
 * A defined GRAVITYPORT_* value wins even when it is empty, so the new name
 * can also clear a legacy value.
 * @param {Record<string, string | undefined> | undefined} env
 * @param {keyof typeof GRAVITYPORT_ENV_ALIASES} name
 */
export function readGravityPortEnv(env, name) {
  const legacy = GRAVITYPORT_ENV_ALIASES[name];
  if (!legacy) throw new Error(`Unknown GravityPort environment switch ${name}.`);
  if (!env) return undefined;
  return env[name] !== undefined ? env[name] : env[legacy];
}

/**
 * Fold every GRAVITYPORT_* switch onto the legacy name the code reads, then
 * drop the new name. Entry points call this before anything else runs, so the
 * rest of the process, and any child launched with `{ ...process.env,
 * MOSA_LIBRARY_DIR: override }`, sees exactly one value.
 * @param {Record<string, string | undefined>} [env]
 */
export function applyGravityPortEnvAliases(env = process.env) {
  for (const [name, legacy] of Object.entries(GRAVITYPORT_ENV_ALIASES)) {
    if (env[name] === undefined) continue;
    env[legacy] = env[name];
    delete env[name];
  }
  return env;
}

/** The anonymous usage signal is off when either name is set to "1". */
export function isTelemetryDisabled(env = process.env) {
  return readGravityPortEnv(env, "GRAVITYPORT_DISABLE_TELEMETRY") === "1";
}
