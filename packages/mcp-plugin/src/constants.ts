export const MCP_PLUGIN_OPTIONS = Symbol('MCP_PLUGIN_OPTIONS');

export const loggerCtx = 'McpPlugin';

export const DEFAULT_TOOL_EXPOSURE = 'discovery' as const;

export const DEFAULT_OAUTH_OPTIONS = {
    issuer: 'http://localhost:3500',
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
    authorizationCodeTtlSeconds: 60,
    authorizationRequestTtlSeconds: 10 * 60,
    adminConsentPath: '/dashboard/mcp/authorize',
    storefrontConsentUrl: 'http://localhost:3000/mcp/authorize',
} as const;
