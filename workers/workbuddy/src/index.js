/**
 * WorkBuddy 每日自动签到 & 派猫旅行（Cloudflare Worker + Cron Trigger）
 *
 * 核心功能：
 *   1. 每日基础签到（自动轮换防踢下线，30天超长缓存保护）
 *   2. 派猫旅行自动化（自动查状态 -> 到达自动领奖 -> 挑选最高奖励地点自动出行）
 *   3. 多通道消息推送（支持飞书群机器人 Webhook、Bark、PushPlus 微信通知）
 *
 * 设计要点：
 *   - access_token 有效期 30 天，缓存在 KV，只有过期才 refresh，避免踢出本地桌面端。
 *   - 域名白名单守卫：仅允许向腾讯官方接口发起请求。
 *   - 敏感令牌全链路脱敏保护。
 */

const API_HOST = 'https://copilot.tencent.com';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';
const STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
const CHECKIN_PATH = '/v2/billing/meter/daily-checkin';

// 派猫旅行接口
const TRAVEL_STATUS_PATH = '/activity/growth/buddy/travel/status';
const TRAVEL_CONFIG_PATH = '/activity/growth/buddy/travel/config';
const TRAVEL_DEPART_PATH = '/activity/growth/buddy/travel/depart';
const TRAVEL_CLAIM_PATH = '/activity/growth/buddy/travel/claim';

const ALLOWED_HOSTS = ['copilot.tencent.com', 'www.workbuddy.cn'];
const KV_KEY = 'WB_SESSION';

function mask(v) {
  if (!v) return '(empty)';
  const s = String(v);
  return s.slice(0, 6) + '***' + s.slice(-4) + `(len=${s.length})`;
}

async function requestJson(method, path, headers = {}, body = null) {
  const url = new URL(path, API_HOST);
  if (!ALLOWED_HOSTS.includes(url.hostname)) {
    throw new Error('host not allowed: ' + url.hostname);
  }
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== null) {
    opts.body = JSON.stringify(body);
  } else if (method === 'POST') {
    opts.body = '{}';
  }
  const resp = await fetch(url.toString(), opts);
  const text = await resp.text();
  try {
    return { status: resp.status, json: JSON.parse(text) };
  } catch {
    return { status: resp.status, json: { code: -1, msg: 'non-JSON response: ' + text.slice(0, 120) } };
  }
}

async function postJson(path, headers) {
  return requestJson('POST', path, headers, {});
}

/**
 * 多渠道通知分发（飞书、Bark、PushPlus）
 */
async function sendNotification(env, title, content) {
  const tasks = [];

  // 1. 飞书自定义群机器人
  if (env.FEISHU_WEBHOOK) {
    tasks.push(
      fetch(env.FEISHU_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'post',
          content: {
            post: {
              zh_cn: {
                title: title,
                content: [[{ tag: 'text', text: content }]],
              },
            },
          },
        }),
      }).catch((e) => console.error('Feishu notify error:', e))
    );
  }

  // 2. Bark (iOS 推送)
  if (env.BARK_URL || env.BARK_KEY) {
    const barkBase = env.BARK_URL || `https://api.day.app/${env.BARK_KEY}`;
    const url = `${barkBase.replace(/\/$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(content)}`;
    tasks.push(fetch(url).catch((e) => console.error('Bark notify error:', e)));
  }

  // 3. PushPlus (微信公众号模板消息)
  if (env.PUSHPLUS_TOKEN) {
    tasks.push(
      fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: env.PUSHPLUS_TOKEN,
          title: title,
          content: content.replace(/\n/g, '<br/>'),
          template: 'html',
        }),
      }).catch((e) => console.error('PushPlus notify error:', e))
    );
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

/**
 * 派猫旅行自动化逻辑
 */
async function handleTravel(accessToken) {
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  // 1. 查询旅行状态
  const stResp = await requestJson('GET', TRAVEL_STATUS_PATH, authHeaders);
  if (stResp.status !== 200 || !stResp.json || stResp.json.code !== 0) {
    return { ok: false, step: 'travel_status', msg: stResp.json?.msg || 'query travel status failed' };
  }

  const d = stResp.json.data || {};
  let state = d.state || 'idle';
  const serverNow = d.server_now || Math.floor(Date.now() / 1000);
  const arriveAt = d.arrive_at || 0;

  // 2. 检查是否在途已到达
  if (state === 'traveling' && arriveAt > 0 && serverNow >= arriveAt) {
    state = 'arrived';
  }

  let claimResult = null;
  // 3. 若已到达，自动领奖
  if (state === 'arrived') {
    const claimResp = await requestJson('POST', TRAVEL_CLAIM_PATH, authHeaders, {});
    if (claimResp.json && claimResp.json.code === 0) {
      const cd = claimResp.json.data || {};
      claimResult = {
        reward_credit: cd.reward_credit || cd.credit || 0,
        letter: cd.letter || null,
      };
      state = 'idle'; // 领奖后恢复 idle，尝试触发今日出行
    } else {
      claimResult = { error: claimResp.json?.msg || 'claim failed' };
    }
  }

  // 4. 若空闲且今日未达上限，挑选奖励最高地点派出
  let departResult = null;
  if (state === 'idle' && !d.daily_limit_reached) {
    const cfgResp = await requestJson('GET', TRAVEL_CONFIG_PATH, authHeaders);
    const locs = cfgResp.json?.data?.locations || [];
    if (locs.length > 0) {
      locs.sort((a, b) => (b.reward_credit_max || 0) - (a.reward_credit_max || 0) || (a.sort || 0) - (b.sort || 0));
      const best = locs[0];
      const depResp = await requestJson('POST', TRAVEL_DEPART_PATH, authHeaders, { location_id: best.id });
      if (depResp.json && depResp.json.code === 0) {
        departResult = {
          location_name: best.name,
          location_code: best.code,
          arrive_at: depResp.json.data?.arrive_at || 0,
        };
      } else {
        departResult = { error: depResp.json?.msg || 'depart failed' };
      }
    }
  }

  return {
    ok: true,
    previous_state: d.state,
    claim: claimResult,
    depart: departResult,
    daily_limit_reached: Boolean(d.daily_limit_reached),
  };
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
      'WorkBuddy checkin & travel worker\n' +
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

  // 1. 令牌轮换检测（有效且余量 > 1天则复用）
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

  // 2. 每日签到
  let checkinResult = {};
  const st = await postJson(STATUS_PATH, { Authorization: `Bearer ${accessToken}` });
  if (st.status === 200 && st.json && st.json.code === 0) {
    const stData = st.json.data || {};
    if (stData.today_checked_in) {
      checkinResult = {
        claim: 'already-checked-in',
        streak_days: stData.streak_days,
        growth_points: stData.growth_points,
      };
    } else {
      const chk = await postJson(CHECKIN_PATH, { Authorization: `Bearer ${accessToken}` });
      if (chk.status === 200 && chk.json && chk.json.code === 0) {
        const cd = chk.json.data || {};
        checkinResult = {
          claim: 'claimed',
          streak_days: cd.streak_days,
          growth_points: cd.growth_points,
        };
      } else {
        checkinResult = { claim: 'failed', msg: chk.json?.msg || 'checkin api error' };
      }
    }
  } else {
    checkinResult = { claim: 'failed', msg: st.json?.msg || 'query status error' };
  }

  // 3. 派猫旅行（自动到达领奖 + 自动派出新旅行）
  let travelResult = {};
  try {
    travelResult = await handleTravel(accessToken);
  } catch (err) {
    travelResult = { ok: false, msg: String(err.message || err) };
  }

  const finalResult = {
    at: now,
    ok: true,
    step: 'done',
    checkin: checkinResult,
    travel: travelResult,
  };

  await env.WB.put(KV_KEY, JSON.stringify({ ...record, lastResult: finalResult }));

  // 4. 多通道消息推送
  try {
    const lines = [
      `⏰ 时间：${now}`,
      `📌 签到状态：${checkinResult.claim === 'already-checked-in' ? '今日已签到' : checkinResult.claim === 'claimed' ? '签到成功！' : '签到异常'} (连签 ${checkinResult.streak_days || 0} 天, 积分: ${checkinResult.growth_points || 0})`,
    ];
    if (travelResult.claim && travelResult.claim.reward_credit) {
      lines.push(`🎁 旅行领奖：+${travelResult.claim.reward_credit} 积分${travelResult.claim.letter ? ` (信件: ${travelResult.claim.letter})` : ''}`);
    }
    if (travelResult.depart && travelResult.depart.location_name) {
      lines.push(`🐱 派猫出行：已派出前往「${travelResult.depart.location_name}」`);
    } else if (travelResult.daily_limit_reached) {
      lines.push(`🐱 派猫出行：今日已达上限或旅行进行中`);
    }
    const daysLeft = ((record.accessTokenExpiresAt - Date.now()) / 86400000).toFixed(1);
    lines.push(`🔑 令牌余量：剩余 ${daysLeft} 天`);

    await sendNotification(env, 'WorkBuddy 自动签到与旅行简报', lines.join('\n'));
  } catch (notifyErr) {
    console.error('Notify execution failed:', notifyErr);
  }

  return finalResult;
}
