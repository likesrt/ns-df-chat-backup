/**
 * Cloudflare Workers - R2 备份服务
 *
 * 提供与前端脚本对接的备份接口（JSON）：
 * - POST   /upload            上传JSON备份 { key, data }
 * - GET    /list?prefix=...  列出指定前缀的备份对象
 * - GET    /download?key=... 下载JSON备份
 * - DELETE /delete?key=...   删除备份对象
 *
 * 认证方式（必须）：
 * - 设置环境变量 AUTH_TOKEN；所有请求必须携带 `Authorization: Bearer <token>`
 *
 * 目录自动创建（S3/R2无真实目录概念）：
 * - 在 /upload 会自动为父级“目录”创建占位对象（.keep），避免依赖真实目录。
 *
 * 绑定：
 * - R2 存储绑定名：R2_BUCKET
 */

/**
 * 发送JSON响应（带CORS）
 * @param {any} data - 响应数据
 * @param {number} status - HTTP状态码
 * @returns {Response}
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-max-age': '86400',
    },
  });
}

/**
 * 发送纯文本响应（带CORS）
 * @param {string} text - 文本
 * @param {number} status - HTTP状态码
 * @returns {Response}
 */
function text(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-max-age': '86400',
    },
  });
}

/**
 * 预检请求处理（CORS）
 * @returns {Response}
 */
function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-max-age': '86400',
    },
  });
}

/**
 * 鉴权检查：若配置了 AUTH_TOKEN，则要求 Bearer 令牌
 * @param {Request} request - 入站请求
 * @param {any} env - Worker 环境（包含 AUTH_TOKEN）
 * @throws {Response} 未授权时抛出 Response
 */
function assertAuth(request, env) {
  const expected = env.AUTH_TOKEN;
  if (!expected) {
    throw json({ error: 'server_not_configured', message: 'Missing AUTH_TOKEN env' }, 500);
  }
  const got = request.headers.get('authorization') || '';
  const ok = got === `Bearer ${expected}`;
  if (!ok) {
    throw json({ error: 'unauthorized' }, 401);
  }
}

/**
 * 解析JSON请求体
 * @param {Request} request - 入站请求
 * @returns {Promise<any>} JSON对象
 */
async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch (e) {
    throw json({ error: 'invalid_json', message: e?.message || String(e) }, 400);
  }
}

/**
 * 规范化对象键：去除前导'/'，折叠重复'/'
 * @param {string} key - 原始键
 * @returns {string} 规范化后的键
 */
function normalizeKey(key) {
  if (!key || typeof key !== 'string') return '';
  let k = key.trim().replace(/\/+/g, '/');
  if (k.startsWith('/')) k = k.slice(1);
  return k;
}

/**
 * 为前缀创建占位对象（.keep），模拟“目录存在”
 * @param {R2Bucket} bucket - R2 存储
 * @param {string} key - 完整对象键
 * @returns {Promise<void>}
 */
async function ensureParentPrefixes(bucket, key) {
  const parts = key.split('/');
  if (parts.length <= 1) return;
  let prefix = '';
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
    const keepKey = `${prefix}/.keep`;
    const head = await bucket.head(keepKey);
    if (!head) {
      await bucket.put(keepKey, new Uint8Array(0), {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
    }
  }
}

/**
 * 处理上传
 * @param {Request} request - 请求
 * @param {any} env - 环境（含 R2_BUCKET）
 * @returns {Promise<Response>}
 */
async function handleUpload(request, env) {
  assertAuth(request, env);
  const body = await parseJsonBody(request);
  const key = normalizeKey(String(body.key || ''));
  if (!key) return json({ error: 'missing_key' }, 400);
  const data = body.data ?? null;
  if (data === null || typeof data === 'undefined') return json({ error: 'missing_data' }, 400);
  await ensureParentPrefixes(env.R2_BUCKET, key);
  const putRes = await env.R2_BUCKET.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return json({ ok: true, key, size: putRes.size });
}

/**
 * 处理列出对象
 * @param {Request} request - 请求
 * @param {any} env - 环境
 * @returns {Promise<Response>}
 */
async function handleList(request, env) {
  assertAuth(request, env);
  const url = new URL(request.url);
  const prefix = normalizeKey(url.searchParams.get('prefix') || '');
  const list = await env.R2_BUCKET.list({ prefix });
  const items = (list.objects || []).map((o) => ({
    key: o.key,
    lastModified: o.uploaded?.toISOString?.() || new Date().toISOString(),
    size: o.size,
  }));
  return json({ items });
}

/**
 * 处理下载
 * @param {Request} request - 请求
 * @param {any} env - 环境
 * @returns {Promise<Response>}
 */
async function handleDownload(request, env) {
  assertAuth(request, env);
  const url = new URL(request.url);
  const key = normalizeKey(url.searchParams.get('key') || '');
  if (!key) return json({ error: 'missing_key' }, 400);
  const obj = await env.R2_BUCKET.get(key);
  if (!obj) return json({ error: 'not_found' }, 404);
  const textData = await obj.text();
  try {
    const parsed = JSON.parse(textData);
    return json(parsed, 200);
  } catch (e) {
    // 若不是JSON，原样返回（但保持CORS）
    return new Response(textData, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'access-control-allow-origin': '*',
      },
    });
  }
}

/**
 * 处理删除
 * @param {Request} request - 请求
 * @param {any} env - 环境
 * @returns {Promise<Response>}
 */
async function handleDelete(request, env) {
  assertAuth(request, env);
  const url = new URL(request.url);
  const key = normalizeKey(url.searchParams.get('key') || '');
  if (!key) return json({ error: 'missing_key' }, 400);
  await env.R2_BUCKET.delete(key);
  return json({ ok: true });
}

/**
 * 处理确保前缀存在（创建占位 .keep）
 * @param {Request} request - 请求
 * @param {any} env - 环境
 * @returns {Promise<Response>}
 */
async function handleEnsure(request, env) {
  assertAuth(request, env);
  const body = await parseJsonBody(request);
  const prefix = normalizeKey(String(body.prefix || ''));
  if (!prefix) return json({ error: 'missing_prefix' }, 400);
  await ensureParentPrefixes(env.R2_BUCKET, `${prefix.replace(/\/$/, '')}/dummy.json`);
  return json({ ok: true });
}

export default {
  /**
   * 请求入口
   * @param {Request} request - 入站请求
   * @param {any} env - 运行环境（包含 R2_BUCKET, AUTH_TOKEN 等）
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const { method } = request;
    if (method === 'OPTIONS') return corsPreflight();

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+/g, '/');

    try {
      if (method === 'POST' && pathname === '/upload') return await handleUpload(request, env);
      if (method === 'GET' && pathname === '/list') return await handleList(request, env);
      if (method === 'GET' && pathname === '/download') return await handleDownload(request, env);
      if (method === 'DELETE' && pathname === '/delete') return await handleDelete(request, env);
      if (method === 'POST' && pathname === '/ensure') return await handleEnsure(request, env);
      return text('not found', 404);
    } catch (err) {
      if (err instanceof Response) return err;
      return json({ error: 'internal_error', message: err?.message || String(err) }, 500);
    }
  },
};
