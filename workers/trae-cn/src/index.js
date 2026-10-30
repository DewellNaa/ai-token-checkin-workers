/**
 * Trae CN 每日签到 —— Cloudflare Worker
 *
 * 流程：
 *   1. POST /trae/api/v2/ug/checkin_credits/status  看今天能不能领
 *   2. 能领才调 POST /trae/api/v2/ug/checkin_credits/claim  （上游自带幂等）
 *
 * 认证：Authorization: Cloud-IDE-JWT <token>
 *   ⚠️ 重要：claim 请求必须携带 x-device-id 请求头，否则上游返回 9004「参数不正确」。
 *
 * 令牌来源：从本机 Trae 客户端 storage.json 解密后推送到 Worker。
 * 访问令牌有效期约 14 天（客户端会自行在本地刷新，本机计划任务定时同步即可）。
 *
 * KV 键：
 *   tr-cred  → { token, refreshToken, expiredAt, refreshExpiredAt, deviceId }
 *   tr-last  → 上一次执行结果
 */

const API_BASE = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits';
const KV_CRED = 'tr-cred';
const KV_LAST = 'tr-last';

async function callTrae(env, path, token, deviceId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Cloud-IDE-JWT ${token}`,
  };
  // claim 必须带 x-device-id，否则上游返回 9004「参数不正确」
  if (deviceId) headers['x-device-id'] = deviceId;

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new Error('令牌已失效（HTTP ' + res.status + '），需要重新从客户端提取同步');
  }
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`返回非 JSON：${text.slice(0, 160)}`); }
  return body;
}

function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

async function run(env, force = false) {
  const now = new Date().toISOString();
  let result;
  try {
    const cred = await env.TR.get(KV_CRED, 'json');
    if (!cred || !cred.token) {
      throw new Error('未配置令牌：请在本机运行 extract_trae_token.py 推送凭据');
    }

    const expMs = cred.expiredAt ? Date.parse(cred.expiredAt) : 0;
    const daysLeft = expMs ? (expMs - Date.now()) / 86400000 : null;
    if (daysLeft !== null && daysLeft < 0) {
      throw new Error(`令牌已于 ${cred.expiredAt} 过期，请重新从客户端同步`);
    }

    const deviceId = cred.deviceId || '';
    const st = await callTrae(env, '/status', cred.token, deviceId);
    if (st.code === 1001) {
      throw new Error('令牌已被服务端拒绝（code=1001），需要重新从客户端提取');
    }
    if (st.code !== 0) {
      throw new Error(`status 返回 code ${st.code}: ${st.message || '上游拒绝'}`);
    }
    if (!st.enable) {
      result = {
        at: now, beijing_time: beijingNow(), ok: true, step: 'done',
        claim: 'activity-inactive', credits: null, streak_days: null,
      };
    } else if (st.checked_in && !force) {
      result = {
        at: now, beijing_time: beijingNow(), ok: true, step: 'done',
        claim: 'already-checked-in', credits: st.credits ?? null, streak_days: null,
      };
    } else {
      const got = await callTrae(env, '/claim', cred.token, deviceId);
      if (got.code === 0 && force && st.checked_in) {
        result = {
          at: now, beijing_time: beijingNow(), ok: true, step: 'done',
          claim: 'claim-ok(forced,already-claimed)',
          credits: got.credits ?? st.credits ?? null, streak_days: null,
        };
      } else if (got.code === 9074) {
        result = {
          at: now, beijing_time: beijingNow(), ok: false, step: 'done',
          claim: 'own-app-only', error: got.message || 'Trae CN 拒绝第三方签到（9074）',
        };
      } else if (got.code !== 0) {
        result = {
          at: now, beijing_time: beijingNow(), ok: false, step: 'done',
          claim: `claim-failed code=${got.code}`,
          error: got.code === 9004
            ? `${got.message || '参数不正确'}（缺少 x-device-id 请求头，请检查 KV 中的 deviceId）`
            : (got.message || ''),
        };
      } else {
        result = {
          at: now, beijing_time: beijingNow(), ok: true, step: 'done',
          claim: `claimed +${got.credits ?? st.credits ?? 0}`,
          credits: got.credits ?? st.credits ?? null,
          extra_credits: got.extra_credits ?? null,
          streak_days: null,
        };
      }
    }
  } catch (err) {
    result = {
      at: now, beijing_time: beijingNow(), ok: false, step: 'failed',
      claim: 'error', error: (err && err.message) ? err.message : String(err),
    };
  }
  await env.TR.put(KV_LAST, JSON.stringify(result));
  return result;
}

export default {
  async scheduled(event, env, ctx) {
    console.log('cron fired at', new Date().toISOString());
    try {
      const result = await run(env);
      console.log('result:', JSON.stringify(result));
    } catch (err) {
      console.error('cron error:', err && err.message ? err.message : String(err));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      const last = await env.TR.get(KV_LAST, 'json');
      const cred = await env.TR.get(KV_CRED, 'json');
      const expMs = cred && cred.expiredAt ? Date.parse(cred.expiredAt) : 0;
      return new Response(JSON.stringify({
        tokenSet: !!cred,
        tokenExpiresAt: cred ? cred.expiredAt || null : null,
        tokenDaysLeft: expMs ? Number(((expMs - Date.now()) / 86400000).toFixed(2)) : null,
        deviceId: cred ? cred.deviceId || null : null,
        refreshExpiresAt: cred ? cred.refreshExpiredAt || null : null,
        lastResult: last || { note: 'no record yet' },
      }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    if (url.pathname === '/checkin') {
      const key = url.searchParams.get('key');
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return new Response('unauthorized', { status: 401 });
      }
      const token = url.searchParams.get('token');
      const refreshToken = url.searchParams.get('refresh_token');
      if (token) {
        const prev = (await env.TR.get(KV_CRED, 'json')) || {};
        await env.TR.put(KV_CRED, JSON.stringify({
          token,
          refreshToken: refreshToken || prev.refreshToken || '',
          expiredAt: url.searchParams.get('expired_at') || prev.expiredAt || null,
          refreshExpiredAt: url.searchParams.get('refresh_expired_at') || prev.refreshExpiredAt || null,
          deviceId: url.searchParams.get('device_id') || prev.deviceId || '',
        }));
      }
      const force = url.searchParams.get('force_claim') === '1';
      const result = await run(env, force);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return new Response(
      'Trae CN checkin worker.\n'
      + 'GET  /status   → 查看上次结果与令牌状态\n'
      + 'GET  /checkin?key=<ADMIN_KEY>[&token=<jwt>]  → 手动触发 / 更新令牌\n',
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  },
};
