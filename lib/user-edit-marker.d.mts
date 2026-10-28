/**
 * Type surface of lib/user-edit-marker.mjs consumed from TypeScript sources
 * (codex-image-bridge.ts, grok-media-bridge.ts, web-capture-ingest.ts). The
 * .mjs module is plain JavaScript by design, so this hand-maintained
 * declaration keeps the user-edit markers typed without duplicating logic.
 */

/** Asset shape as seen by the marker readers; only the read keys are named. */
export interface UserEditMarkerAsset {
  source?: {
    prompt_user_edited_at?: string;
    theme_user_edited_at?: string;
    user_edited_at?: string;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/**
 * Merge user-edit markers into a human-provided patch. Returns the patch
 * unchanged when no text field really changed; otherwise returns a new patch
 * whose `source` merges the stored source underneath the patch source and
 * applies the markers last.
 */
export declare function withUserEditMarkers(
  current: UserEditMarkerAsset | null | undefined,
  patch: Record<string, unknown>,
  nowIso?: string,
): Record<string, unknown>;

/** True when a human edited the prompt through a marked entry point. */
export declare function isPromptUserEdited(asset: UserEditMarkerAsset | null | undefined): boolean;

/** True when a human edited the display name (`theme`) through a marked entry point. */
export declare function isThemeUserEdited(asset: UserEditMarkerAsset | null | undefined): boolean;
