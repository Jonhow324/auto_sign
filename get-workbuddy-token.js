'use strict';
/**
 * 单独提取 WorkBuddy/CodeBuddy CN 的 accessToken 和 uid
 * 从 %APPDATA%/CodeBuddy CN 的 state.vscdb + Local State 解密
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const APPDATA = process.env.APPDATA;

function resolveProfileRoot(names, requiredFiles) {
  for (const name of names) {
    const root = path.join(APPDATA, name);
    if (requiredFiles.every(file => fs.existsSync(path.join(root, file)))) return root;
  }
  return path.join(APPDATA, names[0]);
}

// 注意：必须用 VS Code 官方 CodeBuddy 扩展的登录态（带 oneid_union_id/token_source 声明），
// CodeBuddy CN IDE 的 planning-genie 离线 token 会被 workbuddy.cn 网关 401 拒绝
const CB_ROOT = resolveProfileRoot(
  ['Code', 'WorkBuddy', 'CodeBuddy', 'CodeBuddy CN'],
  [
    path.join('User', 'globalStorage', 'state.vscdb'),
    'Local State'
  ]
);
const CB_VSCDB = path.join(CB_ROOT, 'User', 'globalStorage', 'state.vscdb');
const CB_LOCAL_STATE = path.join(CB_ROOT, 'Local State');

const CB_SECRET_KEY = 'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"Tencent-Cloud.coding-copilot.new.accessToken"}';

// ---- 最小 SQLite 读取器 ----
function readVarint(buf, off) {
  let result = 0;
  for (let i = 0; i < 9; i++) {
    const b = buf[off + i];
    if (i === 8) { result = result * 256 + b; return [result, off + 9]; }
    result = (result << 7) | (b & 0x7f);
    if (!(b & 0x80)) return [result, off + i + 1];
  }
}

function readSqliteItemTable(fileBuf) {
  const pageSize = fileBuf.readUInt16BE(16);
  const reserved = fileBuf[20];
  const pageCount = Math.floor(fileBuf.length / pageSize);
  const U = pageSize - reserved;
  const X = U - 35;
  const M = Math.floor(((U - 12) * 32) / 255);

  const rows = [];
  for (let pgno = 1; pgno <= pageCount; pgno++) {
    const base = (pgno - 1) * pageSize;
    const pageType = fileBuf[base + (pgno === 1 ? 100 : 0)];
    if (pageType !== 0x0d) continue;

    const headerStart = base + (pgno === 1 ? 100 : 0);
    const cellCount = fileBuf.readUInt16BE(headerStart + 3);
    const contentStartRel = fileBuf.readUInt16BE(headerStart + 5);
    const contentStart = contentStartRel === 0 ? base + U : base + contentStartRel;

    for (let c = 0; c < cellCount; c++) {
      const cellPtrRel = fileBuf.readUInt16BE(headerStart + 8 + c * 2);
      if (cellPtrRel === 0 || cellPtrRel >= U) continue;
      let off = base + cellPtrRel;

      try {
        let payloadLen;
        [payloadLen, off] = readVarint(fileBuf, off);
        let rowid;
        [rowid, off] = readVarint(fileBuf, off);
        if (!Number.isFinite(payloadLen) || payloadLen <= 0 || payloadLen > fileBuf.length) continue;

        let K;
        if (payloadLen <= X) K = payloadLen;
        else {
          K = M + ((payloadLen - M) % (U - 4));
          if (K > X) K = M;
        }
        if (off + K > base + U) continue;

        let payload = fileBuf.subarray(off, off + K);
        if (payloadLen > K) {
          let nextPage = fileBuf.readUInt32BE(off + K);
          const parts = [payload];
          let remaining = payloadLen - K;
          let guard = 0;
          while (nextPage !== 0 && remaining > 0 && guard++ < 10000) {
            if (nextPage < 1 || nextPage > pageCount) throw new Error('overflow 页号越界');
            const oBase = (nextPage - 1) * pageSize;
            const next = fileBuf.readUInt32BE(oBase);
            const take = Math.min(U - 4, remaining);
            parts.push(fileBuf.subarray(oBase + 4, oBase + 4 + take));
            remaining -= take;
            nextPage = remaining > 0 ? next : 0;
          }
          payload = Buffer.concat(parts);
        }
        if (payload.length !== payloadLen) continue;

        const [headerLen, hEnd] = readVarint(payload, 0);
        let p = hEnd;
        const serials = [];
        while (p < headerLen) {
          const [s, np] = readVarint(payload, p);
          serials.push(s); p = np;
        }
        let body = headerLen;
        const cols = [];
        let bad = false;
        for (const s of serials) {
          if (s === 0) { cols.push(null); continue; }
          let len = 0;
          if (s >= 13 && s % 2 === 1) len = (s - 13) / 2;
          else if (s >= 12 && s % 2 === 0) len = (s - 12) / 2;
          else if (s === 1) len = 1;
          else if (s === 2) len = 2;
          else if (s === 3) len = 3;
          else if (s === 4) len = 4;
          else if (s === 5) len = 6;
          else if (s === 6) len = 8;
          else if (s >= 7 && s <= 9) { cols.push(null); continue; }
          else { bad = true; break; }
          if (body + len > payload.length) { bad = true; break; }
          cols.push(payload.subarray(body, body + len));
          body += len;
        }
        if (!bad && cols.length >= 2 && cols[0]) {
          rows.push({ key: cols[0].toString('utf8'), value: cols[1] });
        }
      } catch {}
    }
  }
  return rows;
}

// ---- DPAPI 解密 ----
function dpapiDecrypt(blobBuf) {
  const bin = path.join(os.tmpdir(), `dpapi_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(bin, blobBuf);
  try {
    const ps = `Add-Type -AssemblyName System.Security;` +
      `$b=[IO.File]::ReadAllBytes('${bin}');` +
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, {
      timeout: 20000, encoding: 'utf8'
    }).trim();
    return Buffer.from(out, 'base64');
  } finally {
    try { fs.unlinkSync(bin); } catch {}
  }
}

// ---- Chromium OSCrypt AES-256-GCM 解密 ----
function chromiumDecrypt(encryptedBuf, aesKey) {
  if (encryptedBuf.subarray(0, 3).toString('latin1') !== 'v10') {
    throw new Error('密文不是 v10 格式');
  }
  const nonce = encryptedBuf.subarray(3, 15);
  const tag = encryptedBuf.subarray(encryptedBuf.length - 16);
  const data = encryptedBuf.subarray(15, encryptedBuf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ---- 主流程 ----
function readWorkBuddy() {
  console.log('[WorkBuddy] 数据目录:', CB_ROOT);

  const dbBuf = fs.readFileSync(CB_VSCDB);
  const rows = readSqliteItemTable(dbBuf);

  const hit = rows.find(r => r.key === CB_SECRET_KEY);
  if (!hit) throw new Error('state.vscdb 中未找到 accessToken（确认 CodeBuddy CN 已登录）');

  const wrapped = JSON.parse(hit.value.toString('utf8'));
  const encrypted = Buffer.from(wrapped.data);

  const localState = JSON.parse(fs.readFileSync(CB_LOCAL_STATE, 'utf8'));
  const encKeyRaw = Buffer.from(localState.os_crypt.encrypted_key, 'base64');
  if (encKeyRaw.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new Error('Local State 密钥格式异常');
  }
  const aesKey = dpapiDecrypt(encKeyRaw.subarray(5));

  const plain = chromiumDecrypt(encrypted, aesKey);
  console.log('\n[WorkBuddy] 解密结果:');
  console.log(plain);

  let accessToken = '';
  try {
    const j = JSON.parse(plain);
    accessToken = j?.auth?.accessToken || j?.accessToken || j?.token || '';
  } catch {}

  if (!accessToken) throw new Error('未找到 accessToken');

  console.log('\n================ 结果 ================');
  console.log('accessToken:', accessToken);
  console.log('accessToken 长度:', accessToken.length);

  return { accessToken };
}

try {
  const result = readWorkBuddy();
  console.log('\n✅ 成功！把上面的值填到 .env：');
  console.log('   WORKBUDDY_ACCESS_TOKEN=' + result.accessToken);
} catch (e) {
  console.error('\n❌ 失败:', e.message);
  process.exitCode = 1;
}
