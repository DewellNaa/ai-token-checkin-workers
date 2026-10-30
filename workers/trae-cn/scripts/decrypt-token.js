#!/usr/bin/env node
/**
 * Trae CN 令牌提取 —— 从本地 storage.json 解密登录态。
 *
 * 加密格式：
 *   base64 → [6 字节头 tc\x05\x10\x00\x00][32 字节随机数][AES-128-CBC 密文]
 *   密钥派生：derived = SHA512( SHA512(random) || (SALT_A XOR SALT_B) )
 *              key = derived[0:16], iv = derived[16:32]
 *   明文 = [64 字节 SHA-512 校验][JSON 正文]
 *
 * 依赖：仅 Node.js 内置 crypto，无第三方包依赖。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// 客户端内置解密常量
const SALT_A = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const SALT_B = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);
const HEADER_AES = Buffer.from([116, 99, 5, 16, 0, 0]);
const HEADER_AES_PRIVATE = Buffer.from([18, 57, 32, 32, 2, 3]);

const AUTH_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
const DC_KEY_PREFIX = "iCubeAuthInfo://icube-dc:";

function xor(a, b) {
  return Buffer.from(a.map((v, i) => v ^ (b[i] ?? 0)));
}

function decryptTraeStorageValue(encoded) {
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length <= 102) throw new Error("密文太短（<= 102 字节）");

  const header = buffer.subarray(0, 6);
  if (header.equals(HEADER_AES_PRIVATE)) {
    throw new Error("aes-private 加密格式暂不支持");
  }
  if (!header.equals(HEADER_AES)) throw new Error("不支持的加密头部格式");

  const random = buffer.subarray(6, 38);
  const encrypted = buffer.subarray(38);

  const salt = xor(SALT_A, SALT_B);
  const first = crypto.createHash("sha512").update(random).digest();
  const derived = crypto
    .createHash("sha512")
    .update(Buffer.concat([first, salt]))
    .digest();

  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    derived.subarray(0, 16),
    derived.subarray(16, 32)
  );
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (decrypted.length < 64) throw new Error("明文太短，完整性校验失败");

  const expectedHash = decrypted.subarray(0, 64);
  const plaintext = decrypted.subarray(64);
  const actualHash = crypto.createHash("sha512").update(plaintext).digest();
  if (!expectedHash.equals(actualHash)) throw new Error("完整性校验失败（SHA-512 不匹配）");

  return plaintext.toString("utf8");
}

function storageCandidates() {
  const home = os.homedir();
  const ap = process.env.APPDATA || "";
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const appNames = ["TRAE SOLO CN", "Trae CN", "TRAE SOLO", "Trae"];
  const editions = ["solo", "cn", "solo-sg", "sg"];

  let roots;
  if (process.platform === "darwin") {
    roots = appNames.map((a) => path.join(home, "Library", "Application Support", a));
  } else if (process.platform === "win32") {
    roots = appNames.map((a) => path.join(ap, a));
  } else {
    roots = appNames.map((a) => path.join(xdg, a));
  }

  return roots.map((root, i) => ({
    root,
    appName: appNames[i],
    edition: editions[i],
    storagePath: path.join(root, "User", "globalStorage", "storage.json"),
  }));
}

function extractDeviceId(storage) {
  for (const k of Object.keys(storage)) {
    if (k.startsWith(DC_KEY_PREFIX)) return k.slice(DC_KEY_PREFIX.length);
  }
  if (storage["telemetry.devDeviceId"]) return storage["telemetry.devDeviceId"];
  const mid = storage["telemetry.machineId"];
  if (mid) return crypto.createHash("sha256").update(mid).digest("hex").slice(0, 32);
  return "";
}

function main() {
  const manual = process.env.TRAE_CHECKIN_STORAGE;
  let candidates = storageCandidates();
  if (manual) {
    candidates = [{
      root: path.dirname(path.dirname(path.dirname(manual))),
      appName: "custom", edition: "custom", storagePath: manual,
    }];
  }
  if (process.env.TRAE_CHECKIN_APP) {
    candidates = candidates.filter((c) => c.appName === process.env.TRAE_CHECKIN_APP);
  }

  let lastError = "";
  const found = [];

  for (const cand of candidates) {
    if (!fs.existsSync(cand.storagePath)) continue;
    try {
      const storage = JSON.parse(fs.readFileSync(cand.storagePath, "utf8"));
      const encrypted = storage[AUTH_STORAGE_KEY];
      if (!encrypted || typeof encrypted !== "string") {
        lastError = `${cand.appName}: 缺少 ${AUTH_STORAGE_KEY}`;
        continue;
      }
      const plaintext = encrypted.startsWith("{")
        ? encrypted
        : decryptTraeStorageValue(encrypted);
      const auth = JSON.parse(plaintext);
      const token = auth.token || auth.accessToken;
      if (!token) { lastError = `${cand.appName}: 解密后没有 token`; continue; }

      found.push({
        token,
        refreshToken: auth.refreshToken || "",
        expiredAt: auth.expiredAt || "",
        refreshExpiredAt: auth.refreshExpiredAt || "",
        userId: auth.userId || "",
        deviceId: extractDeviceId(storage),
        edition: cand.edition,
        appName: cand.appName,
        expiresAtMs: auth.expiredAt ? Date.parse(auth.expiredAt) : 0,
      });
    } catch (e) {
      lastError = `${cand.appName}: ${e.message}`;
    }
  }

  if (!found.length) {
    process.stderr.write("未找到有效的 Trae 本地登录态（" + lastError + "）\n");
    return 1;
  }

  const now = Date.now();
  const valid = found.filter((f) => f.expiresAtMs && f.expiresAtMs > now);
  const pool = valid.length ? valid : found;
  pool.sort((a, b) => (b.expiresAtMs || 0) - (a.expiresAtMs || 0));
  const best = pool[0];

  const lines = [
    "DECRYPT_RESULT:" + best.token,
    "REFRESH_RESULT:" + best.refreshToken,
    "DEVICE_ID:" + best.deviceId,
    "USER_ID:" + best.userId,
    "EXPIRED_AT:" + best.expiredAt,
    "REFRESH_EXPIRED_AT:" + best.refreshExpiredAt,
    "EDITION:" + best.edition,
    "APP:" + best.appName,
    "CANDIDATES:" + found.map((f) => `${f.appName}@${f.expiredAt || "?"}`).join(","),
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

process.exit(main());
