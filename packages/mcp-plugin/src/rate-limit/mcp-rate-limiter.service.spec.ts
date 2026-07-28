import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpPluginOptions } from '../types';

import { McpRateLimiterService, McpRateLimitExceededError } from './mcp-rate-limiter.service';

/** In-memory CacheService stand-in (TTL not enforced — reset is exercised via fake timers). */
function makeCache() {
    const store = new Map<string, unknown>();
    return {
        store,
        get: (key: string) => Promise.resolve(store.get(key)),
        set: (key: string, value: unknown) => {
            store.set(key, value);
            return Promise.resolve();
        },
        delete: (key: string) => {
            store.delete(key);
            return Promise.resolve();
        },
    };
}

function build(options: McpPluginOptions) {
    const cache = makeCache();
    const service = new McpRateLimiterService(cache as any, options);
    return { service, cache };
}

/** An execution context with a distinct Vendure session token (per-subject keying). */
function sessionCtx(token: string) {
    return { ctx: { session: { token } }, clientIp: undefined } as any;
}

/** An anonymous shop execution context keyed by client IP (no session, no grant). */
function anonCtx(ip: string) {
    return { ctx: { session: undefined }, clientIp: ip } as any;
}

describe('McpRateLimiterService rate limiting', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('consumes a bucket up to the limit, then reports exceeded with retry metadata', async () => {
        const { service } = build({
            rateLimits: { perSession: { rpm: 2 }, perClient: { rpm: 0 }, anonymousIp: false },
        });
        const ctx = sessionCtx('subject-a');
        await service.enforceRateLimit({ executionContext: ctx, endpoint: 'admin', subject: 'ping' });
        await service.enforceRateLimit({ executionContext: ctx, endpoint: 'admin', subject: 'ping' });

        const exceeded = await service.checkRateLimit({
            executionContext: ctx,
            endpoint: 'admin',
            subject: 'ping',
        });
        expect(exceeded).toBeDefined();
        expect(exceeded?.scope).toBe('session');
        expect(exceeded?.retryAfterSeconds).toBeGreaterThan(0);
        expect(exceeded?.retryAfterSeconds).toBeLessThanOrEqual(60);
        expect(exceeded?.message).toMatch(/Retry after \d+ seconds\./);
    });

    it('enforceRateLimit throws McpRateLimitExceededError once over the limit', async () => {
        const { service } = build({
            rateLimits: { perSession: { rpm: 1 }, perClient: { rpm: 0 }, anonymousIp: false },
        });
        const ctx = sessionCtx('subject-a');
        await service.enforceRateLimit({ executionContext: ctx, endpoint: 'admin', subject: 'ping' });
        await expect(
            service.enforceRateLimit({ executionContext: ctx, endpoint: 'admin', subject: 'ping' }),
        ).rejects.toBeInstanceOf(McpRateLimitExceededError);
    });

    it('resets the bucket after the 60s window elapses', async () => {
        const { service } = build({
            rateLimits: { perSession: { rpm: 1 }, perClient: { rpm: 0 }, anonymousIp: false },
        });
        const ctx = sessionCtx('subject-a');
        await service.enforceRateLimit({ executionContext: ctx, endpoint: 'admin', subject: 'ping' });
        expect(
            await service.checkRateLimit({ executionContext: ctx, endpoint: 'admin', subject: 'ping' }),
        ).toBeDefined();

        vi.setSystemTime(new Date('2026-01-01T00:01:01Z')); // +61s
        expect(
            await service.checkRateLimit({ executionContext: ctx, endpoint: 'admin', subject: 'ping' }),
        ).toBeUndefined();
    });

    it('keys per subject — exhausting subject A does not limit subject B', async () => {
        const { service } = build({
            rateLimits: { perSession: { rpm: 1 }, perClient: { rpm: 0 }, anonymousIp: false },
        });
        const a = sessionCtx('subject-a');
        const b = sessionCtx('subject-b');
        await service.enforceRateLimit({ executionContext: a, endpoint: 'admin', subject: 'ping' });
        expect(
            await service.checkRateLimit({ executionContext: a, endpoint: 'admin', subject: 'ping' }),
        ).toBeDefined();
        // B is untouched.
        expect(
            await service.checkRateLimit({ executionContext: b, endpoint: 'admin', subject: 'ping' }),
        ).toBeUndefined();
    });

    it('applies the anonymous-IP limit on shop and reports the anonymous IP scope', async () => {
        const { service } = build({
            rateLimits: { perSession: { rpm: 0 }, perClient: { rpm: 0 }, anonymousIp: { rpm: 2 } },
        });
        await service.enforceAnonymousIpRateLimit('shop', '1.2.3.4');
        await service.enforceAnonymousIpRateLimit('shop', '1.2.3.4');
        await expect(service.enforceAnonymousIpRateLimit('shop', '1.2.3.4')).rejects.toMatchObject({
            details: { scope: 'anonymous IP' },
        });
    });

    it('charges the anonymous-IP bucket at the edge only, never again in the shared pass', async () => {
        const { service } = build({
            rateLimits: { perSession: { rpm: 0 }, perClient: { rpm: 0 }, anonymousIp: { rpm: 2 } },
        });
        const ctx = anonCtx('1.2.3.4');
        // The transport charges this bucket once per request, before the context exists. If the shared
        // pass charged it again, an anonymous caller would get half the configured allowance.
        await service.enforceAnonymousIpRateLimit('shop', '1.2.3.4');
        await service.checkRateLimit({ executionContext: ctx, endpoint: 'shop', subject: 'tools/call' });
        await service.enforceAnonymousIpRateLimit('shop', '1.2.3.4');
        await expect(service.enforceAnonymousIpRateLimit('shop', '1.2.3.4')).rejects.toBeInstanceOf(
            McpRateLimitExceededError,
        );
    });

    it('does not apply the anonymous-IP limit when disabled (anonymousIp: false)', async () => {
        const { service } = build({
            rateLimits: { perSession: { rpm: 0 }, perClient: { rpm: 0 }, anonymousIp: false },
        });
        for (let i = 0; i < 5; i++) {
            await expect(service.enforceAnonymousIpRateLimit('shop', '1.2.3.4')).resolves.toBeUndefined();
        }
    });

    it('does not apply the anonymous-IP limit on the admin endpoint', async () => {
        const { service } = build({
            rateLimits: { perSession: { rpm: 0 }, perClient: { rpm: 0 }, anonymousIp: { rpm: 1 } },
        });
        for (let i = 0; i < 3; i++) {
            await expect(service.enforceAnonymousIpRateLimit('admin', '1.2.3.4')).resolves.toBeUndefined();
        }
    });
});
