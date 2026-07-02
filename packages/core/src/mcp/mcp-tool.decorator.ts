import { DiscoveryService } from '@nestjs/core';
import { Permission } from '@vendure/common/lib/generated-types';

import { RequestContext } from '../api/common/request-context';

import { McpToolBehavior, McpToolset } from './types';

/**
 * @description
 * A JSON Schema for a tool's input or output. Only object types are described here;
 * any other JSON Schema keywords can be added via the index signature.
 *
 * @docsCategory core plugins/McpServerPlugin
 * @since 3.8.0
 */
export interface McpJsonSchema {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
}

/**
 * @description
 * A schema that validates raw input and returns it as a typed value, such as a Zod
 * schema.
 *
 * @docsCategory core plugins/McpServerPlugin
 * @since 3.8.0
 */
export interface McpSchema<T = unknown> {
    parse(input: unknown): T;
}

/**
 * @description
 * An example call for a tool, shown to an AI agent so it knows how to use the tool.
 *
 * @docsCategory core plugins/McpServerPlugin
 * @since 3.8.0
 */
export interface McpToolExample {
    description?: string;
    arguments: Record<string, unknown>;
}

/**
 * @description
 * Describes a single MCP tool. You attach this to a class with the {@link McpTool}
 * decorator. The MCP server finds those classes on startup and exposes each one as a
 * callable tool.
 *
 * @docsCategory core plugins/McpServerPlugin
 * @since 3.8.0
 */
export interface McpToolMetadata {
    /** Unique snake_case name within the toolset, e.g. "search_products". */
    name: string;
    /** Optional title. */
    title?: string;
    /** What the tool does, written for an AI agent to read. */
    description: string;
    /** Which API the tool uses (shop or admin). */
    toolset: McpToolset;
    /**
     * Permissions needed to call the tool. The caller only needs one of them
     * (OR logic, the same as `@Allow`).
     */
    permissions?: Permission[];
    /** How the tool behaves; controls how it is exposed to the agent. */
    behavior?: McpToolBehavior;
    /** True if the tool only reads data and never changes anything. */
    readOnly?: boolean;
    /** True if calling the tool needs explicit confirmation, e.g. deletes. */
    requiresConfirmation?: boolean;
    /** Optional schema used to validate the tool's input. */
    inputSchema?: McpSchema | McpJsonSchema;
    /** Optional schema describing the tool's output. */
    outputSchema?: McpSchema | McpJsonSchema;
    /** Optional example calls shown to the agent. */
    examples?: McpToolExample[];
}

/**
 * @description
 * The shape of an MCP tool class: an `execute` method that the server calls with the
 * {@link RequestContext} and the input.
 *
 * @docsCategory core plugins/McpServerPlugin
 * @since 3.8.0
 */
export interface McpToolHandler<I = unknown, O = unknown> {
    execute(ctx: RequestContext, input: I): Promise<O> | O;
}

/**
 * @description
 * Marks a class as an MCP tool. The class must be a NestJS provider (can be injected via `@Injectable()`)
 * so the MCP server can discover it and inject the services it depends on.
 * It also needs an `execute` method (see {@link McpToolHandler}), which the server checks for when registering the
 * tool. The {@link McpToolMetadata} you pass is read at runtime and used by the
 * [MCP server plugin](/reference/core-plugins/mcp-server-plugin/) to turn the class into a
 * callable tool.
 *
 * @example
 * ```ts
 * import { Injectable } from '\@nestjs/common';
 * import { McpTool, McpToolHandler, Permission, RequestContext } from '\@vendure/core';
 *
 * \@Injectable()
 * \@McpTool({
 *     name: 'search_products',
 *     description: 'Search the product catalog',
 *     toolset: 'shop',
 *     behavior: 'readonly',
 *     permissions: [Permission.Public],
 * })
 * export class SearchProductsTool implements McpToolHandler {
 *     execute(ctx: RequestContext, input: { term: string }) {
 *         // ...
 *         return { items: [] };
 *     }
 * }
 * ```
 *
 * @docsCategory core plugins/McpServerPlugin
 * @since 3.8.0
 */
export const McpTool = DiscoveryService.createDecorator<McpToolMetadata>();
