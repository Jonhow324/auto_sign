'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ENV_FILE = path.join(__dirname, '.env');

function loadEnv(file) {
  const values = {};
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function request(method, url, headers = {}, body = {}) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(raw); } catch {}
        resolve({ http: res.statusCode, json, raw });
      });
    });
    req.on('error', (error) => resolve({ error: error.message }));
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
    if (method === 'GET') req.end();
    else { req.write(payload); req.end(); }
  });
}

async function main() {
  const config = loadEnv(ENV_FILE);
  const token = config.WORKBUDDY_ACCESS_TOKEN;
  const uid = config.WORKBUDDY_UID;

  if (!token || !uid) { console.log('缺少 token 或 uid'); return; }

  const base = 'https://www.codebuddy.cn';
  const headers_base = { 'X-User-Id': String(uid) };

  // 测试 1: 纯 JWT
  console.log('--- 测试 1: Bearer + 纯 JWT ---');
  const r1 = await request('POST', `${base}/v2/billing/meter/checkin-activity-status`, {
    ...headers_base,
    Authorization: `Bearer ${token}`
  });
  console.log('HTTP:', r1.http, r1.json?.code || r1.raw?.slice(0, 100));

  // 测试 2: uid+JWT 复合 token
  const compositeToken = `${uid}+${token}`;
  console.log('\n--- 测试 2: Bearer + uid+JWT 复合 token ---');
  const r2 = await request('POST', `${base}/v2/billing/meter/checkin-activity-status`, {
    ...headers_base,
    Authorization: `Bearer ${compositeToken}`
  });
  console.log('HTTP:', r2.http, r2.json?.code || r2.raw?.slice(0, 100));

  // 测试 3: 不带 Bearer 前缀
  console.log('\n--- 测试 3: 不带 Bearer 前缀 ---');
  const r3 = await request('POST', `${base}/v2/billing/meter/checkin-activity-status`, {
    ...headers_base,
    Authorization: token
  });
  console.log('HTTP:', r3.http, r3.json?.code || r3.raw?.slice(0, 100));
}

main().catch(console.error);
