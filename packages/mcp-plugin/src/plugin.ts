import { Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { PluginCommonModule, VendurePlugin } from '@vendure/core';

import { DEFAULT_TOOL_EXPOSURE, MCP_PLUGIN_OPTIONS } from './constants';
import {
    McpAuthorizationCode,
    McpAuthorizationRequest,
    McpOauthClient,
    McpOauthToken,
    McpSession,
    McpToolCallLog,
} from './entities';
import { McpPluginOptions } from './types';

/**
 * @description
 * Exposes Vendure's data and operations to AI agents via the [Model Context Protocol](https://modelcontextprotocol.io/).
 * Tools decorated with `@McpTool` are automatically discovered and registered at bootstrap.
 *
 * @example
 * ```ts
 * import { McpPlugin } from '\@vendure/mcp-plugin';
 *
 * const config: VendureConfig = {
 *     plugins: [
 *         McpPlugin.init({
 *             toolExposure: 'discovery',
 *         }),
 *     ],
 * };
 * ```
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
@VendurePlugin({
    imports: [PluginCommonModule, DiscoveryModule],
    providers: [{ provide: MCP_PLUGIN_OPTIONS, useFactory: () => McpPlugin.options }],
    entities: [
        McpOauthClient,
        McpOauthToken,
        McpAuthorizationCode,
        McpAuthorizationRequest,
        McpSession,
        McpToolCallLog,
    ],
    compatibility: '^3.8.0',
})
export class McpPlugin {
    static options: McpPluginOptions;

    static init(options: McpPluginOptions = {}): Type<McpPlugin> {
        this.options = {
            toolExposure: options.toolExposure ?? DEFAULT_TOOL_EXPOSURE,
            oauth: options.oauth,
        };
        return McpPlugin;
    }
}
