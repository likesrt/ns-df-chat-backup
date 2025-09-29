/**
 * Cloudflare Workers - NS-DF 备份服务
 *
 * Cloudflare R2
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
 * CORS 配置（严格限制）：
 * - 环境变量 ALLOWED_ORIGINS：允许的来源域名列表，逗号分隔（如 "https://www.nodeseek.com,https://www.deepflood.com"）
 * - 若不设置则默认为 "*"（不推荐使用）
 *
 * R2 绑定配置：
 * - 在 Workers 设置中绑定 R2 存储桶，变量名：R2_BUCKET
 *
 * 环境变量配置：
 * - AUTH_TOKEN=your-secret-token-here（必需）
 * - ALLOWED_ORIGINS=https://www.nodeseek.com,https://www.deepflood.com（推荐）
 */

/**
 * 获取 CORS 头部
 */
function getCorsHeaders(request, env) {
  const allowedOrigins = env.ALLOWED_ORIGINS || '*';
  const origin = request.headers.get('origin') || '';

  let allowOrigin = '*';
  if (allowedOrigins !== '*') {
    const origins = allowedOrigins.split(',').map(o => o.trim());
    if (origins.includes(origin)) {
      allowOrigin = origin;
    } else {
      allowOrigin = origins[0] || '*';
    }
  }

  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    'access-control-allow-credentials': 'true',
  };
}

/**
 * 发送JSON响应（带CORS）
 */
function json(data, status = 200, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...getCorsHeaders(request, env),
    },
  });
}

/**
 * 发送纯文本响应（带CORS）
 */
function text(text, status = 200, request, env) {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      ...getCorsHeaders(request, env),
    },
  });
}

/**
 * 预检请求处理（CORS）
 */
function corsPreflight(request, env) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request, env),
  });
}

/**
 * 鉴权检查
 */
function assertAuth(request, env) {
  const expected = env.AUTH_TOKEN;
  if (!expected) {
    throw json({ error: 'server_not_configured', message: 'Missing AUTH_TOKEN env' }, 500, request, env);
  }
  const got = request.headers.get('authorization') || '';
  const ok = got === `Bearer ${expected}`;
  if (!ok) {
    throw json({ error: 'unauthorized' }, 401, request, env);
  }
}

/**
 * 解析JSON请求体
 */
async function parseJsonBody(request, env) {
  try {
    return await request.json();
  } catch (e) {
    throw json({ error: 'invalid_json', message: e?.message || String(e) }, 400, request, env);
  }
}

/**
 * 规范化对象键
 */
function normalizeKey(key) {
  if (!key || typeof key !== 'string') return '';
  let k = key.trim().replace(/\/+/g, '/');
  if (k.startsWith('/')) k = k.slice(1);
  return k;
}

/**
 * 为前缀创建占位对象（.keep）
 */
async function ensureParentPrefixes(bucket, key) {
  const parts = key.split('/');
  if (parts.length <= 1) return;

  for (let i = 0; i < parts.length - 1; i++) {
    const prefix = parts.slice(0, i + 1).join('/');
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
 */
async function handleUpload(request, env) {
  try {
    assertAuth(request, env);
    const body = await parseJsonBody(request, env);
    const key = normalizeKey(String(body.key || ''));
    if (!key) return json({ error: 'missing_key' }, 400, request, env);
    const data = body.data ?? null;
    if (data === null || typeof data === 'undefined') {
      return json({ error: 'missing_data' }, 400, request, env);
    }

    if (!env.R2_BUCKET) {
      console.error('R2_BUCKET not bound');
      return json({ error: 'r2_not_configured', message: 'R2_BUCKET not bound. Please bind R2 bucket in Workers settings.' }, 500, request, env);
    }

    await ensureParentPrefixes(env.R2_BUCKET, key);
    const jsonData = JSON.stringify(data);
    const putRes = await env.R2_BUCKET.put(key, jsonData, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });

    return json({ ok: true, key, size: putRes.size }, 200, request, env);
  } catch (error) {
    console.error('Upload error:', error);
    if (error instanceof Response) throw error;
    return json({ error: 'upload_failed', message: error?.message || String(error) }, 500, request, env);
  }
}

/**
 * 处理列出对象
 */
async function handleList(request, env) {
  assertAuth(request, env);
  const url = new URL(request.url);
  const prefix = normalizeKey(url.searchParams.get('prefix') || '');

  if (!env.R2_BUCKET) {
    return json({ error: 'r2_not_configured', message: 'R2_BUCKET not bound' }, 500, request, env);
  }

  const list = await env.R2_BUCKET.list({ prefix });
  const items = (list.objects || []).map((o) => ({
    key: o.key,
    lastModified: o.uploaded?.toISOString?.() || new Date().toISOString(),
    size: o.size,
  }));

  return json({ items }, 200, request, env);
}

/**
 * 处理下载
 */
async function handleDownload(request, env) {
  assertAuth(request, env);
  const url = new URL(request.url);
  const key = normalizeKey(url.searchParams.get('key') || '');
  if (!key) return json({ error: 'missing_key' }, 400, request, env);

  if (!env.R2_BUCKET) {
    return json({ error: 'r2_not_configured', message: 'R2_BUCKET not bound' }, 500, request, env);
  }

  const obj = await env.R2_BUCKET.get(key);
  if (!obj) return json({ error: 'not_found' }, 404, request, env);
  const textData = await obj.text();

  try {
    const parsed = JSON.parse(textData);
    return json(parsed, 200, request, env);
  } catch (e) {
    return new Response(textData, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        ...getCorsHeaders(request, env),
      },
    });
  }
}

/**
 * 处理删除
 */
async function handleDelete(request, env) {
  assertAuth(request, env);
  const url = new URL(request.url);
  const key = normalizeKey(url.searchParams.get('key') || '');
  if (!key) return json({ error: 'missing_key' }, 400, request, env);

  if (!env.R2_BUCKET) {
    return json({ error: 'r2_not_configured', message: 'R2_BUCKET not bound' }, 500, request, env);
  }

  await env.R2_BUCKET.delete(key);
  return json({ ok: true }, 200, request, env);
}

/**
 * 处理确保前缀存在
 */
async function handleEnsure(request, env) {
  assertAuth(request, env);
  const body = await parseJsonBody(request, env);
  const prefix = normalizeKey(String(body.prefix || ''));
  if (!prefix) return json({ error: 'missing_prefix' }, 400, request, env);

  if (!env.R2_BUCKET) {
    return json({ error: 'r2_not_configured', message: 'R2_BUCKET not bound' }, 500, request, env);
  }

  await ensureParentPrefixes(env.R2_BUCKET, `${prefix.replace(/\/$/, '')}/dummy.json`);
  return json({ ok: true }, 200, request, env);
}

export default {
  async fetch(request, env) {
    const { method } = request;
    if (method === 'OPTIONS') return corsPreflight(request, env);

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+/g, '/');

    try {
      if (method === 'POST' && pathname === '/upload') return await handleUpload(request, env);
      if (method === 'GET' && pathname === '/list') return await handleList(request, env);
      if (method === 'GET' && pathname === '/download') return await handleDownload(request, env);
      if (method === 'DELETE' && pathname === '/delete') return await handleDelete(request, env);
      if (method === 'POST' && pathname === '/ensure') return await handleEnsure(request, env);
      return text('not found', 404, request, env);
    } catch (err) {
      console.error(`Error handling ${method} ${pathname}:`, err);
      if (err instanceof Response) return err;
      return json({ error: 'internal_error', message: err?.message || String(err), stack: err?.stack }, 500, request, env);
    }
  },
};