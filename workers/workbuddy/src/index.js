/**
 * WorkBuddy 每日自动签到（Cloudflare Worker + Cron Trigger）
 *
 * 流程：
 *   1. 从 KV 取 refresh_token
 *   2. 换 access_token（顺带拿到轮换后的新 refresh_token，回写 KV）
 *   3. 查签到状态；未签到则领取
 *   4. 结果写入 KV 便于查看
 *
 * 设计要点：
 *   - access_token 有效期 30 天，缓存在 KV，只有过期才 refresh，
 *     避免每天轮换令牌与桌面客户端「抢令牌」导致客户端掉线。
 *   - 域名白名单：只请求官方域名。
 *   - 令牌全链路脱敏：不写日志、不出现在错误信息里。
 */

const API_HOST = 'https://copilot.tencent.com';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';
const STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
const CHECKIN_PATH = '/v2/billing/meter/daily-checkin';
const ALLOWED_HOSTS = ['copilot.tencent.com', 'www.workbuddy.cn'];

const KV_KEY = 'WB_SESSION';

function mask(v) {
  if (!v) return '(empty)';
  const s = String(v);
  return s.slice(0, 6) + '***' + s.slice(-4) + `(len=${s.length})`;
}

async function postJson(path, headers) {
  const url = new URL(path, API_HOST);
  if (!ALLOWED_HOSTS.includes(url.hostname)) {
    throw new Error('host not allowed: ' + url.hostname);
  }
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: '{}',
  });
  const text = await resp.text();
  try {
    return { status: resp.status, json: JSON.parse(text) };
  } catch {
    return { status: resp.status, json: { code: -1, msg: 'non-JSON response: ' + text.slice(0, 120) } };
  }
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
        const rec = (await env.WB.get(KV_KEY, 'json')) || {};
        await env.WB.put(KV_KEY, JSON.stringify({
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

    if (url.pathname === '/checkin') {
      if (!adminKey || url.searchParams.get('key') !== adminKey) {
        return new Response(JSON.stringify({
          ok: false, error: 'unauthorized',
          hint: 'pass ?key=<ADMIN_KEY> (see wrangler secret ADMIN_KEY)',
        }), { status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      }
      const override = url.searchParams.get('token');
      const result = await run(env, override);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    if (url.pathname === '/status') {
      const rec = await env.WB.get(KV_KEY, 'json');
      if (!rec) {
        return new Response(JSON.stringify({ note: 'no record yet' }, null, 2), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      return new Response(JSON.stringify({
        refreshToken: mask(rec.refreshToken),
        accessToken: mask(rec.accessToken),
        accessTokenExpiresAt: rec.accessTokenExpiresAt,
        accessTokenValid: Date.now() < (rec.accessTokenExpiresAt || 0),
        lastResult: rec.lastResult || null,
      }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    return new Response(
      'WorkBuddy checkin worker\n' +
      '  schedule: daily 08:07 (Asia/Shanghai) via Cloudflare Cron Trigger\n' +
      '  GET /status  -> last result (masked)\n' +
      '  GET /checkin?key=...  -> manual run\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};

async function run(env, tokenOverride) {
  const now = new Date().toISOString();
  let record = await env.WB.get(KV_KEY, 'json');
  record = record || {};

  let refreshToken = tokenOverride || record.refreshToken;
  if (!refreshToken) {
    const err = { at: now, ok: false, step: 'init', msg: 'no refresh_token in KV' };
    await env.WB.put(KV_KEY, JSON.stringify({ ...record, lastResult: err }));
    return err;
  }

  let accessToken = record.accessToken;
  const expiresAt = record.accessTokenExpiresAt || 0;

  // access token 未过期且还有 1 天余量 → 直接复用，避免每日抢令牌轮换
  if (!accessToken || Date.now() > expiresAt - 86400000) {
    const r = await postJson(REFRESH_PATH, {
      'X-Refresh-Token': refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
    });
    if (r.status !== 200 || !r.json || r.json.code !== 0) {
      const err = {
        at: now, ok: false, step: 'refresh',
        httpStatus: r.status,
        code: r.json && r.json.code,
        msg: (r.json && r.json.msg) || 'refresh failed',
      };
      await env.WB.put(KV_KEY, JSON.stringify({ ...record, lastResult: err }));
      return err;
    }
    const data = r.json.data || {};
    accessToken = data.accessToken;
    const newRefresh = data.refreshToken;
    if (newRefresh && newRefresh !== refreshToken) {
      refreshToken = newRefresh;
    }
    const expiresIn = Number(data.expiresIn) || (30 * 86400);
    record = {
      ...record,
      refreshToken,
      accessToken,
      accessTokenExpiresAt: Date.now() + (expiresIn * 1000),
    };
  }

  // 查签到状态
  const st = await postJson(STATUS_PATH, {
    Authorization: `Bearer ${accessToken}`,
  });
  if (st.status !== 200 || !st.json || st.json.code !== 0) {
    const err = {
      at: now, ok: false, step: 'status',
      httpStatus: st.status,
      code: st.json && st.json.code,
      msg: (st.json && st.json.msg) || 'query status failed',
    };
    await env.WB.put(KV_KEY, JSON.stringify({ ...record, lastResult: err }));
    return err;
  }

  const stData = st.json.data || {};
  if (stData.today_checked_in) {
    const okResult = {
      at: now, ok: true, step: 'done',
      claim: 'already-checked-in',
      streak_days: stData.streak_days,
      growth_points: stData.growth_points,
    };
    await env.WB.put(KV_KEY, JSON.stringify({ ...record, lastResult: okResult }));
    return okResult;
  }

  // 执行签到
  const chk = await postJson(CHECKIN_PATH, {
    Authorization: `Bearer ${accessToken}`,
  });
  if (chk.status !== 200 || !chk.json || chk.json.code !== 0) {
    const err = {
      at: now, ok: false, step: 'checkin',
      httpStatus: chk.status,
      code: chk.json && chk.json.code,
      msg: (chk.json && chk.json.msg) || 'checkin failed',
    };
    await env.WB.put(KV_KEY, JSON.stringify({ ...record, lastResult: err }));
    return err;
  }

  const chkData = chk.json.data || {};
  const successResult = {
    at: now, ok: true, step: 'done',
    claim: 'claimed',
    streak_days: chkData.streak_days,
    growth_points: chkData.growth_points,
  };
  await env.WB.put(KV_KEY, JSON.stringify({ ...record, lastResult: successResult }));
  return successResult;
}
