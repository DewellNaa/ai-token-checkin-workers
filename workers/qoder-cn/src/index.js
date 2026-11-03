/**
 * Qoder CN 每日自动领取 Credits（Cloudflare Worker + Cron Trigger）
 *
 * 功能升级版：
 *   1. 每日自动领取：每天北京时间 10:05 自动代领当日 100 Credits（30天有效期）。
 *   2. 异常自动报警：Token 失效、接口改版或领取代扣失败，即刻推送红色报警卡片至飞书。
 *   3. 新活动雷达：动态记忆与比对全量活动树，一旦发现无法一键自动代领的新活动（如需要
 *      手动做任务、邀请、问卷或浏览详情的福利），自动向飞书推送橙色【新活动上线提醒】。
 *   4. 单次防刷：每个新活动仅在首次检测到时提醒一次，避免每日重复轰炸。
 *
 * 接口（openapi.qoder.com.cn）：
 *   GET  /sash/api/v1/me/campaigns                      查活动列表
 *   POST /sash/api/v1/me/campaigns/{campaignId}/claim    领取（幂等）
 */

const BASE_URL = 'https://openapi.qoder.com.cn';
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';

const KV_KEY = 'QODER_SESSION';

// 北京时间 10:05 开放领取窗口
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

/** 北京时间的当前小时与分钟 */
function beijingNow(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  return { hour: bj.getUTCHours(), minute: bj.getUTCMinutes(), iso: bj.toISOString() };
}

function formatWindow(startAt, endAt) {
  if (!startAt && !endAt) return '以官方公告为准';
  const fmt = (ts) => {
    if (!ts) return '';
    const ms = ts > 1e11 ? ts : ts * 1000;
    const d = new Date(ms + 8 * 3600 * 1000);
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };
  return `${fmt(startAt)} ~ ${fmt(endAt)}`;
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

/**
 * 飞书卡片消息推送函数 (支持报警 red、情报 orange、信息 blue)
 */
async function notifyFeishuCard(env, { title, tag = '🚨', template = 'red', markdownContent }) {
  try {
    const appId = env.FEISHU_APP_ID;
    const appSecret = env.FEISHU_APP_SECRET;
    const receiveId = env.FEISHU_RECEIVE_ID;

    // 途径 1: 自定义机器人 Webhook
    if (env.FEISHU_WEBHOOK_URL) {
      await fetch(env.FEISHU_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'interactive',
          card: {
            header: {
              title: { tag: 'plain_text', content: `${tag} ${title}` },
              template,
            },
            elements: [{ tag: 'div', text: { tag: 'lark_md', content: markdownContent } }],
          },
        }),
      });
      return;
    }

    // 途径 2: 飞书官方应用 (OpenAPI)
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
              header: {
                title: { tag: 'plain_text', content: `${tag} ${title}` },
                template,
              },
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

/** 发送错误报警卡片 */
async function notifyError(env, title, detail) {
  const timeStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const content = `**平台**：Qoder CN 每日算力自动领取\n**时间**：${timeStr} (北京时间)\n**详情**：${detail}\n**建议**：请检查 Qoder 客户端登录态或官方接口状态。`;
  await notifyFeishuCard(env, {
    title,
    tag: '🚨',
    template: 'red',
    markdownContent: content,
  });
}

/** 发送新活动情报卡片 */
async function notifyNewCampaign(env, campaign) {
  const timeStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const cName = campaign.title || campaign.name || campaign.campaignKey || '未命名福利活动';
  const windowStr = formatWindow(campaign.startAt, campaign.endAt);
  const benefit = campaign.benefit || {};
  const credits = benefit.amount ? `${benefit.amount} Credits` : '专属活动权益/算力包';
  const actionText = campaign.actionType === 'VIEW_DETAILS' ? '浏览参与 / 外部活动' : (campaign.actionType || '需手动达成任务');

  const content = `**平台**：Qoder CN 智能编程助手\n` +
    `**活动名称**：${cName}\n` +
    `**时间窗口**：${windowStr}\n` +
    `**奖励内容**：${credits}\n` +
    `**活动类型**：${actionText}\n` +
    `**状态说明**：该活动包含福利奖励，但**无法由系统一键自动代领**（需在客户端或网页端完成指定任务/浏览）。\n` +
    `**操作指引**：建议前往 Qoder 官方网页或客户端参与，避免错过算力福利。`;

  await notifyFeishuCard(env, {
    title: '发现 Qoder CN 新上线福利活动',
    tag: '🔔',
    template: 'orange',
    markdownContent: content,
  });
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
      
      // 触发飞书异常报警
      await notifyError(env, 'Qoder 定时任务执行异常', msg);
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
        seenCampaignsCount: Array.isArray(rec.seenCampaigns) ? rec.seenCampaigns.length : 0,
        lastResult: rec.lastResult || null,
      });
    }

    if (url.pathname === '/test-notify') {
      if (!adminKey || url.searchParams.get('key') !== adminKey) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      const type = url.searchParams.get('type') || 'info';
      if (type === 'new_campaign') {
        await notifyNewCampaign(env, {
          title: '【演示】双 11 限时编程狂欢活动',
          startAt: Math.floor(Date.now() / 1000),
          endAt: Math.floor(Date.now() / 1000) + 14 * 86400,
          actionType: 'VIEW_DETAILS',
          benefit: { amount: 500 },
        });
        return json({ ok: true, msg: 'Sample new-campaign notification sent to Feishu' });
      }

      await notifyFeishuCard(env, {
        title: 'Qoder 签到与活动雷达已就绪',
        tag: 'ℹ️',
        template: 'blue',
        markdownContent: 'Qoder 每日算力自动代领与新活动雷达升级成功！\n- 每日 100 Credits 自动代领（静默入账）\n- 故障即刻红色报警\n- 新上线不可代领活动橙色卡片提醒',
      });
      return json({ ok: true, msg: 'Info notification sent to Feishu' });
    }

    return new Response(
      'Qoder CN daily credits claimer & radar\n' +
      '  schedule: daily 10:05 Asia/Shanghai\n' +
      '  GET /status  -> last result\n' +
      '  GET /claim?key=...  -> manual run\n' +
      '  GET /test-notify?key=...&type=new_campaign  -> test radar card\n', {
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
  let seenCampaigns = Array.isArray(record.seenCampaigns) ? record.seenCampaigns : [];

  const token = (tokenOverride || record.token || '').trim();
  if (!token) {
    const err = {
      at: now.toISOString(), ok: false, step: 'init',
      msg: 'no token in KV; extract from Qoder desktop login state and POST /claim?token=...',
    };
    await env.Q.put(KV_KEY, JSON.stringify({ ...record, lastResult: err }));
    await notifyError(env, 'Qoder 签到凭据缺失', 'Cloudflare KV 中未检测到有效 Token，请在电脑端运行脚本同步。');
    return err;
  }

  // 未到开放时间不发请求（服务端此时无当日活动）
  if (bj.hour < OPEN_HOUR_BJ) {
    const skip = {
      at: now.toISOString(), ok: true, step: 'skipped',
      claim: 'before-open-window',
      note: `北京 ${bj.hour}:${String(bj.minute).padStart(2, '0')} 未到 ${OPEN_HOUR_BJ}:00，当日活动未开放`,
    };
    await env.Q.put(KV_KEY, JSON.stringify({ ...record, token, lastResult: skip }));
    return skip;
  }

  // 查活动列表
  const list = await api(CAMPAIGNS_PATH, token, 'GET');
  if (list.status !== 200 || !list.json) {
    const err = {
      at: now.toISOString(), ok: false, step: 'campaigns',
      msg: `HTTP ${list.status}: ${list.text}`,
    };
    await env.Q.put(KV_KEY, JSON.stringify({ ...record, token, lastResult: err }));
    await notifyError(env, 'Qoder 活动列表查询失败', `HTTP 状态码: ${list.status}，返回内容: ${list.text}`);
    return err;
  }

  const campaigns = Array.isArray(list.json.campaigns) ? list.json.campaigns : [];
  
  // 1. 自动领取逻辑（仅对 CLAIM_BENEFIT 且待领项生效）
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
      await notifyError(env, 'Qoder 算力领取失败', `接口返回: ${claimMsg}，活动 ID: ${campaignId}`);
    }
  }

  // 2. 新活动雷达与情报探测（针对不能自动一键领取的活动）
  const notifiedNew = [];
  for (const c of campaigns) {
    if (!c) continue;
    const cId = String(c.campaignKey || c.campaignId || c.id || '');
    if (!cId) continue;

    // 忽略常规每日签到活动 key (如 act-20261102-xxx，这种属于日常自动代领池)
    const isDailyClaim = c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE';
    if (isDailyClaim) {
      if (!seenCampaigns.includes(cId)) seenCampaigns.push(cId);
      continue;
    }

    // 检查是否为新发现的非直领活动
    if (!seenCampaigns.includes(cId)) {
      seenCampaigns.push(cId);
      const cannotAutoClaim = c.actionType !== 'CLAIM_BENEFIT' || c.claimStatus !== 'CLAIMED';
      if (cannotAutoClaim) {
        notifiedNew.push(cId);
        await notifyNewCampaign(env, c);
      }
    }
  }

  // 保持记忆列表在最近 100 个以内，防止 KV 胀大
  if (seenCampaigns.length > 100) {
    seenCampaigns = seenCampaigns.slice(-100);
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
    notified_new_campaigns: notifiedNew,
    beijing_time: bj.iso,
    token: mask(token),
  };

  await env.Q.put(KV_KEY, JSON.stringify({
    ...record,
    token,
    seenCampaigns,
    lastResult: result,
  }));
  return result;
}
