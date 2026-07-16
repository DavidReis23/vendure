import { Logger } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpToolCallLog } from '../entities/mcp-tool-call-log.entity';
import { McpToolCallEvent } from '../events/mcp-tool-call.event';
import { McpPluginOptions } from '../types';

import { McpOperationsService, McpRateLimitExceededError } from './mcp-operations.service';

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

/** Options to steer the persistence / event-publish / delete mocks. */
interface LoggingFailures {
    saveThrows?: boolean;
    publishThrows?: boolean;
    deleteAffected?: number;
}

function build(options: McpPluginOptions, failures: LoggingFailures = {}) {
    const cache = makeCache();
    const savedLogs: McpToolCallLog[] = [];
    const publishedEvents: McpToolCallEvent[] = [];
    const selectWhere: Array<{ clause: string; params: Record<string, unknown> }> = [];
    const deleteWhere: Array<{ clause: string; params: Record<string, unknown> }> = [];
    const save = vi.fn((entity: McpToolCallLog) => {
        if (failures.saveThrows) {
            return Promise.reject(new Error('save failed'));
        }
        entity.id = savedLogs.length + 1;
        savedLogs.push(entity);
        return Promise.resolve(entity);
    });
    // Query-builder mock for the batched retention prune: a SELECT
    // (.select().where().limit().getRawMany()) hands out up to `limit` expired-row ids, then a DELETE
    // (.delete().where('id IN ...').execute()) removes them. `failures.deleteAffected` seeds how many
    // expired rows exist so the prune loop drains them and terminates.
    let remainingExpired = failures.deleteAffected ?? 0;
    const createQueryBuilder = () => {
        const qb: any = {
            _mode: 'select',
            _limit: undefined as number | undefined,
            _deleteIds: [] as unknown[],
            select: () => {
                qb._mode = 'select';
                return qb;
            },
            delete: () => {
                qb._mode = 'delete';
                return qb;
            },
            where: (clause: string, params: Record<string, unknown>) => {
                if (qb._mode === 'delete') {
                    qb._deleteIds = (params.ids as unknown[]) ?? [];
                    deleteWhere.push({ clause, params });
                } else {
                    selectWhere.push({ clause, params });
                }
                return qb;
            },
            limit: (n: number) => {
                qb._limit = n;
                return qb;
            },
            getRawMany: () => {
                const n = Math.min(remainingExpired, qb._limit ?? remainingExpired);
                return Promise.resolve(Array.from({ length: n }, (_, i) => ({ id: i + 1 })));
            },
            execute: () => {
                remainingExpired -= qb._deleteIds.length;
                return Promise.resolve({ affected: qb._deleteIds.length });
            },
        };
        return qb;
    };
    const connection = { getRepository: () => ({ save, createQueryBuilder }) };
    const publish = vi.fn((event: McpToolCallEvent) => {
        if (failures.publishThrows) {
            return Promise.reject(new Error('subscriber failed'));
        }
        publishedEvents.push(event);
        return Promise.resolve();
    });
    const eventBus = { publish };
    const service = new McpOperationsService(cache as any, connection as any, eventBus as any, options);
    return { service, cache, savedLogs, publishedEvents, selectWhere, deleteWhere, save, publish };
}

/** An execution context with a distinct Vendure session token (per-subject keying). */
function sessionCtx(token: string) {
    return { ctx: { session: { token } }, clientIp: undefined } as any;
}

/** An anonymous shop execution context keyed by client IP (no session, no grant). */
function anonCtx(ip: string) {
    return { ctx: { session: undefined }, clientIp: ip } as any;
}

/** Minimal registered-tool stand-in for the logger (only name/pluginSource are read). */
function toolStub(name: string, pluginSource: string | null = 'TestPlugin') {
    return { name, pluginSource } as any;
}

describe('McpOperationsService rate limiting', () => {
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
        const ctx = anonCtx('1.2.3.4');
        await service.enforceRateLimit({ executionContext: ctx, endpoint: 'shop', subject: 'tools/call' });
        await service.enforceRateLimit({ executionContext: ctx, endpoint: 'shop', subject: 'tools/call' });
        const exceeded = await service.checkRateLimit({
            executionContext: ctx,
            endpoint: 'shop',
            subject: 'tools/call',
        });
        expect(exceeded?.scope).toBe('anonymous IP');
    });

    it('does not apply the anonymous-IP limit when disabled (anonymousIp: false)', async () => {
        const { service } = build({
            rateLimits: { perSession: { rpm: 0 }, perClient: { rpm: 0 }, anonymousIp: false },
        });
        const ctx = anonCtx('1.2.3.4');
        for (let i = 0; i < 5; i++) {
            expect(
                await service.checkRateLimit({
                    executionContext: ctx,
                    endpoint: 'shop',
                    subject: 'tools/call',
                }),
            ).toBeUndefined();
        }
    });

    it('does not apply the anonymous-IP limit on the admin endpoint', async () => {
        const { service } = build({
            rateLimits: { perSession: { rpm: 0 }, perClient: { rpm: 0 }, anonymousIp: { rpm: 1 } },
        });
        const ctx = anonCtx('1.2.3.4');
        for (let i = 0; i < 3; i++) {
            expect(
                await service.checkRateLimit({ executionContext: ctx, endpoint: 'admin', subject: 'ping' }),
            ).toBeUndefined();
        }
    });
});

describe('McpOperationsService tool-call logging', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        warnSpy.mockRestore();
    });

    // NOTE: the grant → row scalar field mapping (grantId/actor/actorType/channelId/status/etc.)
    // is verified in the e2e, where the production tsc build + TypeORM persist a real row. It is
    // NOT asserted here: this unit suite is transpiled by SWC with `useDefineForClassFields: true`,
    // so the entity's declared class fields re-initialise to `undefined` after `super(input)` sets
    // them — an artifact of the test transpiler, not the production build. Redaction and the
    // event/never-throws contract below do not depend on that (input/output and the event payload
    // are assigned after construction), so they are asserted directly.

    it('does not store input/output under the default metadata capture', async () => {
        const { service, savedLogs } = build({});
        await service.logToolCall({
            executionContext: { ctx: { apiType: 'shop', channelId: 1 } } as any,
            tool: toolStub('t'),
            input: { email: 'a@b.com', note: 'hi' },
            output: { customer: { emailAddress: 'a@b.com' } },
            durationMs: 1,
            status: 'success',
        });
        // Metadata capture is the default: the row carries no request/response bodies at all.
        expect(savedLogs[0].input).toBeNull();
        expect(savedLogs[0].output).toBeNull();
    });

    it("stores raw input/output verbatim when capture is 'full' and no redact function is set", async () => {
        const { service, savedLogs } = build({ logging: { capture: 'full' } });
        const input = { email: 'a@b.com', nested: { password: 'p' } };
        const output = { token: 'shown' };
        await service.logToolCall({
            executionContext: { ctx: { apiType: 'shop', channelId: 1 } } as any,
            tool: toolStub('t'),
            input,
            output,
            durationMs: 1,
            status: 'success',
        });
        // No built-in redaction: the plugin stores exactly what the tool sent/returned.
        expect(savedLogs[0].input).toEqual(input);
        expect(savedLogs[0].output).toEqual(output);
    });

    it("applies the operator redact function when capture is 'full', persisting exactly what it returns", async () => {
        const seen: unknown[] = [];
        const redact = vi.fn((entry: { toolName: string; input: unknown; output: unknown }) => {
            seen.push(entry);
            return { input: { redacted: true }, output: null };
        });
        const { service, savedLogs } = build({ logging: { capture: 'full', redact } });
        await service.logToolCall({
            executionContext: { ctx: { apiType: 'shop', channelId: 1 } } as any,
            tool: toolStub('my_tool'),
            input: { email: 'a@b.com' },
            output: { secret: 1 },
            durationMs: 1,
            status: 'success',
        });
        // The plugin calls the operator function with the tool name + the raw input/output...
        expect(redact).toHaveBeenCalledOnce();
        expect(seen[0]).toEqual({
            toolName: 'my_tool',
            input: { email: 'a@b.com' },
            output: { secret: 1 },
        });
        // ...and persists exactly what it returns (a null body is stored as null).
        expect(savedLogs[0].input).toEqual({ redacted: true });
        expect(savedLogs[0].output).toBeNull();
    });

    it('publishes a McpToolCallEvent carrying the persisted row, for success and error', async () => {
        const { service, savedLogs, publishedEvents } = build({});
        const ctx = { apiType: 'shop', channelId: 1 } as any;
        await service.logToolCall({
            executionContext: { ctx } as any,
            tool: toolStub('t'),
            input: { email: 'a@b.com' },
            output: {},
            durationMs: 1,
            status: 'success',
        });
        await service.logToolCall({
            executionContext: { ctx } as any,
            tool: toolStub('t'),
            input: {},
            output: { message: 'boom' },
            durationMs: 1,
            status: 'error',
        });
        expect(publishedEvents).toHaveLength(2);
        expect(publishedEvents[0]).toBeInstanceOf(McpToolCallEvent);
        // The event carries the exact persisted row instance, not a copy.
        expect(publishedEvents[0].entry).toBe(savedLogs[0]);
        expect(publishedEvents[1].entry).toBe(savedLogs[1]);
        expect(publishedEvents[0].ctx).toBe(ctx);
        // Default metadata capture: the persisted row (and thus the event) carries no input body.
        expect(publishedEvents[0].entry.input).toBeNull();
    });

    it('never throws and warns when the write fails (no event published)', async () => {
        const { service, publishedEvents } = build({}, { saveThrows: true });
        await expect(
            service.logToolCall({
                executionContext: { ctx: { apiType: 'shop', channelId: 1 } } as any,
                tool: toolStub('t'),
                input: {},
                output: {},
                durationMs: 1,
                status: 'success',
            }),
        ).resolves.toBeUndefined();
        expect(publishedEvents).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy.mock.calls[0][0]).toMatch(/Failed to record MCP tool call/);
    });

    it('never throws and warns distinctly when publish rejects after the row is saved', async () => {
        const { service, savedLogs } = build({}, { publishThrows: true });
        await expect(
            service.logToolCall({
                executionContext: { ctx: { apiType: 'shop', channelId: 1 } } as any,
                tool: toolStub('t'),
                input: {},
                output: {},
                durationMs: 1,
                status: 'success',
            }),
        ).resolves.toBeUndefined();
        expect(savedLogs).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy.mock.calls[0][0]).toMatch(/publishing its McpToolCallEvent failed/);
    });

    it('deleteExpiredToolCallLogs filters createdAt by the configured ttlDays and returns the count', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
        try {
            const { service, selectWhere } = build({ logging: { ttlDays: 10 } }, { deleteAffected: 3 });
            const count = await service.deleteExpiredToolCallLogs({} as any);
            expect(count).toBe(3);
            expect(selectWhere.length).toBeGreaterThanOrEqual(1);
            expect(selectWhere[0].clause).toMatch(/createdAt < :cutoff/);
            const cutoff = selectWhere[0].params.cutoff as Date;
            expect(cutoff.toISOString()).toBe(
                new Date(Date.parse('2026-02-01T00:00:00Z') - 10 * 86_400_000).toISOString(),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('deleteExpiredToolCallLogs defaults to a 30-day window and returns 0 when nothing matched', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
        try {
            const { service, selectWhere } = build({});
            const count = await service.deleteExpiredToolCallLogs({} as any);
            expect(count).toBe(0);
            const cutoff = selectWhere[0].params.cutoff as Date;
            expect(cutoff.toISOString()).toBe(
                new Date(Date.parse('2026-02-01T00:00:00Z') - 30 * 86_400_000).toISOString(),
            );
        } finally {
            vi.useRealTimers();
        }
    });
});
