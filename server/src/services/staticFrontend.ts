import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';

const backendPathPrefixes = ['/api', '/mcp', '/sse', '/messages', '/.well-known'];

/** Returns true when a URL belongs to an API, MCP, or SSE endpoint namespace. */
function isBackendPath(requestPath: string): boolean {
  return backendPathPrefixes.some(
    (prefix) => requestPath === prefix || requestPath.startsWith(`${prefix}/`)
  );
}

/**
 * Optionally serves a compiled frontend from the directory configured by STATIC_DIR.
 *
 * The standalone backend image intentionally does not set STATIC_DIR, so its routes
 * and 404 behavior remain unchanged. The full-stack image sets STATIC_DIR=/app/public.
 */
export function mountStaticFrontend(
  app: Express,
  staticDir = process.env.STATIC_DIR,
  connectOrigins = process.env.STATIC_CONNECT_ORIGINS ?? ''
): boolean {
  if (!staticDir) {
    return false;
  }

  const resolvedStaticDir = path.resolve(staticDir);
  const indexFile = path.join(resolvedStaticDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    return false;
  }

  // Browser embedding/vector clients use configured external services directly.
  // Require explicit HTTP(S) origins instead of permitting arbitrary destinations.
  const sources = connectOrigins.split(',').map((source) => source.trim()).filter(Boolean);
  for (const source of sources) {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== source) {
      throw new Error('STATIC_CONNECT_ORIGINS must contain only HTTP(S) origins');
    }
  }
  const frontendCsp = helmet.contentSecurityPolicy({
    directives: {
      connectSrc: ["'self'", ...sources],
      imgSrc: ["'self'", 'data:', 'https://avatars.githubusercontent.com'],
    },
  });
  const serveStatic = express.static(resolvedStaticDir, { index: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isBackendPath(req.path)) {
      next();
      return;
    }

    frontendCsp(req, res, () => serveStatic(req, res, next));
  });

  // Register this after all API and MCP routes. Keep their unknown paths as 404s
  // instead of returning the SPA shell.
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (isBackendPath(req.path)) {
      next();
      return;
    }

    res.sendFile(indexFile, (error) => {
      if (error) {
        next(error);
      }
    });
  });

  return true;
}
