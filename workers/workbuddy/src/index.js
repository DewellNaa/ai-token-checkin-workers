/**
 * WorkBuddy 每日自动签到（Cloudflare Worker + Cron Trigger + 飞书告警）
 *
 * 流程：
 *   1. 从 KV 取 refresh_token
 *   2. 换 access_token（顺带拿到轮换后的新 refresh_token，回写 KV）
 *   3. 查签到状态；未签到则领取
 *   4. 结果写入 KV 便于查看
 *   5. 失败或令牌异常时推送飞书红色告警卡片
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
      await notifyFeishuCard(env, {
        title: 'WorkBuddy 定时任务执行异常',
        tag: '🚨',
        template: 'red',
        markdownContent: `**平台**：WorkBuddy (腾讯)\n**时间**：${beijingNow()}\n**异常**：${msg}`,
      });
      throw err;
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const adminKey = env.ADMIN_KEY || '';

    if (url.pathname === '/checkin') {
      if (!adminKey || url.searchParams.get('key') !== adminKey) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
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

    if (url.pathname === '/test-notify') {
      if (!adminKey || url.searchParams.get('key') !== adminKey) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      await notifyFeishuCard(env, {
        title: 'WorkBuddy 签到告警通道连通性测试',
        tag: 'ℹ️',
        template: 'blue',
        markdownContent: 'WorkBuddy (腾讯) 每日自动签到已成功对接飞书告警总线！\n- 每日连签成长值与派猫打工\n- 令牌失效即刻红色报警保护连签天数',
      });
      return new Response(JSON.stringify({ ok: true, msg: 'Test notification sent to Feishu' }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return new Response(
      'WorkBuddy checkin worker\n' +
      '  schedule: daily 08:07 Asia/Shanghai\n' +
      '  GET /status  -> last result\n' +
      '  GET /checkin?key=...  -> manual run\n' +
      '  GET /test-notify?key=...  -> test feishu alert\n', {
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
    await notifyFeishuCard(env, {
      title: 'WorkBuddy 令牌缺失告警',
      tag: '🚨',
      template: 'red',
      markdownContent: `**平台**：WorkBuddy (腾讯)\n**时间**：${beijingNow()}\n**错误**：KV 中缺失 Refresh Token，请在桌面端重新登录或同步。`,
    });
    return err;
  }

  let accessToken = record.accessToken;
  const expiresAt = record.accessTokenExpiresAt || 0;

  if (!accessToken || Date.now() > expiresAt - 86400000) {
    const r = await postJson(REFRESH_PATH, {
      'X-Refresh-Token': refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': 'copilot.tencent.com',
    });
    if (r.json.code !== 0 || !r.json.data || !r.json.data.accessToken) {
      const err = {
        at: now, ok: false, step: 'refresh',
        msg: `refresh failed code=${r.json.code} msg=${r.json.msg}`,
      };
      await env.WB.put(KV_KEY, JSON.stringify({ ...record, lastResult: err }));
      await notifyFeishuCard(env, {
        title: 'WorkBuddy 令牌刷新失败告警',
        tag: '🚨',
        template: 'red',
        markdownContent: `**平台**：WorkBuddy (腾讯)\n**时间**：${beijingNow()}\n**错误**：刷新令牌失败（code=${r.json.code} msg=${r.json.msg}），请注意检查连签天数。`,
      });
      return err;
    }
    accessToken = r.json.data.accessToken;
    const newRefresh = r.json.data.refreshToken;
    if (newRefresh) refreshToken = newRefresh;
    const ttl = r.json.data.expiresIn || 2592000;
    record = {
      ...record,
      refreshToken,
      accessToken,
      accessTokenExpiresAt: Date.now() + ttl * 1000,
    };
  }

  const auth = { Authorization: `Bearer ${accessToken}` };
  const s = await postJson(STATUS_PATH, auth);
  let already = false;
  let streak = null;
  let total = null;
  let active = true;
  let endTime = null;
  if (s.json.code === 0 && s.json.data) {
    already = s.json.data.today_checked_in === true;
    streak = s.json.data.streak_days;
    total = s.json.data.total_credits;
    active = s.json.data.active !== false;
    endTime = s.json.data.end_time || null;
  }

  if (!active) {
    const result = {
      at: now, ok: true, step: 'skipped',
      claim: 'activity-inactive',
      note: 'Buddy加油站活动已结束（end_time=' + (endTime || 'n/a') + '），无需签到',
      streak_days: streak, total_credits: total,
    };
    await env.WB.put(KV_KEY, JSON.stringify({ ...record, lastResult: result }));
    return result;
  }

  let claimMsg = 'already-checked-in';
  if (!already) {
    const c = await postJson(CHECKIN_PATH, auth);
    if (c.json.code === 0) {
      claimMsg = `claimed +${(c.json.data && c.json.data.credit) || 100}`;
      if (c.json.data && c.json.data.streak_days) streak = c.json.data.streak_days;
    } else if (c.json.code === 10001) {
      claimMsg = 'already-checked-in';
    } else {
      claimMsg = `claim failed code=${c.json.code} msg=${c.json.msg}`;
      await notifyFeishuCard(env, {
        title: 'WorkBuddy 签到失败告警',
        tag: '🚨',
        template: 'red',
        markdownContent: `**平台**：WorkBuddy (腾讯)\n**时间**：${beijingNow()}\n**错误**：签到接口返回 code=${c.json.code} msg=${c.json.msg}，连签天数可能会受影响！`,
      });
    }
  }

  const result = {
    at: now,
    ok: claimMsg === 'already-checked-in' || claimMsg.startsWith('claimed +'),
    step: 'done',
    claim: claimMsg,
    streak_days: streak,
    total_credits: total,
    beijing_time: beijingNow(),
  };

  await env.WB.put(KV_KEY, JSON.stringify({ ...record, lastResult: result }));
  return result;
}
