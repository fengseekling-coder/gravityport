// 任务 458：AI 密钥保存的行为测试——真模块（desktop/ai/credential-store.mjs）
// + 假加密层/假 safeStorage，目录全在 os.tmpdir()。假密钥一律 sk-test- 开头。
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  chooseAiEncryption,
  createAiCredentialStore,
  createQaAiEncryptionStub,
  createSafeStorageAiEncryption,
} from "../desktop/ai/credential-store.mjs";

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE_KEY = `sk-test-${"0".repeat(30)}1234`;
// 去掉前缀后的那一串（单子要求原始字节里连它都搜不到）。
const FAKE_KEY_BODY = FAKE_KEY.slice("sk-test-".length);

// 记录每次 encrypt/decrypt 入参的假加密层（可逆，便于整链路断言）。
function recordingEncryption() {
  const calls = { encrypt: [], decrypt: [] };
  return {
    calls,
    isAvailable: () => true,
    encrypt(text) {
      calls.encrypt.push(text);
      return Buffer.from(`enc:${Buffer.from(String(text), "utf8").toString("base64")}`, "utf8");
    },
    decrypt(buffer) {
      const text = Buffer.from(buffer).toString("utf8");
      calls.decrypt.push(text);
      if (!text.startsWith("enc:")) throw new Error("boom");
      return Buffer.from(text.slice("enc:".length), "base64").toString("utf8");
    },
  };
}

test("存密钥：last4 正确、原始字节里搜不到完整密钥和去前缀的串、权限 0o600", async (t) => {
  const dir = await makeTempDir(t, "ai-cred-save-");
  const encryption = recordingEncryption();
  const store = createAiCredentialStore({ dir, encryption });
  const result = await store.save("claude", FAKE_KEY);
  assert.deepEqual(result, { ok: true, last4: "1234" });
  assert.deepEqual(encryption.calls.encrypt, [FAKE_KEY], "encrypt 收到的必须是原文");

  const path = join(dir, "ai-credentials.json");
  const raw = await readFile(path, "utf8");
  assert.ok(!raw.includes(FAKE_KEY), "原始字节里不能有完整假密钥");
  assert.ok(!raw.includes(FAKE_KEY_BODY), "原始字节里不能有去前缀后的那一串");
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600, "文件权限必须是 0o600");
  }
  const status = await store.status();
  assert.deepEqual(status, { claude: { hasKey: true, last4: "1234", savedAt: status.claude.savedAt } });
  assert.match(status.claude.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(await store.readForRequest("claude"), FAKE_KEY);
  assert.equal(await store.readForRequest("openai"), null);
});

test("remove 之后 status 为没填；解密抛错时该服务算没填、不抛出", async (t) => {
  const dir = await makeTempDir(t, "ai-cred-remove-");
  const store = createAiCredentialStore({ dir, encryption: recordingEncryption() });
  await store.save("claude", FAKE_KEY);
  assert.deepEqual(await store.remove("claude"), { ok: true });
  assert.deepEqual(await store.status(), {});
  assert.equal(await store.readForRequest("claude"), null);

  // 换电脑 / 钥匙串被清：解密抛错 → 当作没填。
  const brokenStore = createAiCredentialStore({
    dir,
    encryption: {
      isAvailable: () => true,
      encrypt: () => Buffer.from("enc:AAAA", "utf8"),
      decrypt: () => { throw new Error("keychain gone"); },
    },
  });
  await brokenStore.save("openai", FAKE_KEY);
  const status = await brokenStore.status();
  assert.equal(status.openai.hasKey, false, "解不开的条目当作没填");
  assert.equal(await brokenStore.readForRequest("openai"), null);
});

test("拒绝无效密钥：空、超 512、中间含空白或控制字符", async (t) => {
  const dir = await makeTempDir(t, "ai-cred-invalid-");
  const store = createAiCredentialStore({ dir, encryption: recordingEncryption() });
  const invalid = ["", "   ", `${"0".repeat(513)}`, "sk-test- has space", "sk-test-\tTab", "sk-test-\u0007bell"];
  for (const key of invalid) {
    assert.deepEqual(await store.save("claude", key), { ok: false, reason: "invalid-key" }, JSON.stringify(key));
  }
  assert.deepEqual(await store.status(), {}, "拒收的密钥不能落盘");
  // 首尾空白被去掉后照常收。
  assert.deepEqual(await store.save("claude", `  ${FAKE_KEY}  `), { ok: true, last4: "1234" });
});

test("加密不可用时拒收且不落盘", async (t) => {
  const dir = await makeTempDir(t, "ai-cred-unavail-");
  const store = createAiCredentialStore({
    dir,
    encryption: { isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" },
  });
  assert.deepEqual(await store.save("claude", FAKE_KEY), { ok: false, reason: "encryption-unavailable" });
  assert.equal(existsSync(join(dir, "ai-credentials.json")), false, "目录里不能出现新文件");
  assert.deepEqual(await readdir(dir), []);
});

test("chooseAiEncryption：quietQaRun=false 拿到 safeStorage 包装、true 才是替身", async (t) => {
  const fakeSafeStorageCalls = [];
  // Shaped like Electron's real safeStorage, including the backend query that
  // the Linux rule reads; without it this test only passed on macOS/Windows.
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (text) => {
      fakeSafeStorageCalls.push(text);
      return Buffer.from("safe", "utf8");
    },
    decryptString: () => "plain",
  };
  const real = chooseAiEncryption({ quietQaRun: false, safeStorage: fakeSafeStorage });
  assert.equal(real.isAvailable(), true);
  const cipher = real.encrypt(FAKE_KEY);
  assert.deepEqual(fakeSafeStorageCalls, [FAKE_KEY], "encrypt 必须落在 safeStorage 上");
  assert.equal(Buffer.from(cipher).toString("utf8"), "safe");

  const stub = chooseAiEncryption({ quietQaRun: true, safeStorage: fakeSafeStorage });
  assert.deepEqual(fakeSafeStorageCalls, [FAKE_KEY], "替身不得再碰 safeStorage");
  assert.equal(stub.isAvailable(), true);
  const roundTrip = stub.decrypt(stub.encrypt(FAKE_KEY));
  assert.equal(roundTrip, FAKE_KEY);

  // 替身与 safeStorage 包装是两个不同的实现。
  assert.notEqual(real.encrypt, stub.encrypt);
});

test("safeStorage 适配层：Linux 只认系统钥匙串后端，basic_text / unknown / 空值算不可用", (t) => {
  const makeFake = (backend) => ({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: () => Buffer.alloc(0),
  });
  assert.equal(createSafeStorageAiEncryption(makeFake("gnome_keyring"), { platform: "linux" }).isAvailable(), true);
  assert.equal(createSafeStorageAiEncryption(makeFake("kwallet"), { platform: "linux" }).isAvailable(), true);
  assert.equal(createSafeStorageAiEncryption(makeFake("basic_text"), { platform: "linux" }).isAvailable(), false);
  assert.equal(createSafeStorageAiEncryption(makeFake("unknown"), { platform: "linux" }).isAvailable(), false);
  assert.equal(createSafeStorageAiEncryption(makeFake("gnome_libsecret"), { platform: "linux" }).isAvailable(), true);
  assert.equal(createSafeStorageAiEncryption(makeFake("kwallet6"), { platform: "linux" }).isAvailable(), true);
  // Electron 未就绪时的 ""、undefined、以后新出的未知值：一律不可用（11-23 Claude 裁）。
  assert.equal(createSafeStorageAiEncryption(makeFake(""), { platform: "linux" }).isAvailable(), false);
  assert.equal(createSafeStorageAiEncryption(makeFake(undefined), { platform: "linux" }).isAvailable(), false);
  assert.equal(createSafeStorageAiEncryption(makeFake("some_future_backend"), { platform: "linux" }).isAvailable(), false);
  // Linux 上连查后端的方法都没有：不可用。
  assert.equal(createSafeStorageAiEncryption({ isEncryptionAvailable: () => true }, { platform: "linux" }).isAvailable(), false);
  // 非 Linux 平台不查后端（注入本机平台时 basic_text 也可用——后端规则只在 Linux）。
  assert.equal(createSafeStorageAiEncryption(makeFake("basic_text"), { platform: "darwin" }).isAvailable(), true);
  // isEncryptionAvailable 本身为假（或抛错）时不可用。
  assert.equal(createSafeStorageAiEncryption({ isEncryptionAvailable: () => false }).isAvailable(), false);
  assert.equal(createSafeStorageAiEncryption({
    isEncryptionAvailable: () => { throw new Error("not ready"); },
    getSelectedStorageBackend: () => "gnome_keyring",
  }).isAvailable(), false);
  // 缺 safeStorage 对象也不可用。
  assert.equal(createSafeStorageAiEncryption(null).isAvailable(), false);
  // 替身永远可用（只在 quietQaRun=true 时被选中）。
  assert.equal(createQaAiEncryptionStub().isAvailable(), true);
});
