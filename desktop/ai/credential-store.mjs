// 任务 458：AI 密钥保存（主进程，userData 里的 ai-credentials.json）。
//
// 密钥只存这一份、只经 ai-* IPC 通道进出（desktop/ipc/ai.mjs），不加任何
// HTTP 路由：服务进程、后台收图进程、MCP、扩展永远拿不到。正式实现包
// Electron safeStorage（Mac 钥匙串、Windows 系统加密），加密不可用时拒收，
// 任何情况下都不退回明文。写法照 lib/pinterest/token-store.mjs：临时文件 +
// 改名的原子写、0o600。

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CREDENTIALS_FILE_NAME = "ai-credentials.json";
const MAX_KEY_LENGTH = 512;
// 中间含空白或控制字符的密钥一律拒收（不按前缀校验，各家格式会变）。
const INVALID_KEY_CHARS_RE = /[\s\u0000-\u001f\u007f-\u009f]/;

/**
 * QA 替身：只在本进程内可逆（qa: 前缀 + base64），不是加密。只在
 * quietQaRun 为真时被 chooseAiEncryption 选中，正式运行绝不会被选到。
 */
export function createQaAiEncryptionStub() {
  const PREFIX = "qa:";
  return {
    isAvailable: () => true,
    encrypt: (text) => Buffer.from(PREFIX + Buffer.from(String(text), "utf8").toString("base64"), "utf8"),
    decrypt: (buffer) => {
      const text = Buffer.from(buffer).toString("utf8");
      if (!text.startsWith(PREFIX)) throw new Error("not a qa ciphertext");
      return Buffer.from(text.slice(PREFIX.length), "base64").toString("utf8");
    },
  };
}

/**
 * 正式实现：包 Electron 的 safeStorage。Linux 上选不到可用的后端
 * （basic_text / unknown）时也算不可用——那两种后端只是明文混淆，不能算
 * 「系统加密」。platform 可注入，测试用它钉住 Linux 的后端规则。
 */
export function createSafeStorageAiEncryption(safeStorage, { platform = process.platform } = {}) {
  return {
    isAvailable() {
      try {
        if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function") return false;
        if (!safeStorage.isEncryptionAvailable()) return false;
        if (platform === "linux" && typeof safeStorage.getSelectedStorageBackend === "function") {
          const backend = safeStorage.getSelectedStorageBackend();
          if (backend === "basic_text" || backend === "unknown") return false;
        }
        return true;
      } catch {
        return false;
      }
    },
    encrypt: (text) => safeStorage.encryptString(String(text)),
    decrypt: (buffer) => safeStorage.decryptString(buffer),
  };
}

/**
 * QA 运行（MOSA_QA_RUN=1 且未打包）用替身，正式运行才用 safeStorage——绝不
 * 反过来。desktop/main.mjs 持有 quietQaRun 和 electron 的 safeStorage。
 */
export function chooseAiEncryption({ quietQaRun, safeStorage }) {
  if (quietQaRun === true) return createQaAiEncryptionStub();
  return createSafeStorageAiEncryption(safeStorage);
}

function normalizeKey(key) {
  const trimmed = String(key ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_KEY_LENGTH) return null;
  if (INVALID_KEY_CHARS_RE.test(trimmed)) return null;
  return trimmed;
}

async function readCredentialFile(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.services !== "object" || parsed.services === null) {
      return { version: 1, services: {} };
    }
    return parsed;
  } catch {
    return { version: 1, services: {} };
  }
}

async function writeCredentialFile(path, data) {
  await mkdir(join(path, ".."), { recursive: true });
  const tempPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(tempPath, 0o600); // Ensure mode on all platforms.
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

/**
 * @param {{ dir: string, encryption: { isAvailable(): boolean, encrypt(text): Buffer, decrypt(Buffer): string } }} options
 *   dir 传 desktopDataDir（userData），不是素材库目录。
 */
export function createAiCredentialStore({ dir, encryption }) {
  const filePath = join(dir, CREDENTIALS_FILE_NAME);

  async function decryptEntry(entry) {
    try {
      const plain = encryption.decrypt(Buffer.from(String(entry?.ciphertext || ""), "base64"));
      return typeof plain === "string" && plain.length > 0 ? plain : null;
    } catch {
      return null;
    }
  }

  return {
    /** 加密层是否可用；不可用时整页禁用，界面提示换电脑重新填。 */
    isEncryptionAvailable() {
      try {
        return encryption.isAvailable() === true;
      } catch {
        return false;
      }
    },

    /**
     * 存一把密钥。返回 { ok: true, last4 } 或
     * { ok: false, reason: "invalid-key" | "encryption-unavailable" }。
     * 返回值里只有 last4，密钥原文不进任何返回值、日志、错误信息。
     */
    async save(serviceId, key) {
      const normalized = normalizeKey(key);
      if (!normalized) return { ok: false, reason: "invalid-key" };
      if (!encryption.isAvailable()) return { ok: false, reason: "encryption-unavailable" };
      const ciphertext = encryption.encrypt(normalized);
      const data = await readCredentialFile(filePath);
      data.version = 1;
      data.services[serviceId] = {
        ciphertext: Buffer.from(ciphertext).toString("base64"),
        last4: normalized.slice(-4),
        savedAt: new Date().toISOString(),
      };
      await writeCredentialFile(filePath, data);
      return { ok: true, last4: normalized.slice(-4) };
    },

    async remove(serviceId) {
      const data = await readCredentialFile(filePath);
      if (!(serviceId in data.services)) return { ok: true };
      delete data.services[serviceId];
      await writeCredentialFile(filePath, data);
      return { ok: true };
    },

    /**
     * 每个已存过密钥的服务一条 { hasKey, last4, savedAt }。解不开的
     * （换了电脑、钥匙串被清）当作「没填」，不报错不崩。
     */
    async status() {
      const data = await readCredentialFile(filePath);
      const result = {};
      for (const [serviceId, entry] of Object.entries(data.services || {})) {
        const plain = await decryptEntry(entry);
        result[serviceId] = {
          hasKey: plain !== null,
          last4: String(entry?.last4 || ""),
          savedAt: String(entry?.savedAt || ""),
        };
      }
      return result;
    },

    /**
     * 明文密钥，只给 desktop/ipc/ai.mjs 发测试请求用（以后几张单的主进程
     * 调用也走这里）；不进任何返回值、日志、错误信息。没填或解不开回 null。
     */
    async readForRequest(serviceId) {
      const data = await readCredentialFile(filePath);
      const entry = data.services?.[serviceId];
      if (!entry) return null;
      return decryptEntry(entry);
    },
  };
}
