import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ routeMode: 'auto', backendApiSecret: 'backend-test-key' }));
const backendState = vi.hoisted(() => ({
  backendUrl: null as string | null,
  configuredUrl: null,
  isAvailable: true,
  init: vi.fn(),
  verifyAuth: vi.fn().mockResolvedValue(true),
  restoreAuth: vi.fn().mockResolvedValue({ github_token: 'github-test-token' }),
  rememberActiveUrl: vi.fn(),
}));

vi.mock('../../../store/useAppStore', () => ({ useAppStore: { getState: () => state } }));
vi.mock('../../../services/backendAdapter', () => ({ backend: backendState }));
vi.mock('../../../services/autoSync', () => ({ syncFromBackend: vi.fn() }));

import { useLoginActions } from './useLoginActions';

beforeEach(() => {
  backendState.backendUrl = null;
  state.routeMode = 'auto';
  backendState.init.mockImplementation(async (url: string) => {
    backendState.backendUrl = `${url}/api`;
  });
});

afterEach(() => vi.unstubAllGlobals());

it('restores login through the authenticated backend without sending the GitHub token from the browser', async () => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1, login: 'octocat' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', request);
  const { result } = renderHook(() => useLoginActions());

  await expect(result.current.restoreBackendSession('http://localhost:18082')).resolves.toMatchObject({
    status: 'connected', user: { id: 1, login: 'octocat' },
  });
  expect(request).toHaveBeenCalledOnce();
  const [url, options] = request.mock.calls[0];
  expect(url).toBe('http://localhost:18082/api/proxy/github/user');
  expect(options.method).toBe('POST');
  expect(options.headers.Authorization).toBe('Bearer backend-test-key');
  expect(options.body).toBe('{"method":"GET"}');
  expect(JSON.stringify(options)).not.toContain('github-test-token');
});
