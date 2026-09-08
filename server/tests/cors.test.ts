import request from 'supertest';
import { describe, expect, it } from 'vitest';

process.env.API_SECRET = 'test-api-secret';

const { createApp } = await import('../src/index.js');
const app = createApp();

const allowedOrigin = 'http://localhost:5173';
const previewOrigin = 'http://127.0.0.1:4173';
const rejectedOrigin = 'https://evil.example';
const authHeader = 'Bearer test-api-secret';

describe('HTTP CORS boundary', () => {
  it('keeps the credentialless health check broadly readable', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', rejectedOrigin);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('keeps health preflight limited to the read-only health methods', async () => {
    const response = await request(app)
      .options('/api/health')
      .set('Origin', rejectedOrigin)
      .set('Access-Control-Request-Method', 'GET');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toBe('GET,HEAD');
  });

  it('allows the known local frontend origin on an authenticated API route', async () => {
    const response = await request(app)
      .get('/api/logs/debug')
      .set('Origin', allowedOrigin)
      .set('Authorization', authHeader);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.headers.vary).toContain('Origin');
  });

  it('allows the known local preview origin on an authenticated API route', async () => {
    const response = await request(app)
      .get('/api/logs/debug')
      .set('Origin', previewOrigin)
      .set('Authorization', authHeader);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(previewOrigin);
  });

  it('does not grant an unsupported browser origin access to an authenticated API response', async () => {
    const response = await request(app)
      .get('/api/logs/debug')
      .set('Origin', rejectedOrigin)
      .set('Authorization', authHeader);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('handles allowed and rejected preflight requests separately', async () => {
    const allowed = await request(app)
      .options('/api/logs/debug')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization');
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(allowed.headers['access-control-allow-headers']).toContain('Authorization');

    const rejected = await request(app)
      .options('/api/logs/debug')
      .set('Origin', rejectedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows the Electron file origin only when explicitly configured', async () => {
    const previous = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = 'null';

    try {
      const response = await request(app)
        .get('/api/logs/debug')
        .set('Origin', 'null')
        .set('Authorization', authHeader);

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('null');
    } finally {
      if (previous === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
      else process.env.CORS_ALLOWED_ORIGINS = previous;
    }
  });

  it('does not add a CORS grant to non-browser requests', async () => {
    const response = await request(app)
      .get('/api/logs/debug')
      .set('Authorization', authHeader);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('applies the same origin boundary to the authenticated MCP transport', async () => {
    const allowed = await request(app)
      .options('/mcp')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization,Content-Type');
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(allowedOrigin);

    const rejected = await request(app)
      .options('/mcp')
      .set('Origin', rejectedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization,Content-Type');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });
});
