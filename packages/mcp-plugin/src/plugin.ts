import { OnApplicationBootstrap, Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { PluginCommonModule, ProcessContext, VendurePlugin } from '@vendure/core';

import { DEFAULT_OAUTH_OPTIONS, DEFAULT_TOOL_EXPOSURE, MCP_PLUGIN_OPTIONS } from './constants';
import {
    McpAuthorizationCode,
    McpAuthorizationRequest,
    McpOauthClient,
    McpOauthToken,
    McpSession,
    McpToolCallLog,
} from './entities';
import { McpOAuthController } from './oauth/oauth.controller';
import { OAuthService } from './oauth/oauth.service';
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
    controllers: [McpOAuthController],
    providers: [{ provide: MCP_PLUGIN_OPTIONS, useFactory: () => McpPlugin.options }, OAuthService],
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
export class McpPlugin implements OnApplicationBootstrap {
    static options: McpPluginOptions;

    constructor(private processContext: ProcessContext) {}

    static init(options: McpPluginOptions = {}): Type<McpPlugin> {
        this.options = {
            toolExposure: options.toolExposure ?? DEFAULT_TOOL_EXPOSURE,
            oauth: options.oauth && { ...DEFAULT_OAUTH_OPTIONS, ...options.oauth },
        };
        return McpPlugin;
    }

    onApplicationBootstrap(): void {
        // Only the main server serves the OAuth routes, so only it needs this check.
        if (!this.processContext.isServer) {
            return;
        }
        const oauth = McpPlugin.options.oauth;
        if (!oauth) {
            return;
        }

        const isProduction = process.env.NODE_ENV === 'production';
        if (isProduction && this.isLoopbackUrl(oauth.issuer)) {
            throw new Error(
                `McpPlugin: oauth.issuer cannot be a loopback URL ("${oauth.issuer ?? ''}") in production. ` +
                    `Set it to your public Vendure server URL so clients can reach it.`,
            );
        }
    }

    private isLoopbackUrl(url?: string): boolean {
        if (!url) return true;

        let hostname: string;
        try {
            hostname = new URL(url).hostname;
        } catch {
            // Not a valid URL, so not a real public address either — treat as unsafe.
            return true;
        }
        return (
            hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
        );
    }
}
