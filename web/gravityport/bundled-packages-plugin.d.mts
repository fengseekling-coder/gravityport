import type { Plugin } from "vite";

export declare const BUNDLED_PACKAGES_FILE: string;
export declare function packageRootForModuleId(id: string): string | null;
export declare function bundledPackageDirs(moduleIds: Iterable<string>, root: string): string[];
export declare function bundledPackagesPlugin(options: { root: string; inlinedPackages?: string[] }): Plugin;
