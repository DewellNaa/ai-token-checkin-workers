/**
 * Qoder CN 每日自动领取 Credits（Cloudflare Worker + Cron Trigger）
 *
 * 活动规则：Qoder CN 每日可领取 100 通用 Credits（资源包额度，30 天有效期）。
 * 开放窗口：每日北京时间 10:00 - 次日 10:00。
 *
 * 接口：
 *   GET  /sash/api/v1/me/campaigns                      查活动列表
 *   POST /sash/api/v1/me/campaigns/{campaignId}/claim    领取（幂等）
 *
 * 必需请求头（缺 Cosy-ClientType 服务端会返回空活动列表）：
 *   Accept: application/json
 *   User-Agent: Qoder/claim
 *   Cosy-ClientType: 10
 */

const BASE_URL = 'https://openapi.qoder.com.cn';
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';
const KV_KEY = 'QODER_SESSION';
const OPEN_HOUR_BJ = 10;

const BASE_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Qoder/claim',
  'Cosy-ClientType': '10',
  'Content-Type': 'application/json',
};

function mask(v) {
  if (!v) return '(empty)';
  const s = String(v);
  return s.slice(0, 4) + '***' + s.slice(-3) + `(len=${s.length})`;
}

function beijingNow(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  return { hour: bj.getUTCHours(), minute: bj.getUTCMinutes(), iso: bj.toISOString() };
}

async function api(path, token, method = 'GET') {
  const headers = { ...BASE_HEADERS };
  headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  const resp = await fetch(BASE_URL + path, {
    method,
    headers,
    body: method === 'POST' ? '{}' : undefined,
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: resp.status, json, text: text.slice(0, 200) };
}

export default {
  async scheduled(event, env, ctx) {
    console.log('cron fired at', new Date().toISOString(), 'cron =', event.cron);
    try {
      const result = await run(env);
      console.log('cron result:', JSON.stringify(result));
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error('cron error:', msg);
      try {
        const rec = (await env.Q.get(KV_KEY, 'json')) || {};
        await env.Q.put(KV_KEY, JSON.stringify({
          ...rec,
          lastResult: { at: new Date().toISOString(), ok: false, step: 'cron', msg: msg.slice(0, 200) },
        }));
      } catch (e) { /* ignore */ }
      throw err;
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const adminKey = env.ADMIN_KEY || '';

    if (url.pathname === '/claim') {
      if (!adminKey || url.searchParams.get('key') !== adminKey) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      const tokenOverride = url.searchParams.get('token');
      const result = await run(env, tokenOverride);
      return json(result);
    }

    if (url.pathname === '/status') {
      const rec = (await env.Q.get(KV_KEY, 'json')) || {};
      return json({
        token: mask(rec.token),
        tokenSet: !!rec.token,
        lastResult: rec.lastResult || null,
      });
    }

    return new Response(
      'Qoder CN daily credits claimer\n' +
      '  schedule: daily 10:05 Asia/Shanghai\n' +
      '  GET /status  -> last result (masked)\n' +
      '  GET /claim?key=...&token=...  -> manual run\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function run(env, tokenOverride) {
  const now = new Date();
  const bj = beijingNow(now);
  let record = (await env.Q.get(KV_KEY, 'json')) || {};

  const token = (tokenOverride || record.token || '').trim();
  if (!token) {
    const err = {
      at: now.toISOString(), ok: false, step: 'init',
      msg: 'no token in KV; run scripts/refresh_qoder_token.py to push token',
    };
    await env.Q.put(KV_KEY, JSON.stringify({ ...record, lastResult: err }));
    return err;
  }

  // 未到开放时间不发请求
  if (bj.hour < OPEN_HOUR_BJ) {
    const skip = {
      at: now.toISOString(), ok: true, step: 'skipped',
      claim: 'before-open-window',
      note: `北京 ${bj.hour}:${String(bj.minute).padStart(2, '0')} 未到 ${OPEN_HOUR_BJ}:00，当日活动未开放`,
    };
    await env.Q.put(KV_KEY, JSON.stringify({ ...record, token, lastResult: skip }));
    return skip;
  }

  const list = await api(CAMPAIGNS_PATH, token, 'GET');
  if (list.status !== 200 || !list.json) {
    const err = {
      at: now.toISOString(), ok: false, step: 'campaigns',
      msg: `HTTP ${list.status}: ${list.text}`,
    };
    await env.Q.put(KV_KEY, JSON.stringify({ ...record, token, lastResult: err }));
    return err;
  }

  const campaigns = Array.isArray(list.json.campaigns) ? list.json.campaigns : [];
  const benefit = campaigns.filter((c) => c && c.actionType === 'CLAIM_BENEFIT');
  const pending = benefit.filter((c) => c.claimStatus !== 'CLAIMED');

  let claimMsg = 'already-claimed';
  let credits = null;
  let campaignId = null;

  if (pending.length) {
    const target = pending[0];
    campaignId = target.campaignId || target.campaign || target.id;
    const r = await api(`${CAMPAIGNS_PATH}/${campaignId}/claim`, token, 'POST');
    if (r.status === 200 && r.json && (r.json.claimStatus === 'CLAIMED' || r.json.status === 'CLAIMED')) {
      claimMsg = 'claimed';
      credits = (r.json.credits !== undefined ? r.json.credits : 100);
    } else if (r.json && /already|claimed/i.test(JSON.stringify(r.json))) {
      claimMsg = 'already-claimed';
    } else {
      claimMsg = `claim-failed HTTP${r.status}: ${r.text.slice(0, 120)}`;
    }
  }

  const result = {
    at: now.toISOString(),
    ok: claimMsg === 'claimed' || claimMsg === 'already-claimed',
    step: 'done',
    claim: claimMsg,
    credits,
    campaignId,
    campaigns_seen: campaigns.length,
    benefit_total: benefit.length,
    benefit_pending: pending.length,
    beijing_time: bj.iso,
    token: mask(token),
  };

  await env.Q.put(KV_KEY, JSON.stringify({ ...record, token, lastResult: result }));
  return result;
}
