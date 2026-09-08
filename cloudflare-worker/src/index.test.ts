// @vitest-environment node

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
