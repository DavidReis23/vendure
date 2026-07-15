import { Injectable } from '@nestjs/common';
import { ActiveOrderService, ID, OrderService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { getActiveOrder, orderResult } from '../order-helpers';
import { idProp, objectSchema } from '../schema-helpers';

interface RemoveFromCartInput {
    orderLineId: ID;
}

@McpTool({
    name: 'remove_from_cart',
    toolset: 'shop',
    description: 'Remove a line from the active cart.',
    permissions: [Permission.Public],
    readOnly: false,
    inputSchema: objectSchema({ orderLineId: idProp('Order line ID.') }),
})
@Injectable()
export class RemoveFromCartTool implements McpPluginToolHandler<RemoveFromCartInput> {
    constructor(
        private activeOrderService: ActiveOrderService,
        private orderService: OrderService,
    ) {}

    async execute(ctx: RequestContext, input: RemoveFromCartInput) {
        const order = await getActiveOrder(ctx, this.activeOrderService, this.orderService, true);
        if (!order) return orderResult(undefined);
        return orderResult(await this.orderService.removeItemFromOrder(ctx, order.id, input.orderLineId));
    }
}
