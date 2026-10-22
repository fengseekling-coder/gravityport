// Side-effect import for process entry points: list it first so every module
// evaluated after it already sees GRAVITYPORT_* switches folded onto the
// MOSA_* names the code reads (see env-aliases.mjs).
import { applyGravityPortEnvAliases } from "./env-aliases.mjs";

applyGravityPortEnvAliases();
