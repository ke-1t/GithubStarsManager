import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

interface Config {
  host: string;
  port: number;
  apiSecret: string | null;
  encryptionKey: string;
  dbPath: string;
  nodeEnv: string;
}

export const DEFAULT_LISTEN_HOST = '127.0.0.1';

/** Use loopback unless the operator explicitly selects another bind address. */
export function normalizeListenHost(rawHost: string | undefined): string {
  const host = rawHost?.trim();
  return host || DEFAULT_LISTEN_HOST;
}

/** Return true only for names and addresses that are unambiguously loopback. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') {
    return true;
  }

  if (net.isIP(normalized) === 4) {
    const firstOctet = Number(normalized.split('.')[0]);
    return firstOctet === 127;
  }

  return false;
}

/** External binds must never silently start an unauthenticated API server. */
export function assertSafeListenConfig(host: string, apiSecret: string | null): void {
  if (!isLoopbackHost(host) && !apiSecret?.trim()) {
    throw new Error('API_SECRET is required when HOST is not loopback');
  }
}

/** Resolve the data directory path, creating it if it doesn't exist. */
function resolveDataDir(): string {
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

/**
 * Normalize an encryption key to a 64-char hex string (32 bytes) suitable for AES-256.
 *
 * Backward compatibility:
 * - Valid 64-char hex string → returned as-is (no change for existing users)
 * - Short hex (e.g. 32 chars from `openssl rand -hex 16`) → SHA-256 derived
 * - Non-hex input (base64, plain text, too-long hex) → SHA-256 derived
 */
export function normalizeEncryptionKey(key: string): string {
  const trimmed = key.trim();

  // Already a valid 32-byte hex key — pass through unchanged
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed;
  }

  // Hex string but wrong length — derive via SHA-256 for deterministic 32-byte result
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    console.warn(`[config] ENCRYPTION_KEY is ${trimmed.length} hex chars (expected 64). Deriving 32-byte key via SHA-256. Previously encrypted data may need re-encryption.`);
    return crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex');
  }

  // Non-hex input (base64, plain text, etc.) — derive via SHA-256
  console.warn('[config] ENCRYPTION_KEY is not a valid hex string. Deriving 32-byte key via SHA-256.');
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex');
}

/**
 * Resolve the AES-256 encryption key from env var, key file, or auto-generation.
 * All non-standard formats are normalized to a 64-char hex string (32 bytes).
 */
function resolveEncryptionKey(dataDir: string): string {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    return normalizeEncryptionKey(envKey);
  }

  const keyFilePath = path.join(dataDir, '.encryption-key');
  if (fs.existsSync(keyFilePath)) {
    const fileKey = fs.readFileSync(keyFilePath, 'utf-8').trim();
    const normalized = normalizeEncryptionKey(fileKey);
    // Persist normalized key so future startups (even without normalization) use the correct format
    if (normalized !== fileKey) {
      fs.writeFileSync(keyFilePath, normalized, { mode: 0o600 });
      console.log('[config] Normalized encryption key written back to data/.encryption-key');
    }
    return normalized;
  }

  const newKey = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFilePath, newKey, { mode: 0o600 });
  console.log('Generated new encryption key and saved to data/.encryption-key');
  return newKey;
}

/** Load all server configuration from environment variables and defaults. */
function loadConfig(): Config {
  const host = normalizeListenHost(process.env.HOST);
  const apiSecret = process.env.API_SECRET?.trim() || null;
  assertSafeListenConfig(host, apiSecret);
  const dataDir = resolveDataDir();

  return {
    host,
    port: parseInt(process.env.PORT || '3000', 10),
    apiSecret,
    encryptionKey: resolveEncryptionKey(dataDir),
    dbPath: process.env.DB_PATH || path.join(dataDir, 'data.db'),
    nodeEnv: process.env.NODE_ENV || 'development',
  };
}

export const config = loadConfig();
