import { Injectable } from '@nestjs/common';
import { ActiveOrderService, OrderService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { getActiveOrder } from '../order-helpers';
import { objectSchema } from '../schema-helpers';

@McpTool({
    name: 'get_eligible_shipping_methods',
    toolset: 'shop',
    description: 'List shipping methods eligible for the active cart.',
    permissions: [Permission.Public],
    readOnly: true,
    inputSchema: objectSchema({}),
})
@Injectable()
export class GetEligibleShippingMethodsTool implements McpPluginToolHandler<Record<string, never>> {
    constructor(
        private activeOrderService: ActiveOrderService,
        private orderService: OrderService,
    ) {}

    async execute(ctx: RequestContext) {
        const order = await getActiveOrder(ctx, this.activeOrderService, this.orderService, false);
        if (!order) return { methods: [] };
        return { methods: await this.orderService.getEligibleShippingMethods(ctx, order.id) };
    }
}
