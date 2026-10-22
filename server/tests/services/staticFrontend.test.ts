import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { mountStaticFrontend } from '../../src/services/staticFrontend.js';

const temporaryDirectories: string[] = [];

/** Creates a temporary SPA distribution that also contains an API-path collision. */
function createStaticDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-static-'));
  temporaryDirectories.push(directory);
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>GithubStarsManager</title>');
  fs.writeFileSync(path.join(directory, 'app.js'), 'window.appLoaded = true;');
  fs.mkdirSync(path.join(directory, 'api'));
  fs.writeFileSync(path.join(directory, 'api', 'not-found'), 'must not shadow an API path');
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('mountStaticFrontend', () => {
  it('allows configured frontend connections while retaining the API security policy', async () => {
    const app = express();
    app.use(helmet());
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
    mountStaticFrontend(app, createStaticDirectory(), 'http://127.0.0.1:11434,https://vector.example');

    const page = await request(app).get('/').expect(200);
    expect(page.headers['content-security-policy']).toContain("connect-src 'self' http://127.0.0.1:11434 https://vector.example");
    expect(page.headers['content-security-policy']).toContain("img-src 'self' data: https://avatars.githubusercontent.com");
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    const api = await request(app).get('/api/health').expect(200);
    expect(api.headers['content-security-policy']).not.toContain('https://vector.example');
  });

  it('does not change a standalone backend when STATIC_DIR is absent', () => {
    const app = express();
    expect(mountStaticFrontend(app, undefined)).toBe(false);
  });

  it.each(['https://example.com/path', 'https://user:password@example.com', '*'])('rejects a non-origin CSP source: %s', (source) => {
    expect(() => mountStaticFrontend(express(), createStaticDirectory(), source)).toThrow();
  });

  it('serves assets and SPA deep links without intercepting backend paths', async () => {
    const app = express();
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
    expect(mountStaticFrontend(app, createStaticDirectory())).toBe(true);

    await request(app).get('/app.js').expect(200).expect('Content-Type', /javascript/);
    const spaResponse = await request(app).get('/repositories/42').expect(200);
    expect(spaResponse.text).toContain('GithubStarsManager');
    await request(app).get('/api/health').expect(200, { status: 'ok' });
    await request(app).get('/api/not-found').expect(404);
    await request(app).get('/mcp').expect(404);
    await request(app).get('/sse').expect(404);
    await request(app).get('/messages').expect(404);
    await request(app).get('/.well-known/oauth-protected-resource').expect(404);
  });

  it('does not mount an incomplete static directory', () => {
    const app = express();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-static-empty-'));
    temporaryDirectories.push(directory);
    expect(mountStaticFrontend(app, directory)).toBe(false);
  });
});
