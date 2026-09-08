import cors from 'cors';
import type { RequestHandler } from 'express';

/**
 * Origins used by the local Vite development and preview servers.
 * Production split/full-stack deployments serve the UI and API from one origin
 * and therefore do not need a cross-origin grant.
 */
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-MCP-Token',
  'Mcp-Session-Id',
  'mcp-session-id',
  'Last-Event-ID',
];

const CORS_EXPOSED_HEADERS = [
  'X-Log-Count',
  'Mcp-Session-Id',
  'mcp-session-id',
  'Retry-After',
  'retry-after-ms',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'x-ratelimit-remaining',
];

function configuredOrigins(): Set<string> {
  const configured = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== '*');

  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

/**
 * Exact-match origin policy. `null` is intentionally not a default: packaged
 * Electron/file documents can opt in explicitly through CORS_ALLOWED_ORIGINS.
 */
export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return configuredOrigins().has(origin);
}

/**
 * Authenticated API/MCP CORS policy. Requests without an Origin remain valid
 * for non-browser MCP clients; unsupported browser origins receive no grant.
 */
export function createCorsMiddleware(): RequestHandler {
  return cors({
    origin: (origin, callback) => {
      if (isAllowedCorsOrigin(origin)) {
        callback(null, origin || true);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    optionsSuccessStatus: 204,
  });
}

/**
 * Health is intentionally credentialless and broadly readable so uptime
 * monitors and local discovery can probe it without an API secret.
 */
export function createPublicHealthCorsMiddleware(): RequestHandler {
  return cors({
    origin: '*',
    methods: ['GET', 'HEAD'],
    optionsSuccessStatus: 204,
  });
}
