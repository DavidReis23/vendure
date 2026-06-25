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
