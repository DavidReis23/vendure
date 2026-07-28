import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '@vendure/core';
import { McpToolset } from '@vendure/mcp-sdk';
import { createHash } from 'node:crypto';

import { MCP_PLUGIN_OPTIONS, RATE_LIMIT_CACHE_PREFIX, RATE_LIMIT_WINDOW_MS } from '../constants';
import { McpExecutionContext, McpPluginOptions } from '../types';

const RATE_LIMIT_CACHE_TAG = 'mcp-rate-limit';

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
 * Enforces fixed-window rate limits for MCP requests: per Vendure session, per OAuth client,
 * per anonymous IP (shop endpoint only), and per tool. Buckets are ephemeral, backed by CacheService.
 */
@Injectable()
export class McpRateLimiterService {
    constructor(
        private cacheService: CacheService,
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
        return this.runChecks(
            this.buildRateLimitChecks(input),
            input.subject ?? input.toolNames?.join(', ') ?? 'MCP request',
        );
    }

    /**
     * Charges the anonymous-IP bucket alone, without a resolved context. The transport calls this
     * before it builds one for an anonymous shop request, because building it mints a Vendure session
     * row — the write belongs inside the limit rather than behind it. This is the only place that
     * bucket is charged; {@link buildSharedBucketChecks} deliberately leaves it out.
     */
    async enforceAnonymousIpRateLimit(endpoint: McpToolset, clientIp?: string): Promise<void> {
        const check = this.buildAnonymousIpCheck(endpoint, this.ipKey(clientIp));
        if (!check) {
            return;
        }
        const exceeded = await this.runChecks([check], 'MCP request');
        if (exceeded) {
            throw new McpRateLimitExceededError(exceeded);
        }
    }

    private async runChecks(
        checks: RateLimitCheck[],
        subject: string,
    ): Promise<McpRateLimitExceeded | undefined> {
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

    /** Builds the list of buckets to check for a request: the shared buckets, then one per tool. */
    private buildRateLimitChecks(input: RateLimitInput): RateLimitCheck[] {
        const checks: RateLimitCheck[] = [
            ...this.buildSharedBucketChecks(input),
            ...this.buildPerToolChecks(input),
        ];
        // De-dupe by key so a bucket is never double-counted within one request.
        return [...new Map(checks.map(check => [check.key, check])).values()];
    }

    /**
     * Session and OAuth-client buckets. These are shared across every tool call in a request, so
     * callers that only want the per-tool buckets checked pass `includeSharedBuckets: false` to skip
     * them. The anonymous-IP bucket is absent by design: it applies to exactly the requests the
     * transport charges at the edge (see {@link enforceAnonymousIpRateLimit}), and charging it here
     * too would count the same request twice.
     */
    private buildSharedBucketChecks(input: RateLimitInput): RateLimitCheck[] {
        if (input.includeSharedBuckets === false) {
            return [];
        }
        const checks: RateLimitCheck[] = [];
        const endpoint = input.endpoint;
        const rateLimits = this.options.rateLimits ?? {};
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
        return checks;
    }

    /** The anonymous-IP bucket for an endpoint, or `undefined` when it does not apply. */
    private buildAnonymousIpCheck(endpoint: McpToolset, ipKey: string): RateLimitCheck | undefined {
        const anonymousIp = this.options.rateLimits?.anonymousIp;
        const rpm = anonymousIp === false ? 0 : (anonymousIp?.rpm ?? 0);
        if (endpoint !== 'shop' || rpm <= 0) {
            return undefined;
        }
        return { key: `anonymous-ip:${endpoint}:${ipKey}`, rpm, scope: 'anonymous IP' };
    }

    /** One bucket per name in `input.toolNames`, keyed by actor+session (see {@link toolActorKey}). */
    private buildPerToolChecks(input: RateLimitInput): RateLimitCheck[] {
        const checks: RateLimitCheck[] = [];
        const endpoint = input.endpoint;
        const rateLimits = this.options.rateLimits ?? {};
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
        return checks;
    }

    /** Reads a bucket's current state, treating an expired window as if the bucket didn't exist. */
    private async getBucketState(key: string, now: number): Promise<BucketState | undefined> {
        const state = await this.cacheService.get<BucketState>(this.cacheKey(key));
        if (!state || state.resetAt <= now) {
            return undefined;
        }
        return state;
    }

    /** Increments a bucket (creating it on first hit within the window). */
    private async consumeBucket(key: string, state: BucketState | undefined, now: number): Promise<void> {
        const nextState: BucketState = state
            ? { count: state.count + 1, resetAt: state.resetAt }
            : { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
        await this.cacheService.set(this.cacheKey(key), nextState, {
            ttl: Math.max(1000, nextState.resetAt - now),
            tags: [RATE_LIMIT_CACHE_TAG],
        });
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

    // Composes the caller identity (OAuth client, else anonymous IP) with the session so a caller
    // can't bypass a per-tool limit by spreading requests across different tools in one session.
    private toolActorKey(executionContext: McpExecutionContext): string {
        const clientKey = this.clientKey(executionContext);
        const sessionKey = this.sessionKey(executionContext);
        return clientKey
            ? `client:${clientKey}:session:${sessionKey}`
            : `anonymous-ip:${this.ipKey(executionContext.clientIp)}:session:${sessionKey}`;
    }

    private ipKey(clientIp?: string): string {
        return clientIp ?? 'unknown';
    }

    private cacheKey(key: string): string {
        return `${RATE_LIMIT_CACHE_PREFIX}:${this.hash(key)}`;
    }

    private hash(value: string): string {
        return createHash('sha256').update(value).digest('base64url');
    }
}
