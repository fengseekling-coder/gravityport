import { homedir } from "node:os";
import * as nodePath from "node:path";

const SOURCE_ENV_KEYS = Object.freeze({
  codexImagesDir: "CODEX_GENERATED_IMAGES_DIR",
  codexSessionsDir: "CODEX_SESSIONS_DIR",
  codexThreadHistoryDir: "CODEX_THREAD_HISTORY_DIR",
  grokSessionsDir: "GROK_SESSIONS_DIR",
  cowartCanvasDir: "COWART_MOSA_CANVAS_DIR",
  cowartRegistryPath: "MOSA_COWART_REGISTRY_PATH",
} as const);

export interface SourceLocationOverrides {
  codexImagesDir?: string;
  codexSessionsDir?: string;
  codexThreadHistoryDir?: string;
  grokSessionsDir?: string;
  cowartCanvasDir?: string;
  cowartRegistryPath?: string;
}

export interface SourceLocationEnvironment {
  CODEX_HOME?: string;
  CODEX_GENERATED_IMAGES_DIR?: string;
  CODEX_SESSIONS_DIR?: string;
  CODEX_THREAD_HISTORY_DIR?: string;
  GROK_SESSIONS_DIR?: string;
  COWART_MOSA_CANVAS_DIR?: string;
  MOSA_COWART_REGISTRY_PATH?: string;
  [key: string]: string | undefined;
}

export interface SourceLocations {
  codexImagesDir: string;
  codexSessionsDir: string;
  codexThreadHistoryDir: string;
  grokSessionsDir: string;
  cowartCanvasDir: string;
  cowartRegistryPath: string;
}

export function resolveSourceLocations({
  home = homedir(),
  env,
  overrides = {},
  pathApi = nodePath,
}: {
  home?: string;
  env?: SourceLocationEnvironment;
  overrides?: SourceLocationOverrides;
  pathApi?: typeof nodePath;
} = {}): SourceLocations {
  const codexRoot = pathApi.resolve(env?.CODEX_HOME || pathApi.join(home, ".codex"));
  const envValue = (name: keyof typeof SOURCE_ENV_KEYS): string | undefined => (
    env ? env[SOURCE_ENV_KEYS[name]] : undefined
  );
  const configured = (name: keyof SourceLocationOverrides, fallback: string): string => pathApi.resolve(
    overrides[name] || envValue(name) || fallback,
  );

  return {
    codexImagesDir: configured("codexImagesDir", pathApi.join(codexRoot, "generated_images")),
    codexSessionsDir: configured("codexSessionsDir", pathApi.join(codexRoot, "sessions")),
    codexThreadHistoryDir: configured("codexThreadHistoryDir", codexRoot),
    grokSessionsDir: configured("grokSessionsDir", pathApi.join(home, ".grok", "sessions")),
    cowartCanvasDir: configured("cowartCanvasDir", pathApi.join(codexRoot, "cowart-data", "mosa")),
    cowartRegistryPath: configured("cowartRegistryPath", pathApi.join(codexRoot, "mosa", "cowart-projects.json")),
  };
}
