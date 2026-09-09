/**
 * GitHub Stars Vectorize — standalone dashboard fallback
 *
 * The canonical Wrangler deployment entrypoint is src/index.ts. This file is
 * retained only for the documented Cloudflare Dashboard paste fallback and
 * must remain behaviorally aligned with that entrypoint.
 *
 * 纯 Vectorize 存/查/删代理，不持有任何 AI Key。
 * 前端负责 Embedding 生成，Worker 只负责向量存储和检索。
 */

// Public browser API contract: wildcard CORS is intentional because every
// read/write route requires the explicit bearer token and cookie credentials
// are never enabled.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Keep this fallback aligned with src/metadata.ts. Vectorize's hard per-vector
// metadata limit is 10 KiB; the margin protects against small future fields and
// JSON escape overhead.
const VECTORIZE_METADATA_SAFE_BYTES = 9_500;
const encoder = new TextEncoder();

function utf8ByteLength(value) {
  return encoder.encode(value).byteLength;
}

function jsonByteLength(value) {
  return utf8ByteLength(JSON.stringify(value) ?? '');
}

function truncateUtf8(value, maxBytes) {
  if (maxBytes <= 0) return '';
  if (utf8ByteLength(value) <= maxBytes) return value;

  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(codePoints.slice(0, middle).join('')) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return codePoints.slice(0, low).join('');
}

function normalizeMetadata(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {};
  const metadata = {
    full_name: typeof source.full_name === 'string' ? source.full_name : '',
    description: typeof source.description === 'string' ? source.description : '',
    language: typeof source.language === 'string' ? source.language : '',
    stars: typeof source.stars === 'number' && Number.isFinite(source.stars) ? source.stars : 0,
    tags: Array.isArray(source.tags) ? source.tags.filter((tag) => typeof tag === 'string') : [],
  };
  if (typeof source.license === 'string') metadata.license = source.license;
  return metadata;
}

function truncateTags(tags, maxBytes) {
  if (maxBytes <= 0) return [];
  const result = [];
  for (const tag of tags) {
    const candidate = [...result, tag];
    if (jsonByteLength(candidate) <= maxBytes) {
      result.push(tag);
      continue;
    }

    const codePoints = Array.from(tag);
    let low = 0;
    let high = codePoints.length;
    let best = '';
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const shortened = codePoints.slice(0, middle).join('');
      if (jsonByteLength([...result, shortened]) <= maxBytes) {
        best = shortened;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best) result.push(best);
    break;
  }
  return result;
}

function compactVectorMetadata(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : null;
  if (source && jsonByteLength(source) <= VECTORIZE_METADATA_SAFE_BYTES) {
    return { ...source };
  }

  const metadata = normalizeMetadata(input);
  if (jsonByteLength(metadata) <= VECTORIZE_METADATA_SAFE_BYTES) {
    return { ...metadata };
  }

  const variableBytes = Math.max(
    utf8ByteLength(metadata.description),
    jsonByteLength(metadata.tags),
  );
  let low = 0;
  let high = variableBytes;
  let best = { ...metadata, description: '', tags: [] };

  while (low <= high) {
    const cap = Math.floor((low + high) / 2);
    const candidate = {
      ...(source ?? metadata),
      description: truncateUtf8(metadata.description, cap),
      tags: truncateTags(metadata.tags, cap),
    };
    if (jsonByteLength(candidate) <= VECTORIZE_METADATA_SAFE_BYTES) {
      best = candidate;
      low = cap + 1;
    } else {
      high = cap - 1;
    }
  }

  if (jsonByteLength(best) <= VECTORIZE_METADATA_SAFE_BYTES) return best;

  const fallback = {
    full_name: truncateUtf8(metadata.full_name, 512),
    description: '',
    language: truncateUtf8(metadata.language, 128),
    stars: metadata.stars,
    tags: [],
  };
  if (metadata.license) fallback.license = truncateUtf8(metadata.license, 256);
  if (jsonByteLength(fallback) > VECTORIZE_METADATA_SAFE_BYTES) delete fallback.license;
  return fallback;
}

function compactUpsertVectors(vectors) {
  return vectors.map((vector) => {
    if (vector.metadata === undefined) return { ...vector };
    return {
      ...vector,
      metadata: compactVectorMetadata(vector.metadata),
    };
  });
}

const QUERY_TOPK_LIMIT = 50;
const QUERY_DEFAULT_TOPK = 20;
const QUERY_DEFAULT_THRESHOLD = 0.35;

function jsonResponse(data, status = 200) {
  return Response.json(data, {
    status,
    headers: CORS_HEADERS,
  });
}

export default {
  async fetch(request, env) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // 认证
    if (!env.AUTH_TOKEN) {
      return jsonResponse({ success: false, error: 'Server auth not configured' }, 500);
    }
    const token = request.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    if (token !== env.AUTH_TOKEN) {
      return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);

    try {
      // POST /upsert — 批量写入向量
      if (request.method === 'POST' && url.pathname === '/upsert') {
        const { vectors } = await request.json();
        if (!Array.isArray(vectors) || vectors.length === 0) {
          return jsonResponse({ success: false, error: 'vectors array required' }, 400);
        }
        const compactedVectors = compactUpsertVectors(vectors);
        await env.VECTORIZE.upsert(compactedVectors);
        return jsonResponse({ success: true, upserted: vectors.length });
      }

      // POST /query — 向量相似度查询
      if (request.method === 'POST' && url.pathname === '/query') {
        const { vector, topK = QUERY_DEFAULT_TOPK, threshold = QUERY_DEFAULT_THRESHOLD } = await request.json();
        if (!Array.isArray(vector) || vector.length === 0) {
          return jsonResponse({ success: false, error: 'vector array required' }, 400);
        }
        // returnMetadata:'all' caps topK at 50 (Vectorize V2 limits); clamp so
        // an oversized/negative/NaN topK degrades gracefully instead of erroring.
        const requestedTopK = typeof topK === 'number' && Number.isFinite(topK)
          ? Math.floor(topK)
          : QUERY_DEFAULT_TOPK;
        const clampedTopK = Math.min(Math.max(requestedTopK, 1), QUERY_TOPK_LIMIT);
        const matches = await env.VECTORIZE.query(vector, {
          topK: clampedTopK,
          returnMetadata: 'all',
        });
        // 过滤低分结果
        const filtered = matches.matches.filter((m) => m.score >= threshold);
        return jsonResponse({ success: true, matches: filtered });
      }

      // POST /delete — 删除指定向量
      if (request.method === 'POST' && url.pathname === '/delete') {
        const { ids } = await request.json();
        if (!Array.isArray(ids) || ids.length === 0) {
          return jsonResponse({ success: false, error: 'ids array required' }, 400);
        }
        await env.VECTORIZE.deleteByIds(ids);
        return jsonResponse({ success: true, deleted: ids.length });
      }

      // POST /cleanup — 删除不在 keepIds 列表中的向量（清理已 unstar 的仓库）
      if (request.method === 'POST' && url.pathname === '/cleanup') {
        const { keepIds } = await request.json();
        if (!Array.isArray(keepIds)) {
          return jsonResponse({ success: false, error: 'keepIds array required' }, 400);
        }
        const keepSet = new Set(keepIds);
        const info = await env.VECTORIZE.describe();
        if ((info.vectorCount ?? 0) === 0) {
          return jsonResponse({ success: true, deleted: 0 });
        }
        // 使用 query + 零向量采样，循环删除不在 keepSet 中的向量
        const dimensions = info.dimensions ?? 1536;
        let totalDeleted = 0;
        const zeroVector = new Array(dimensions).fill(0);
        for (let round = 0; round < 10; round++) {
          const result = await env.VECTORIZE.query(zeroVector, {
            topK: 100,
            returnMetadata: 'none',
          });
          const staleIds = result.matches
            .filter((m) => !keepSet.has(m.id))
            .map((m) => m.id);
          if (staleIds.length === 0) break;
          await env.VECTORIZE.deleteByIds(staleIds);
          totalDeleted += staleIds.length;
        }
        return jsonResponse({ success: true, deleted: totalDeleted });
      }

      // GET /status — 返回索引信息
      if (request.method === 'GET' && url.pathname === '/status') {
        const info = await env.VECTORIZE.describe();
        return jsonResponse({
          success: true,
          vectorCount: info.vectorCount ?? 0,
          dimensions: info.dimensions ?? 0,
        });
      }

      return jsonResponse({ error: 'Not Found' }, 404);
    } catch {
      return jsonResponse({ success: false, error: 'Vectorize request failed' }, 500);
    }
  },
};
