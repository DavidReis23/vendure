import { CrudPermissionDefinition } from '@vendure/core';

import { McpRateLimitOptions } from './types';

export const MCP_PLUGIN_OPTIONS = Symbol('MCP_PLUGIN_OPTIONS');

export const loggerCtx = 'McpPlugin';

export const DEFAULT_TOOL_EXPOSURE = 'direct' as const;

export const MCP_SETTINGS_NAMESPACE = 'mcp';
/** Field name registered in `settingsStoreFields` under {@link MCP_SETTINGS_NAMESPACE}. */
export const MCP_TOOL_TOGGLES_FIELD_NAME = 'tool-toggles';
/** Namespaced lookup key used with `SettingsStoreService.get/set`. */
export const MCP_TOOL_TOGGLES_STORE_KEY = `${MCP_SETTINGS_NAMESPACE}.${MCP_TOOL_TOGGLES_FIELD_NAME}`;

/** JSON-RPC error code for rate-limit rejection (handshake pre-check only). */
export const RATE_LIMIT_ERROR_CODE = -32029;
/** Rate-limit window in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** Cache-key prefix for rate-limit buckets. */
export const RATE_LIMIT_CACHE_PREFIX = 'mcp:rate-limit';

export const mcpServerPermission = new CrudPermissionDefinition('McpServer');

export const DEFAULT_OAUTH_OPTIONS = {
    issuer: 'http://localhost:3500',
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
    authorizationCodeTtlSeconds: 60,
    authorizationRequestTtlSeconds: 10 * 60,
    adminConsentPath: '/dashboard/mcp/authorize',
    storefrontConsentUrl: 'http://localhost:3000/mcp/authorize',
} as const;

/**
 * Default rate limits. The anonymous-IP limit is ON by default (60 rpm) — it is the safety backstop
 * for the unattributable anonymous `/mcp/shop` surface, and is disabled only via explicit
 * `anonymousIp: false`. Per-tool limits are opt-in (`0` = unlimited) with two safe defaults.
 */
export const DEFAULT_RATE_LIMIT_OPTIONS: Required<McpRateLimitOptions> = {
    perSession: { rpm: 60 },
    perClient: { rpm: 120 },
    perTool: { place_order: { rpm: 5 }, create_product: { rpm: 10 } },
    anonymousIp: { rpm: 60 },
};
