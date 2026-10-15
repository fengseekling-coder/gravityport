// Token storage with atomic writes.
import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod, unlink, rename } from "node:fs/promises";
import { join } from "node:path";

const TOKEN_FILE_NAME = "pinterest-auth.json";

/**
 * Create a token store.
 * @param {string} userDataDir - User data directory.
 * @returns {object} Token store.
 */
export function createTokenStore(userDataDir) {
  const tokenPath = join(userDataDir, TOKEN_FILE_NAME);

  /**
   * Read token data.
   * @returns {Promise<object|null>} Token data or null if not found/corrupt.
   */
  async function read() {
    try {
      const content = await readFile(tokenPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Write token data atomically.
   * @param {object} data - Token data to persist.
   */
  async function write(data) {
    const tempPath = `${tokenPath}.${randomBytes(8).toString("hex")}.tmp`;
    
    try {
      // Write to temp file with 0o600 mode.
      await writeFile(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      await chmod(tempPath, 0o600); // Ensure mode on all platforms.
      
      // Atomic rename to final path.
      await rename(tempPath, tokenPath);
    } catch (error) {
      // Clean up temp file if it still exists.
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  /**
   * Delete token file.
   */
  async function clear() {
    await unlink(tokenPath).catch(() => {});
  }

  return { read, write, clear };
}
