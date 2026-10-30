/**
 * MiniMax Code 每日签到 —— Cloudflare Worker
 *
 * 流程（与 MiniMax Code 网页端一致）：
 *   1. 用 access token 调 GET  /minimax-cloud/api/v1/signin/status  看今天能不能领
 *   2. 能领才调              POST /minimax-cloud/api/v1/signin/claim   （上游自带幂等）
 *
 * 令牌管理：access token 寿命短（约 1-4 小时），refresh token 长期有效但一次性——
 * 刷新后上游会轮换，必须把新的 refresh token 写回 KV，否则下次刷新会失败。
 *
 * KV 键：
 *   mm-cred  → { accessToken, refreshToken, expiresAt }
 *   mm-last  → 上一次执行结果
 */

const ACCOUNT_BASE = 'https://account.minimax.cn';
const API_BASE = 'https://agent.minimax.cn/minimax-cloud/api/v1/signin';
const OAUTH_FORM = {
  client_id: 'mcode-public',
  scope: 'agent.default',
  audience: 'agent-backend',
};

const KV_CRED = 'mm-cred';
const KV_LAST = 'mm-last';
const REFRESH_SKEW_MS = 120 * 1000; // 过期前 2 分钟就刷新，留出时钟偏差余量

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* 非 JSON */ }
  return { status: res.status, body };
}

/**
 * 用 refresh token 换新的 access token（并把轮换后的 refresh token 一起返回）。
 */
async function refreshAccessToken(refreshToken) {
  const { status, body } = await postForm(`${ACCOUNT_BASE}/oauth2/token`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    ...OAUTH_FORM,
  });
  if (status !== 200 || !body || typeof body.access_token !== 'string') {
    const err = (body && (body.error_description || body.error)) || `HTTP ${status}`;
    throw new Error(`刷新令牌失败：${err}`);
  }
  return {
    accessToken: body.access_token,
    // 上游会轮换 refresh token；没给就沿用旧的
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token
      ? body.refresh_token
      : refreshToken,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
}

/**
 * 拿一个可用的 access token：能用就直接用，快过期或没有才刷新。
 */
async function ensureToken(env) {
  const cred = await env.MM.get(KV_CRED, 'json');
  if (!cred || !cred.refreshToken) {
    throw new Error('未配置令牌：请先运行 scripts/minimax_authorize.py 完成 OAuth 设备码授权');
  }
  const fresh = cred.accessToken && Number(cred.expiresAt || 0) - REFRESH_SKEW_MS > Date.now();
  if (fresh) return cred;

  const next = await refreshAccessToken(cred.refreshToken);
  await env.MM.put(KV_CRED, JSON.stringify(next));
  return next;
}

/**
 * 调签到接口。upstream 自带幂等（重复 claim 返回已签状态），重试是安全的。
 */
async function callSignin(env, action, token) {
  const url = `${API_BASE}/${action}?timezone_id=${encodeURIComponent('Asia/Shanghai')}`;
  const res = await fetch(url, {
    method: action === 'claim' ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(action === 'claim' ? { 'content-type': 'application/json' } : {}),
    },
    ...(action === 'claim' ? { body: '{}' } : {}),
  });
  const text = await res.text();
  if (res.status === 401) throw new Error('令牌无效（401）');
  if (!res.ok) throw new Error(`签到接口 HTTP ${res.status}: ${text.slice(0, 160)}`);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`返回非 JSON：${text.slice(0, 160)}`); }
  const base = body.base_resp || {};
  if (base.code !== undefined && base.code !== 0) {
    throw new Error(`code ${base.code}: ${base.msg || '上游拒绝'}`);
  }
  return body.data || {};
}

function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 今天的签到状态 → 面板。
 * days 里 status===2 表示「今天可领」。
 */
function summarize(data) {
  const days = Array.isArray(data.days) ? data.days : [];
  const today = days.find((d) => d && d.is_today) || null;
  // status 语义：1=未开始待领，2=可领，3=已领
  const st = today ? today.status : null;
  return {
    claimable: st === 2,
    dayNo: today && typeof today.day_no === 'number' ? today.day_no : null,
    todayStatus: st,
    todayPoints: today ? (today.points ?? null) : null,
    bonusPoints: today ? (today.bonus_points ?? null) : null,
    expireAtMs: today ? (today.expire_at_ms ?? null) : null,
  };
}

async function run(env) {
  const now = new Date().toISOString();
  let result;
  try {
    const cred = await ensureToken(env);
    const statusData = await callSignin(env, 'status', cred.accessToken);
    const panel = summarize(statusData);

    if (!panel.claimable) {
      result = {
        at: now,
        beijing_time: beijingNow(),
        ok: true,
        step: 'done',
        claim: 'already-claimed',
        day_no: panel.dayNo,
        points: panel.todayPoints,
        bonus_points: panel.bonusPoints,
      };
    } else {
      const claimData = await callSignin(env, 'claim', cred.accessToken);
      const claimResult = claimData.claim_result;
      const points = claimData.points ?? panel.todayPoints;
      result = {
        at: now,
        beijing_time: beijingNow(),
        ok: claimResult === 1 || claimResult === 2,
        step: 'done',
        claim: claimResult === 1 ? `claimed +${points ?? '?'}` : 'already-claimed',
        points: points ?? null,
        day_no: claimData.day_no ?? panel.dayNo,
        bonus_points: panel.bonusPoints,
        expire_at_ms: claimData.expire_at_ms ?? panel.expireAtMs ?? null,
      };
    }
  } catch (err) {
    result = {
      at: now,
      beijing_time: beijingNow(),
      ok: false,
      step: 'failed',
      claim: 'error',
      error: (err && err.message) ? err.message : String(err),
    };
  }
  await env.MM.put(KV_LAST, JSON.stringify(result));
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
      const last = await env.MM.get(KV_LAST, 'json');
      const cred = await env.MM.get(KV_CRED, 'json');
      const accessValid = !!(cred && cred.accessToken && Number(cred.expiresAt || 0) > Date.now());
      return new Response(JSON.stringify({
        tokenSet: !!cred,
        accessTokenValid: accessValid,
        refreshToken: cred ? String(cred.refreshToken || '').slice(0, 12) + '…' : null,
        lastResult: last || { note: 'no record yet' },
      }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    if (url.pathname === '/checkin') {
      const key = url.searchParams.get('key');
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return new Response('unauthorized', { status: 401 });
      }
      const override = url.searchParams.get('token');
      const overrideRefresh = url.searchParams.get('refresh_token');
      if (override || overrideRefresh) {
        const prev = (await env.MM.get(KV_CRED, 'json')) || {};
        await env.MM.put(KV_CRED, JSON.stringify({
          accessToken: override || prev.accessToken || '',
          refreshToken: overrideRefresh || prev.refreshToken || '',
          expiresAt: override ? Date.now() + 3600 * 1000 : (prev.expiresAt || 0),
        }));
      }
      const result = await run(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return new Response(
      'MiniMax Code checkin worker.\n'
      + 'GET  /status   → 查看上次结果与令牌状态\n'
      + 'GET  /checkin?key=<ADMIN_KEY>[&token=<access>][&refresh_token=<refresh>]  → 手动触发\n',
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  },
};
