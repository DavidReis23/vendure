import { McpToolHandler, RequestContext } from '@vendure/core';
import type { McpSession } from './entities/mcp-session.entity';

/**
 * @description
 * Controls which tools are returned by the MCP `tools/list` call.
 *
 * - `discovery` exposes a small, stable set of meta-tools that let an agent
 *   search, describe, and execute registered Vendure tools by behavior.
 * - `direct` exposes every callable Vendure tool directly to the agent.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
export type McpToolExposureMode = 'direct' | 'discovery';

/**
 * @description
 * OAuth-related options for {@link McpPlugin}.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
export interface McpOauthOptions {
    /**
     * @description
     * Server secret used to HMAC-hash OAuth tokens at rest. Generate once via
     * `openssl rand -base64 32`. Required to enable OAuth. Supply via an
     * environment variable. Rotating the secret invalidates all stored MCP OAuth
     * tokens.
     */
    tokenSecret: string;
    /**
     * @description
     * Public base URL of the Vendure server, used as the OAuth issuer and to build
     * authorization-server / protected-resource metadata URLs.
     *
     * @default 'http://localhost:3500'
     */
    issuer?: string;
    /**
     * @description
     * Lifetime of an issued access token, in seconds.
     *
     * @default 900
     */
    accessTokenTtlSeconds?: number;
    /**
     * @description
     * Lifetime of an issued refresh token, in seconds.
     *
     * @default 2592000
     */
    refreshTokenTtlSeconds?: number;
    /**
     * @description
     * Lifetime of an authorization code before it must be exchanged, in seconds.
     *
     * @default 60
     */
    authorizationCodeTtlSeconds?: number;
    /**
     * @description
     * Lifetime of a pending authorization request (consent window), in seconds.
     *
     * @default 600
     */
    authorizationRequestTtlSeconds?: number;
    /**
     * @description
     * Path (relative to `issuer`) of the admin consent page that approves
     * admin-scoped authorization requests.
     *
     * @default '/dashboard/mcp/authorize'
     */
    adminConsentPath?: string;
    /**
     * @description
     * Absolute URL of the storefront consent page that approves customer-scoped
     * authorization requests.
     *
     * @default 'http://localhost:3000/mcp/authorize'
     */
    storefrontConsentUrl?: string;
}

/**
 * OAuth options with all optional fields resolved to their defaults. Built by
 * {@link McpPlugin.init} and consumed by the internal `OAuthService`.
 */
export type ResolvedMcpOauthOptions = Required<McpOauthOptions>;

/**
 * @description
 * Options passed to {@link McpPlugin.init}.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
export interface McpPluginOptions {
    /**
     * Controls which tools are returned by the MCP `tools/list` call.
     * See {@link McpToolExposureMode} for the available modes.
     *
     * @default 'discovery'
     */
    toolExposure?: McpToolExposureMode;
    /**
     * @description
     * OAuth options. When omitted, the OAuth surface is disabled.
     */
    oauth?: McpOauthOptions;
}

/**
 * @description
 * Carries the Vendure request context into a tool's `execute` call, together with the
 * MCP grant session and client IP resolved for the call when the request was
 * authenticated over OAuth.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
export interface McpExecutionContext {
    ctx: RequestContext;
    session?: McpSession;
    clientIp?: string;
}

/**
 * @description
 * Plugin-side handler interface. It extends `McpToolHandler`
 * with an optional {@link McpExecutionContext} third argument, which tools use
 * when they need access to the MCP execution context.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
export interface McpServerToolHandler<I = unknown, O = unknown> extends McpToolHandler<I, O> {
    execute(ctx: RequestContext, input: I, executionContext?: McpExecutionContext): Promise<O> | O;
}

/**
 * Identifies the type of Vendure actor (user) associated with an MCP OAuth grant.
 */
export type McpActorType = 'customer' | 'admin' | 'anonymous';

/**
 * Result of authenticating a bearer token: the resolved `RequestContext` plus the
 * backing MCP grant session record.
 */
export type McpAuthenticatedContext = Required<Pick<McpExecutionContext, 'ctx' | 'session'>>;

// Re-exported from core so plugin entities can import McpToolset from '../types'
// without creating a duplicate declaration.
export type { McpToolset } from '@vendure/core';

/**
 * Terminal outcome of a single MCP tool call recorded in {@link McpToolCallLog}.
 */
export type McpToolCallStatus = 'success' | 'error';
