import { McpToolHandler, RequestContext } from '@vendure/core';

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
}

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
 * Carries the Vendure request context into a tool's `execute` call.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
export interface McpExecutionContext {
    ctx: RequestContext;
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
 * Discriminates between access and refresh tokens in {@link McpOauthToken}.
 */
export type McpOauthTokenType = 'access' | 'refresh';

// Re-exported from core so plugin entities can import McpToolset from '../types'
// without creating a duplicate declaration.
export type { McpToolset } from '@vendure/core';

/**
 * Terminal outcome of a single MCP tool call recorded in {@link McpToolCallLog}.
 */
export type McpToolCallStatus = 'success' | 'error';
