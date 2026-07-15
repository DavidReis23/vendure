import { Injectable } from '@nestjs/common';
import { ActiveOrderService, OrderService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { getActiveOrder } from '../order-helpers';
import { objectSchema } from '../schema-helpers';

@McpTool({
    name: 'get_eligible_payment_methods',
    toolset: 'shop',
    description: 'List payment methods eligible for the active cart.',
    permissions: [Permission.Public],
    readOnly: true,
    inputSchema: objectSchema({}),
})
@Injectable()
export class GetEligiblePaymentMethodsTool implements McpPluginToolHandler<Record<string, never>> {
    constructor(
        private activeOrderService: ActiveOrderService,
        private orderService: OrderService,
    ) {}

    async execute(ctx: RequestContext) {
        const order = await getActiveOrder(ctx, this.activeOrderService, this.orderService, false);
        if (!order) return { methods: [] };
        return { methods: await this.orderService.getEligiblePaymentMethods(ctx, order.id) };
    }
}
