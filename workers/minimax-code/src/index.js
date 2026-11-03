/**
 * MiniMax Code 每日签到 —— Cloudflare Worker (支持飞书告警)
 *
 * 流程（与 MiniMax Code 网页端一致）：
 *   1. 用 access token 调 GET  /minimax-cloud/api/v1/signin/status  看今天能不能领
 *   2. 能领才调              POST /minimax-cloud/api/v1/signin/claim   （上游自带幂等）
 *
 * 令牌管理：access token 寿命短（约 1-4 小时），refresh token 长期有效但一次性——
 * 刷新后上游会轮换，必须把新的 refresh token 写回 KV。
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
const REFRESH_SKEW_MS = 120 * 1000;

function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

async function notifyFeishuCard(env, { title, tag = '🚨', template = 'red', markdownContent }) {
  try {
    const appId = env.FEISHU_APP_ID;
    const appSecret = env.FEISHU_APP_SECRET;
    const receiveId = env.FEISHU_RECEIVE_ID;

    if (env.FEISHU_WEBHOOK_URL) {
      await fetch(env.FEISHU_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'interactive',
          card: {
            header: { title: { tag: 'plain_text', content: `${tag} ${title}` }, template },
            elements: [{ tag: 'div', text: { tag: 'lark_md', content: markdownContent } }],
          },
        }),
      });
      return;
    }

    if (appId && appSecret && receiveId) {
      const authResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const authData = await authResp.json();
      if (authData.code === 0 && authData.tenant_access_token) {
        await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${authData.tenant_access_token}`,
          },
          body: JSON.stringify({
            receive_id: receiveId,
            msg_type: 'interactive',
            content: JSON.stringify({
              header: { title: { tag: 'plain_text', content: `${tag} ${title}` }, template },
              elements: [{ tag: 'div', text: { tag: 'lark_md', content: markdownContent } }],
            }),
          }),
        });
      }
    }
  } catch (err) {
    console.error('Feishu notify error:', err);
  }
}

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
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token
      ? body.refresh_token
      : refreshToken,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
}

async function ensureToken(env) {
  const cred = await env.MM.get(KV_CRED, 'json');
  if (!cred || !cred.refreshToken) {
    throw new Error('未配置令牌：请先在本地走一次 OAuth 设备码授权');
  }
  const fresh = cred.accessToken && Number(cred.expiresAt || 0) - REFRESH_SKEW_MS > Date.now();
  if (fresh) return cred;

  const next = await refreshAccessToken(cred.refreshToken);
  await env.MM.put(KV_CRED, JSON.stringify(next));
  return next;
}

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

function summarize(data) {
  const days = Array.isArray(data.days) ? data.days : [];
  const today = days.find((d) => d && d.is_today) || null;
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

  // 发生异常时推飞书红色告警
  if (!result.ok) {
    await notifyFeishuCard(env, {
      title: 'MiniMax Code 自动签到失败告警',
      tag: '🚨',
      template: 'red',
      markdownContent: `**平台**：MiniMax Code (海螺)\n**时间**：${beijingNow()}\n**错误**：${result.error || result.claim}\n**建议**：请检查 OAuth 授权或重新运行授权脚本绑定。`,
    });
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
      await notifyFeishuCard(env, {
        title: 'MiniMax Code 定时任务执行异常',
        tag: '🚨',
        template: 'red',
        markdownContent: `**平台**：MiniMax Code (海螺)\n**时间**：${beijingNow()}\n**异常**：${err && err.message ? err.message : String(err)}`,
      });
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const adminKey = env.ADMIN_KEY || '';

    if (url.pathname === '/claim') {
      const key = url.searchParams.get('key');
      if (!adminKey || key !== adminKey) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      const result = await run(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    if (url.pathname === '/status') {
      const last = await env.MM.get(KV_LAST, 'json');
      const cred = await env.MM.get(KV_CRED, 'json');
      return new Response(JSON.stringify({
        tokenSet: !!cred,
        expiresAt: cred && cred.expiresAt ? new Date(cred.expiresAt).toISOString() : null,
        lastResult: last,
      }, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    if (url.pathname === '/test-notify') {
      const key = url.searchParams.get('key');
      if (!adminKey || key !== adminKey) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      await notifyFeishuCard(env, {
        title: 'MiniMax Code 签到告警通道连通性测试',
        tag: 'ℹ️',
        template: 'blue',
        markdownContent: 'MiniMax Code (海螺) 每日自动签到已成功对接飞书告警总线！\n- 每日 400+ 积分云端自洽轮换\n- 授权失效即刻红色报警',
      });
      return new Response(JSON.stringify({ ok: true, msg: 'Test notification sent to Feishu' }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return new Response(
      'MiniMax Code daily checkin worker\n' +
      '  schedule: daily 10:05 Asia/Shanghai\n' +
      '  GET /status  -> last result\n' +
      '  GET /claim?key=...  -> manual run\n' +
      '  GET /test-notify?key=...  -> test feishu alert\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
