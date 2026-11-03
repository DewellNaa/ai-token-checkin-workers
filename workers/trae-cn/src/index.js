/**
 * Trae CN 每日签到 —— Cloudflare Worker (支持飞书告警)
 *
 * 流程：
 *   1. POST /trae/api/v2/ug/checkin_credits/status  看今天能不能领
 *   2. 能领才调 POST /trae/api/v2/ug/checkin_credits/claim  （上游自带幂等）
 *
 * 认证：Authorization: Cloud-IDE-JWT <token>
 * 令牌来源：本机 Trae 客户端的 storage.json（AES-128-CBC 加密，本机脚本解密后推上来）。
 *
 * KV 键：
 *   tr-cred  → { token, refreshToken, expiredAt, refreshExpiredAt }
 *   tr-last  → 上一次执行结果
 */

const API_BASE = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits';
const KV_CRED = 'tr-cred';
const KV_LAST = 'tr-last';

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

async function callTrae(env, path, token, deviceId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Cloud-IDE-JWT ${token}`,
  };
  if (deviceId) headers['x-device-id'] = deviceId;

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new Error('令牌已失效（HTTP ' + res.status + '），需要重新从客户端提取');
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
      throw new Error('未配置令牌：请在本机运行 extract_trae_token.py 推送一次');
    }

    const expMs = cred.expiredAt ? Date.parse(cred.expiredAt) : 0;
    const daysLeft = expMs ? (expMs - Date.now()) / 86400000 : null;
    if (daysLeft !== null && daysLeft < 0) {
      throw new Error(`令牌已于 ${cred.expiredAt} 过期，需要重新从客户端提取`);
    }
    if (daysLeft !== null && daysLeft < 2) {
      await notifyFeishuCard(env, {
        title: 'Trae CN 令牌即将到期',
        tag: '⚠️',
        template: 'orange',
        markdownContent: `**平台**：Trae CN (字节跳动)\n**时间**：${beijingNow()}\n**提示**：令牌将在 ${daysLeft.toFixed(1)} 天后过期（${cred.expiredAt}），请打开 Trae 客户端以便本机计划任务自动续期同步。`,
      });
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
            ? `${got.message || '参数不正确'} —— 多半是缺少 x-device-id，检查 KV 里的 deviceId`
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

  // 发生异常且失败时，触发飞书红色告警
  if (!result.ok) {
    await notifyFeishuCard(env, {
      title: 'Trae CN 自动签到失败告警',
      tag: '🚨',
      template: 'red',
      markdownContent: `**平台**：Trae CN (字节跳动)\n**时间**：${beijingNow()}\n**错误**：${result.error || result.claim}\n**建议**：请在电脑端启动 Trae 并运行同步脚本重新绑定凭据。`,
    });
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
      await notifyFeishuCard(env, {
        title: 'Trae CN 定时任务执行异常',
        tag: '🚨',
        template: 'red',
        markdownContent: `**平台**：Trae CN (字节跳动)\n**时间**：${beijingNow()}\n**异常**：${err && err.message ? err.message : String(err)}`,
      });
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
        expiredAt: cred?.expiredAt || null,
        daysLeft: expMs ? Number(((expMs - Date.now()) / 86400000).toFixed(1)) : null,
        deviceId: cred?.deviceId ? cred.deviceId.slice(0, 8) + '...' : null,
        lastResult: last,
      }, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    if (url.pathname === '/claim') {
      const key = url.searchParams.get('key');
      const adminKey = env.ADMIN_KEY || '';
      if (!adminKey || key !== adminKey) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      const token = url.searchParams.get('token');
      const refreshToken = url.searchParams.get('refreshToken');
      const expiredAt = url.searchParams.get('expiredAt');
      const refreshExpiredAt = url.searchParams.get('refreshExpiredAt');
      const deviceId = url.searchParams.get('deviceId');
      if (token) {
        await env.TR.put(KV_CRED, JSON.stringify({
          token,
          refreshToken: refreshToken || '',
          expiredAt: expiredAt || '',
          refreshExpiredAt: refreshExpiredAt || '',
          deviceId: deviceId || '',
        }));
      }
      const force = url.searchParams.get('force') === '1';
      const result = await run(env, force);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    if (url.pathname === '/test-notify') {
      const key = url.searchParams.get('key');
      const adminKey = env.ADMIN_KEY || '';
      if (!adminKey || key !== adminKey) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      await notifyFeishuCard(env, {
        title: 'Trae CN 签到告警通道连通性测试',
        tag: 'ℹ️',
        template: 'blue',
        markdownContent: 'Trae CN (字节跳动) 每日自动签到已成功对接飞书告警总线！\n- 每日 100 积分云端代领\n- Token 到期前 2 天自动预警\n- 签到故障即刻红色报警',
      });
      return new Response(JSON.stringify({ ok: true, msg: 'Test notification sent to Feishu' }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return new Response(
      'Trae CN daily checkin worker\n' +
      '  schedule: daily 09:07 Asia/Shanghai\n' +
      '  GET /status  -> last result\n' +
      '  GET /claim?key=...&token=...  -> update token & run\n' +
      '  GET /test-notify?key=...  -> test feishu alert\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
