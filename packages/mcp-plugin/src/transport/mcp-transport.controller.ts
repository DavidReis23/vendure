import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import {
    Body,
    Controller,
    Get,
    Headers,
    Inject,
    Post,
    Req,
    Res,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@vendure/core';
import { McpToolset } from '@vendure/mcp-sdk';
import type { Request, Response } from 'express';

import { MCP_PLUGIN_OPTIONS, RATE_LIMIT_ERROR_CODE } from '../constants';
import { McpOauthService } from '../oauth/oauth.service';
import { McpRateLimiterService, McpRateLimitExceededError } from '../rate-limit/mcp-rate-limiter.service';
import { McpToolRegistryService } from '../registry/mcp-tool-registry.service';
import { McpExecutionContext, McpPluginOptions } from '../types';

import { createMcpServerForRequest } from './mcp-server.factory';

/** A Node `(req, res, parsedBody?)` handler as produced by `toNodeHandler`. */
type NodeMcpHandler = (req: Request, res: Response, parsedBody?: unknown) => Promise<void>;

/** A `(req, res) => boolean` DNS-rebinding front guard (writes its own 403 on rejection). */
type FrontGuard = (req: Request, res: Response) => boolean;

/** Minimal JSON-RPC error envelope returned by the handshake pre-check. */
interface JsonRpcError {
    jsonrpc: '2.0';
    id: string | number | null;
    error: { code: number; message: string; data?: unknown };
}

/**
 * @description
 * HTTP transport for the MCP server. Owns authentication, anonymous shop context, the handshake
 * rate-limit pre-check (kept at controller altitude so the `-32029` `error.data` survives), and the
 * DNS-rebinding front guard. It then delegates JSON-RPC handling to the v2 SDK handler via
 * `toNodeHandler`, passing the resolved Vendure context through the SDK's pass-through `authInfo`.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
@Controller('mcp')
export class McpTransportController {
    private readonly nodeHandler: NodeMcpHandler;
    private readonly hostGuard?: FrontGuard;
    private readonly originGuard?: FrontGuard;

    constructor(
        private oauthService: McpOauthService,
        private registry: McpToolRegistryService,
        private rateLimiter: McpRateLimiterService,
        private configService: ConfigService,
        @Inject(MCP_PLUGIN_OPTIONS) private options: McpPluginOptions,
    ) {
        // One stateless handler; the per-request factory reads the resolved context from authInfo.extra.
        const handler = createMcpHandler(async mcpCtx => {
            const extra = mcpCtx.authInfo?.extra as
                | { executionContext?: McpExecutionContext; toolset?: McpToolset }
                | undefined;
            if (!extra?.executionContext || !extra.toolset) {
                throw new Error('MCP request is missing its resolved execution context');
            }
            return createMcpServerForRequest(extra.executionContext, extra.toolset, this.registry);
        });
        this.nodeHandler = toNodeHandler(handler);
        const dns = this.options.dnsRebinding;
        this.hostGuard = dns?.allowedHosts?.length
            ? (hostHeaderValidation(dns.allowedHosts) as FrontGuard)
            : undefined;
        this.originGuard = dns?.allowedOrigins?.length
            ? (originValidation(dns.allowedOrigins) as FrontGuard)
            : undefined;
    }

    @Post('shop')
    async postShop(
        @Req() req: Request,
        @Res() res: Response,
        @Body() body: unknown,
        @Headers() headers: Record<string, string | string[] | undefined>,
    ): Promise<void> {
        return this.handlePost('shop', req, res, body, headers);
    }

    @Post('admin')
    async postAdmin(
        @Req() req: Request,
        @Res() res: Response,
        @Body() body: unknown,
        @Headers() headers: Record<string, string | string[] | undefined>,
    ): Promise<void> {
        return this.handlePost('admin', req, res, body, headers);
    }

    @Get('shop')
    getShop(@Res() res: Response): void {
        this.methodNotAllowed(res);
    }

    @Get('admin')
    getAdmin(@Res() res: Response): void {
        this.methodNotAllowed(res);
    }

    private async handlePost(
        toolset: McpToolset,
        req: Request,
        res: Response,
        body: unknown,
        headers: Record<string, string | string[] | undefined>,
    ): Promise<void> {
        // 1. DNS-rebinding front guard (writes its own 403 and returns false on rejection).
        if (this.hostGuard && !this.hostGuard(req, res)) {
            return;
        }
        if (this.originGuard && !this.originGuard(req, res)) {
            return;
        }

        // 2. Authenticate and build the execution context.
        const token = this.getBearerToken(this.getHeader(headers, 'authorization'));
        let executionContext: McpExecutionContext;
        if (toolset === 'admin') {
            if (!token) {
                this.setAuthChallenge(res, 'admin');
                throw new UnauthorizedException('Admin MCP endpoint requires a Bearer token');
            }
            const authContext = await this.authenticateBearerToken(token, 'admin', res);
            executionContext = { ...authContext, clientIp: this.getClientIp(req) };
        } else if (token) {
            const authContext = await this.authenticateBearerToken(token, 'shop', res);
            executionContext = { ...authContext, clientIp: this.getClientIp(req) };
        } else {
            // Anonymous shop: thread the Vendure session token (for cart continuity) and the channel
            // token (for multi-channel). An invalid channel token errors like the rest of Vendure.
            const ctx = await this.oauthService.createAnonymousShopContext(
                this.getVendureSessionToken(headers),
                this.getChannelToken(headers),
            );
            // Echo the session token BEFORE delegating — the SDK handler owns the response write.
            // (If a future SDK path resets headers, hook res.writeHead here instead.)
            this.setVendureSessionToken(res, ctx.session?.token);
            executionContext = { ctx, clientIp: this.getClientIp(req) };
        }

        // 3. Handshake rate-limit pre-check (only meaningful for JSON bodies we can parse).
        const contentType = this.getHeader(headers, 'content-type') ?? '';
        const isJson = contentType.includes('application/json');
        const parsedBody = isJson ? body : undefined;
        if (isJson) {
            const rateLimitError = await this.preCheckHandshakeRateLimit(body, toolset, executionContext);
            if (rateLimitError) {
                res.status(200);
                res.setHeader('Content-Type', 'application/json');
                res.send(JSON.stringify(rateLimitError));
                return;
            }
        }

        // 4. Attach the resolved context as pass-through authInfo and delegate to the SDK handler.
        (req as Request & { auth?: AuthInfo }).auth = this.buildAuthInfo(executionContext, toolset, token);
        await this.nodeHandler(req, res, parsedBody);
    }

    /**
     * Enforces the per-subject rate limit for handshake/protocol methods (everything except
     * `tools/call` and notifications). Returns a JSON-RPC `-32029` error to send directly (preserving
     * `error.data`) when a bucket is exceeded, or `undefined` to proceed.
     */
    private async preCheckHandshakeRateLimit(
        body: unknown,
        toolset: McpToolset,
        executionContext: McpExecutionContext,
    ): Promise<JsonRpcError | undefined> {
        const messages = Array.isArray(body) ? body : [body];
        for (const message of messages) {
            const request = message as { method?: unknown; id?: unknown } | null;
            const method = request?.method;
            // Skip non-requests, notifications (no id), and tool calls (rate-limited in the registry).
            if (typeof method !== 'string' || request?.id === undefined || method === 'tools/call') {
                continue;
            }
            try {
                await this.rateLimiter.enforceRateLimit({
                    executionContext,
                    endpoint: toolset,
                    toolNames: [method],
                    subject: method,
                });
            } catch (e) {
                if (e instanceof McpRateLimitExceededError) {
                    return {
                        jsonrpc: '2.0',
                        id: (request?.id as string | number | null) ?? null,
                        error: {
                            code: RATE_LIMIT_ERROR_CODE,
                            message: e.message,
                            data: { retryAfterSeconds: e.details.retryAfterSeconds, scope: e.details.scope },
                        },
                    };
                }
                throw e;
            }
        }
        return undefined;
    }

    private buildAuthInfo(
        executionContext: McpExecutionContext,
        toolset: McpToolset,
        token?: string,
    ): AuthInfo {
        const grant = executionContext.grant;
        return {
            // Pass-through only — the SDK performs no token verification.
            token: token ?? 'anonymous',
            clientId: grant?.oauthClientId != null ? String(grant.oauthClientId) : 'anonymous',
            scopes: [],
            expiresAt: grant?.accessTokenExpiresAt
                ? Math.floor(new Date(grant.accessTokenExpiresAt).getTime() / 1000)
                : undefined,
            extra: { executionContext, toolset },
        };
    }

    private async authenticateBearerToken(token: string, toolset: McpToolset, res: Response) {
        try {
            return await this.oauthService.authenticateBearerToken(token, toolset);
        } catch (e) {
            if (e instanceof UnauthorizedException) {
                this.setAuthChallenge(res, toolset);
            }
            throw e;
        }
    }

    private setAuthChallenge(res: Response, toolset: McpToolset): void {
        res.setHeader(
            'WWW-Authenticate',
            `Bearer resource_metadata="${this.oauthService.protectedResourceMetadataUrl(toolset)}"`,
        );
    }

    private methodNotAllowed(res: Response): void {
        res.setHeader('Allow', 'POST');
        res.status(405).send('Method Not Allowed');
    }

    private getBearerToken(header?: string): string | undefined {
        const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
        return match?.[1];
    }

    private getClientIp(req: Request): string | undefined {
        return req.ip ?? req.socket?.remoteAddress ?? undefined;
    }

    private getVendureSessionToken(
        headers: Record<string, string | string[] | undefined>,
    ): string | undefined {
        const key = this.configService.authOptions.authTokenHeaderKey ?? 'vendure-auth-token';
        const value = this.getHeader(headers, key);
        return value || undefined;
    }

    private setVendureSessionToken(res: Response, token?: string): void {
        if (token) {
            res.setHeader(this.configService.authOptions.authTokenHeaderKey ?? 'vendure-auth-token', token);
        }
    }

    private getChannelToken(headers: Record<string, string | string[] | undefined>): string | undefined {
        const key = this.configService.apiOptions.channelTokenKey;
        const value = this.getHeader(headers, key);
        return value || undefined;
    }

    private getHeader(
        headers: Record<string, string | string[] | undefined>,
        name: string,
    ): string | undefined {
        const lower = name.toLowerCase();
        const direct = headers[lower];
        const value = direct ?? Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
        return Array.isArray(value) ? value[0] : value;
    }
}
