import { RequestContext, VendureEvent } from '@vendure/core';

import { McpToolCallLog } from '../entities/mcp-tool-call-log.entity';

/**
 * @description
 * Fires after every MCP tool call (success/error, shop/admin). Receives the
 * redacted `McpToolCallLog` entry. Use to build audit trails, metrics, or alerts.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
export class McpToolCallEvent extends VendureEvent {
    constructor(
        public ctx: RequestContext,
        public entry: McpToolCallLog,
    ) {
        super();
    }
}
