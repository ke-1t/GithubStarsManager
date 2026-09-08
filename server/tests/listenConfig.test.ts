import { describe, expect, it } from 'vitest';
import {
  assertSafeListenConfig,
  isLoopbackHost,
  normalizeListenHost,
} from '../src/config.js';

describe('standalone backend listen boundary', () => {
  it('defaults to loopback and recognizes loopback names and addresses', () => {
    expect(normalizeListenHost(undefined)).toBe('127.0.0.1');
    expect(normalizeListenHost('   ')).toBe('127.0.0.1');
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.42.9.8')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('treats wildcard and non-loopback binds as external', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('192.168.1.20')).toBe(false);
    expect(isLoopbackHost('backend.internal')).toBe(false);
  });

  it('allows unauthenticated development only on loopback', () => {
    expect(() => assertSafeListenConfig('127.0.0.1', null)).not.toThrow();
    expect(() => assertSafeListenConfig('localhost', '')).not.toThrow();
    expect(() => assertSafeListenConfig('0.0.0.0', null)).toThrow(/API_SECRET/);
    expect(() => assertSafeListenConfig('::', '')).toThrow(/API_SECRET/);
    expect(() => assertSafeListenConfig('0.0.0.0', '   ')).toThrow(/API_SECRET/);
  });

  it('requires an API secret when external bind is explicitly selected', () => {
    expect(() => assertSafeListenConfig('0.0.0.0', 'test-secret')).not.toThrow();
    expect(() => assertSafeListenConfig('backend.internal', 'test-secret')).not.toThrow();
  });
});
