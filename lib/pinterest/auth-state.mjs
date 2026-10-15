// One-time state tokens for OAuth authorization.
import { randomBytes } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PENDING_STATES = 5;

/**
 * Create an auth-state manager.
 * @param {object} options
 * @param {function} options.now - Function returning current timestamp.
 * @returns {object} Auth state manager.
 */
export function createAuthStateManager({ now = Date.now } = {}) {
  // Map of state -> expiry timestamp.
  const pendingStates = new Map();

  /**
   * Generate a new state token.
   * @returns {string} Base64url-encoded random state.
   */
  function generate() {
    cleanup();
    
    // Limit pending states.
    if (pendingStates.size >= MAX_PENDING_STATES) {
      const oldest = [...pendingStates.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) pendingStates.delete(oldest[0]);
    }
    
    const state = randomBytes(32).toString("base64url");
    const expiresAt = now() + STATE_TTL_MS;
    pendingStates.set(state, expiresAt);
    return state;
  }

  /**
   * Validate and consume a state token.
   * @param {string} state - State to validate.
   * @returns {boolean} True if valid and not yet used.
   */
  function validateAndConsume(state) {
    cleanup();
    
    if (!state || typeof state !== "string") return false;
    
    const expiresAt = pendingStates.get(state);
    if (!expiresAt) return false;
    
    if (now() > expiresAt) {
      pendingStates.delete(state);
      return false;
    }
    
    // Use once: delete immediately.
    pendingStates.delete(state);
    return true;
  }

  /**
   * Remove expired states.
   */
  function cleanup() {
    const currentTime = now();
    for (const [state, expiresAt] of pendingStates.entries()) {
      if (currentTime > expiresAt) {
        pendingStates.delete(state);
      }
    }
  }

  return { generate, validateAndConsume };
}
