import { Inject, Injectable } from '@nestjs/common';
import { CacheService, EventBus, ID, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { McpToolset } from '@vendure/mcp-sdk';
import { createHash } from 'node:crypto';

import { loggerCtx, MCP_PLUGIN_OPTIONS, RATE_LIMIT_CACHE_PREFIX, RATE_LIMIT_WINDOW_MS } from '../constants';
import { McpToolCallLog } from '../entities/mcp-tool-call-log.entity';
import { McpToolCallEvent } from '../events/mcp-tool-call.event';
import { McpExecutionContext, McpPluginOptions, McpRegisteredTool, McpToolCallStatus } from '../types';

const RATE_LIMIT_CACHE_TAG = 'mcp-rate-limit';

const RETENTION_DELETE_BATCH_SIZE = 500;

/** A single rate-limit bucket to check/consume. */
interface RateLimitCheck {
    key: string;
    rpm: number;
    scope: string;
}

/** In-cache state of one fixed-window bucket. */
interface BucketState {
    count: number;
    resetAt: number;
}

/** Details carried by {@link McpRateLimitExceededError}. */
export interface McpRateLimitExceeded {
    message: string;
    retryAfterSeconds: number;
    scope: string;
    subject: string;
}

/** Input to the rate-limit enforcement/check methods. */
export interface RateLimitInput {
    executionContext: McpExecutionContext;
    endpoint: McpToolset;
    toolNames?: string[];
    subject?: string;
    /** When `false`, only per-tool buckets are checked (shared session/client/anon-IP skipped). */
    includeSharedBuckets?: boolean;
}

/** Input to the (Phase-6) tool-call logger. */
export interface LogToolCallInput {
    executionContext: McpExecutionContext;
    tool: McpRegisteredTool;
    input: unknown;
    output: unknown;
    durationMs: number;
    status: McpToolCallStatus;
}

/**
 * Thrown when a rate-limit bucket is exceeded. The controller's handshake pre-check maps this to a
 * JSON-RPC `-32029` error whose `data` carries `{ retryAfterSeconds, scope }`; inside a tool call it
 * is caught and flattened to an `isError` result.
 */
export class McpRateLimitExceededError extends Error {
    constructor(public readonly details: McpRateLimitExceeded) {
        super(details.message);
        Object.setPrototypeOf(this, McpRateLimitExceededError.prototype);
    }
}

/**
 * @description
 * Central service for MCP operations:
 * - Enforces rate limits across sessions, clients, and tools
 * - Logs tool calls and publishes `McpToolCallEvent`s
 * - Cleans up expired tool-call logs
 */

@Injectable()
export class McpOperationsService {
    constructor(
        private cacheService: CacheService,
        private connection: TransactionalConnection,
        private eventBus: EventBus,
        @Inject(MCP_PLUGIN_OPTIONS) private options: McpPluginOptions,
    ) {}

    /** Throws {@link McpRateLimitExceededError} if any relevant bucket is at/over its limit. */
    async enforceRateLimit(input: RateLimitInput): Promise<void> {
        const exceeded = await this.checkRateLimit(input);
        if (exceeded) {
            throw new McpRateLimitExceededError(exceeded);
        }
    }

    /**
     * Reads every relevant bucket. If any is already at/over its `rpm`, returns the exceeded metadata
     * without consuming. Otherwise increments every bucket and returns `undefined`.
     */
    async checkRateLimit(input: RateLimitInput): Promise<McpRateLimitExceeded | undefined> {
        const checks = this.buildRateLimitChecks(input);
        if (checks.length === 0) {
            return undefined;
        }
        const now = Date.now();
        const bucketStates = await Promise.all(
            checks.map(async check => ({ check, state: await this.getBucketState(check.key, now) })),
        );
        const exceeded = bucketStates.find(({ check, state }) => state != null && state.count >= check.rpm);
        if (exceeded?.state) {
            const retryAfterSeconds = Math.max(1, Math.ceil((exceeded.state.resetAt - now) / 1000));
            const subject = input.subject ?? input.toolNames?.join(', ') ?? 'MCP request';
            return {
                message: `Rate limit exceeded for ${subject} (${exceeded.check.scope}). Retry after ${retryAfterSeconds} seconds.`,
                retryAfterSeconds,
                scope: exceeded.check.scope,
                subject,
            };
        }
        await Promise.all(bucketStates.map(({ check, state }) => this.consumeBucket(check.key, state, now)));
        return undefined;
    }

    /** Builds the list of buckets to check for a request. */
    buildRateLimitChecks(input: RateLimitInput): RateLimitCheck[] {
        const checks: RateLimitCheck[] = [];
        const endpoint = input.endpoint;
        const rateLimits = this.options.rateLimits ?? {};
        if (input.includeSharedBuckets !== false) {
            const perSessionRpm = rateLimits.perSession?.rpm ?? 0;
            if (perSessionRpm > 0) {
                checks.push({
                    key: `session:${endpoint}:${this.sessionKey(input.executionContext)}`,
                    rpm: perSessionRpm,
                    scope: 'session',
                });
            }
            const clientKey = this.clientKey(input.executionContext);
            const perClientRpm = rateLimits.perClient?.rpm ?? 0;
            if (clientKey && perClientRpm > 0) {
                checks.push({
                    key: `client:${endpoint}:${clientKey}`,
                    rpm: perClientRpm,
                    scope: 'OAuth client',
                });
            }
            const anonymousIp = rateLimits.anonymousIp;
            const anonymousIpRpm = anonymousIp === false ? 0 : (anonymousIp?.rpm ?? 0);
            if (!clientKey && endpoint === 'shop' && anonymousIpRpm > 0) {
                checks.push({
                    key: `anonymous-ip:${endpoint}:${this.ipKey(input.executionContext)}`,
                    rpm: anonymousIpRpm,
                    scope: 'anonymous IP',
                });
            }
        }
        for (const toolName of input.toolNames ?? []) {
            const rpm = rateLimits.perTool?.[toolName]?.rpm ?? 0;
            if (rpm > 0) {
                checks.push({
                    key: `tool:${endpoint}:${this.toolActorKey(input.executionContext)}:${toolName}`,
                    rpm,
                    scope: `tool:${toolName}`,
                });
            }
        }
        // De-dupe by key so a bucket is never double-counted within one request.
        return [...new Map(checks.map(check => [check.key, check])).values()];
    }

    /** Increments a bucket (creating it on first hit within the window). */
    async consumeBucket(key: string, state: BucketState | undefined, now: number): Promise<void> {
        const nextState: BucketState = state
            ? { count: state.count + 1, resetAt: state.resetAt }
            : { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
        await this.cacheService.set(this.cacheKey(key), nextState, {
            ttl: Math.max(1000, nextState.resetAt - now),
            tags: [RATE_LIMIT_CACHE_TAG],
        });
    }

    async logToolCall(input: LogToolCallInput): Promise<void> {
        const { ctx, grant } = input.executionContext;
        let saved = false;
        try {
            const log = new McpToolCallLog({
                grantId: grant?.id ?? null,
                actor: grant?.userId != null ? String(grant.userId) : null,
                actorType: grant?.userType ?? (ctx.apiType === 'admin' ? 'admin' : 'anonymous'),
                channelId: ctx.channelId ?? null,
                toolName: input.tool.name,
                pluginSource: input.tool.pluginSource,
                durationMs: input.durationMs,
                status: input.status,
                oauthClientId: grant?.oauthClientId ?? null,
            });
            const logging = this.options.logging;
            if (logging?.capture === 'full') {
                const bodies = logging.redact
                    ? logging.redact({
                          toolName: input.tool.name,
                          input: input.input,
                          output: input.output,
                      })
                    : { input: input.input, output: input.output };
                log.input = bodies.input ?? null;
                log.output = bodies.output ?? null;
            } else {
                log.input = null;
                log.output = null;
            }
            await this.connection.getRepository(ctx, McpToolCallLog).save(log);
            saved = true;
            await this.eventBus.publish(new McpToolCallEvent(ctx, log));
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            if (saved) {
                Logger.warn(
                    `Recorded MCP tool call "${input.tool.name}" but publishing its McpToolCallEvent failed: ${reason}`,
                    loggerCtx,
                );
            } else {
                Logger.warn(`Failed to record MCP tool call "${input.tool.name}": ${reason}`, loggerCtx);
            }
        }
    }

    async deleteExpiredToolCallLogs(ctx: RequestContext, channelId?: ID | null): Promise<number> {
        const ttlDays = this.options.logging?.ttlDays ?? 30;
        const cutoff = new Date(Date.now() - ttlDays * 86_400_000);
        const repository = this.connection.getRepository(ctx, McpToolCallLog);
        let totalDeleted = 0;
        for (;;) {
            const query = repository
                .createQueryBuilder('log')
                .select('log.id', 'id')
                .where('log.createdAt < :cutoff', { cutoff })
                .limit(RETENTION_DELETE_BATCH_SIZE);
            if (channelId != null) {
                query.andWhere('log.channelId = :channelId', { channelId });
            }
            const expired = await query.getRawMany<{ id: ID }>();
            if (expired.length === 0) {
                break;
            }
            const result = await repository
                .createQueryBuilder()
                .delete()
                .where('id IN (:...ids)', { ids: expired.map(row => row.id) })
                .execute();
            totalDeleted += result.affected ?? expired.length;
            if (expired.length < RETENTION_DELETE_BATCH_SIZE) {
                break;
            }
        }
        return totalDeleted;
    }

    private async getBucketState(key: string, now: number): Promise<BucketState | undefined> {
        const state = await this.cacheService.get<BucketState>(this.cacheKey(key));
        if (!state || state.resetAt <= now) {
            return undefined;
        }
        return state;
    }

    private cacheKey(key: string): string {
        return `${RATE_LIMIT_CACHE_PREFIX}:${this.hash(key)}`;
    }

    private sessionKey(executionContext: McpExecutionContext): string {
        const sessionToken = executionContext.ctx.session?.token;
        if (sessionToken) {
            return `vendure:${this.hash(sessionToken)}`;
        }
        if (executionContext.grant?.id != null) {
            return `mcp:${executionContext.grant.id}`;
        }
        return 'none';
    }

    private clientKey(executionContext: McpExecutionContext): string | undefined {
        return executionContext.grant?.oauthClientId != null
            ? `oauth:${executionContext.grant.oauthClientId}`
            : undefined;
    }

    private toolActorKey(executionContext: McpExecutionContext): string {
        const clientKey = this.clientKey(executionContext);
        const sessionKey = this.sessionKey(executionContext);
        return clientKey
            ? `client:${clientKey}:session:${sessionKey}`
            : `anonymous-ip:${this.ipKey(executionContext)}:session:${sessionKey}`;
    }

    private ipKey(executionContext: McpExecutionContext): string {
        return executionContext.clientIp ?? 'unknown';
    }

    private hash(value: string): string {
        return createHash('sha256').update(value).digest('base64url');
    }
}
