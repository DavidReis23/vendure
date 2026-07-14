import { Injectable } from '@nestjs/common';
import { ActiveOrderService, OrderService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { objectSchema } from '../schema-helpers';
import { getActiveOrder, orderSummary } from '../tool-kit';

@McpTool({
    name: 'get_cart',
    toolset: 'shop',
    description: 'Get the active cart for the current MCP session.',
    permissions: [Permission.Public],
    readOnly: true,
    inputSchema: objectSchema({}),
})
@Injectable()
export class GetCartTool implements McpPluginToolHandler<Record<string, never>> {
    constructor(
        private activeOrderService: ActiveOrderService,
        private orderService: OrderService,
    ) {}

    async execute(ctx: RequestContext) {
        const order = await getActiveOrder(ctx, this.activeOrderService, this.orderService, false);
        return { order: orderSummary(order) };
    }
}
