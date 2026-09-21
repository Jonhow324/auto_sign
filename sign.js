'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env');
const LOG_FILE = path.join(ROOT, 'sign.log');
const RETRY_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 10000;

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

function required(config, key) {
  if (!config[key]) throw new Error(`.env 缺少 ${key}`);
  return config[key];
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
        resolve({ http: res.statusCode || 0, json, raw });
      });
    });

    req.on('error', (error) => resolve({ error: error.message }));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('请求超时')));
    if (method === 'GET') req.end();
    else {
      req.write(payload);
      req.end();
    }
  });
}

function responseMessage(result) {
  if (result.error) return `网络错误: ${result.error}`;
  if (result.json) return JSON.stringify(result.json).slice(0, 300);
  return `HTTP ${result.http}: ${(result.raw || '').slice(0, 300)}`;
}

async function signWorkBuddy(config) {
  const token = required(config, 'WORKBUDDY_ACCESS_TOKEN');
  const uid = required(config, 'WORKBUDDY_UID');
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-User-Id': String(uid)
  };
  const base = 'https://www.codebuddy.cn';

  const status = await request(
    'POST',
    `${base}/v2/billing/meter/checkin-activity-status`,
    headers
  );
  if (status.error || status.json?.code !== 0) {
    return { ok: false, message: responseMessage(status) };
  }
  if (status.json.data?.today_checked_in === true) {
    return { ok: true, message: '今日已签到' };
  }

  const claim = await request(
    'POST',
    `${base}/v2/billing/meter/daily-checkin`,
    headers
  );
  if (claim.json?.code === 0) {
    const credit = claim.json.data?.credit || 0;
    const streak = claim.json.data?.streak_days || 0;
    return { ok: true, message: `签到成功 +${credit} 积分, 连签${streak}天` };
  }
  if (claim.json?.code === 10001) {
    return { ok: true, message: '今日已签到' };
  }
  return { ok: false, message: responseMessage(claim) };
}

async function signQoder(config) {
  const token = required(config, 'QODER_ACCESS_TOKEN');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Cosy-ClientType': '10'
  };
  const base = 'https://openapi.qoder.com.cn';

  const list = await request('GET', `${base}/sash/api/v1/me/campaigns`, headers);
  if (list.error || list.http !== 200 || !list.json) {
    return { ok: false, message: responseMessage(list) };
  }
  if (list.json.claimable !== true) {
    return { ok: true, message: '今日无待领取活动或活动未开启' };
  }

  const campaigns = (list.json.campaigns || []).filter((campaign) =>
    campaign &&
    campaign.actionType === 'CLAIM_BENEFIT' &&
    campaign.claimStatus === 'CLAIMABLE'
  );
  if (campaigns.length === 0) {
    return { ok: true, message: '今日已签到' };
  }

  let claimed = 0;
  let totalCredit = 0;
  for (const campaign of campaigns) {
    const claim = await request(
      'POST',
      `${base}/sash/api/v1/me/campaigns/${encodeURIComponent(campaign.campaignId)}/claim`,
      headers
    );
    if (claim.json?.status === 'CLAIMED') {
      claimed++;
      totalCredit += Number(campaign.benefit?.amount || 0);
    } else if (claim.json?.replayed !== true) {
      return { ok: false, message: responseMessage(claim) };
    }
  }

  return {
    ok: true,
    message: claimed > 0
      ? `签到成功 +${totalCredit} Credits, 共${claimed}项`
      : '今日已签到'
  };
}

function writeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
}

async function runWithOneRetry(name, action) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await action();
      if (result.ok || attempt === 2) {
        writeLog(`【${name}】${result.ok ? '成功' : '失败'}: ${result.message}`);
        return result.ok;
      }
      writeLog(`【${name}】第 1 次失败，${RETRY_DELAY_MS}ms 后重试: ${result.message}`);
    } catch (error) {
      if (attempt === 2) {
        writeLog(`【${name}】失败: ${error.message}`);
        return false;
      }
      writeLog(`【${name}】第 1 次异常，${RETRY_DELAY_MS}ms 后重试: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  return false;
}

async function main() {
  let config;
  try {
    config = loadEnv(ENV_FILE);
  } catch (error) {
    console.error(`无法读取 ${ENV_FILE}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  writeLog('开始执行签到');
  const results = await Promise.all([
    runWithOneRetry('WorkBuddy', () => signWorkBuddy(config)),
    runWithOneRetry('Qoder', () => signQoder(config))
  ]);
  const success = results.every(Boolean);
  writeLog(success ? '本次签到执行完成' : '本次签到存在失败平台');
  process.exitCode = success ? 0 : 1;
}

main().catch((error) => {
  writeLog(`脚本异常: ${error.message}`);
  process.exitCode = 1;
});
