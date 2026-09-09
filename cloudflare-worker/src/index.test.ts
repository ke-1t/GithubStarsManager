// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import worker from './index';

type WorkerEnv = Parameters<typeof worker.fetch>[1];

function makeEnv() {
  return {
    AUTH_TOKEN: 'worker-token',
    VECTORIZE: {
      describe: vi.fn().mockResolvedValue({ vectorCount: 3, dimensions: 2 }),
      query: vi.fn().mockResolvedValue({ matches: [] }),
      upsert: vi.fn().mockResolvedValue(undefined),
      deleteByIds: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as WorkerEnv;
}

function makeRequest(path: string, init: RequestInit = {}) {
  return new Request(`https://github-stars-vectorize.example${path}`, init);
}

async function loadStandaloneFallback() {
  const source = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  const module = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`) as {
    default: typeof worker;
  };
  return module.default;
}

describe('Cloudflare Worker origin contract', () => {
  it('keeps the authenticated public browser API readable from configured deployments', async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      makeRequest('/status', {
        headers: {
          Origin: 'https://app.example',
          Authorization: 'Bearer worker-token',
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('requires the bearer token for both read and mutation routes regardless of origin', async () => {
    const env = makeEnv();
    const missing = await worker.fetch(
      makeRequest('/status', { headers: { Origin: 'https://evil.example' } }),
      env,
    );
    expect(missing.status).toBe(401);

    const deniedMutation = await worker.fetch(
      makeRequest('/delete', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids: ['1'] }),
      }),
      env,
    );
    expect(deniedMutation.status).toBe(401);
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();

    const allowedMutation = await worker.fetch(
      makeRequest('/delete', {
        method: 'POST',
        headers: {
          Origin: 'https://app.example',
          Authorization: 'Bearer worker-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids: ['1'] }),
      }),
      env,
    );
    expect(allowedMutation.status).toBe(200);
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledWith(['1']);
  });

  it('answers preflight without authentication and advertises only the worker API methods', async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      makeRequest('/delete', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization, Content-Type',
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('does not expose Vectorize exception details', async () => {
    const env = makeEnv();
    const sentinel = 'internal-binding-detail-sentinel';
    env.VECTORIZE.describe = vi.fn().mockRejectedValue(new Error(sentinel));

    const response = await worker.fetch(
      makeRequest('/status', {
        headers: { Authorization: 'Bearer worker-token' },
      }),
      env,
    );
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe('Vectorize request failed');
    expect(JSON.stringify(body)).not.toContain(sentinel);
  });
});

describe('Cloudflare Worker standalone fallback parity', () => {
  it('keeps the fallback aligned with the canonical auth, query, and failure contract', async () => {
    const fallback = await loadStandaloneFallback();
    const env = makeEnv();

    const invalid = await fallback.fetch(
      makeRequest('/status', { headers: { Authorization: 'Bearer invalid' } }),
      env,
    );
    expect(invalid.status).toBe(401);
    expect(env.VECTORIZE.describe).not.toHaveBeenCalled();

    const preflight = await fallback.fetch(
      makeRequest('/delete', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization, Content-Type',
        },
      }),
      env,
    );
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBeNull();

    vi.mocked(env.VECTORIZE.query).mockResolvedValueOnce({
      matches: [
        { id: 'below-threshold', score: 0.34 },
        { id: 'at-threshold', score: 0.35 },
      ],
    } as never);

    const query = await fallback.fetch(
      makeRequest('/query', {
        method: 'POST',
        headers: { Authorization: 'Bearer worker-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ vector: [0.1] }),
      }),
      env,
    );
    expect(query.status).toBe(200);
    expect(env.VECTORIZE.query).toHaveBeenCalledWith([0.1], {
      topK: 20,
      returnMetadata: 'all',
    });
    await expect(query.json()).resolves.toEqual({
      success: true,
      matches: [{ id: 'at-threshold', score: 0.35 }],
    });

    vi.mocked(env.VECTORIZE.query).mockClear();
    const clamped = await fallback.fetch(
      makeRequest('/query', {
        method: 'POST',
        headers: { Authorization: 'Bearer worker-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ vector: [0.1], topK: -10, threshold: 0.35 }),
      }),
      env,
    );
    expect(clamped.status).toBe(200);
    expect(env.VECTORIZE.query).toHaveBeenCalledWith([0.1], {
      topK: 1,
      returnMetadata: 'all',
    });

    const oversizedDescription = 'x'.repeat(20_000);
    const upsert = await fallback.fetch(
      makeRequest('/upsert', {
        method: 'POST',
        headers: { Authorization: 'Bearer worker-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vectors: [{
            id: '1',
            values: [0.1],
            metadata: {
              full_name: 'owner/repository',
              description: oversizedDescription,
              language: 'TypeScript',
              stars: 1,
              tags: ['search'],
            },
          }],
        }),
      }),
      env,
    );
    expect(upsert.status).toBe(200);
    const [compactedVectors] = vi.mocked(env.VECTORIZE.upsert).mock.calls[0] ?? [];
    expect(new TextEncoder().encode(JSON.stringify(compactedVectors?.[0]?.metadata)).byteLength)
      .toBeLessThanOrEqual(9_500);
    expect(compactedVectors?.[0]?.id).toBe('1');

    const malformed = await fallback.fetch(
      makeRequest('/query', {
        method: 'POST',
        headers: { Authorization: 'Bearer worker-token', 'Content-Type': 'application/json' },
        body: '{malformed',
      }),
      env,
    );
    const malformedBody = await malformed.json() as { error?: string };
    expect(malformed.status).toBe(500);
    expect(malformedBody.error).toBe('Vectorize request failed');
    expect(JSON.stringify(malformedBody)).not.toContain('malformed');

    const sentinel = 'internal-binding-detail-sentinel';
    vi.mocked(env.VECTORIZE.describe).mockRejectedValueOnce(new Error(sentinel));
    const upstreamFailure = await fallback.fetch(
      makeRequest('/status', { headers: { Authorization: 'Bearer worker-token' } }),
      env,
    );
    const upstreamBody = await upstreamFailure.json() as { error?: string };
    expect(upstreamFailure.status).toBe(500);
    expect(upstreamBody.error).toBe('Vectorize request failed');
    expect(JSON.stringify(upstreamBody)).not.toContain(sentinel);

    const unsupported = await fallback.fetch(
      makeRequest('/status', { method: 'PUT', headers: { Authorization: 'Bearer worker-token' } }),
      env,
    );
    expect(unsupported.status).toBe(404);
  });
});
