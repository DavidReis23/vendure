import { Injectable } from '@nestjs/common';
import { ActiveOrderService, ID, OrderService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { idProp, numberProp, objectSchema } from '../schema-helpers';
import { getActiveOrder, orderResult } from '../tool-kit';

interface AddToCartInput {
    variantId: ID;
    quantity: number;
}

@McpTool({
    name: 'add_to_cart',
    toolset: 'shop',
    description: 'Add a product variant to the active cart.',
    permissions: [Permission.Public],
    readOnly: false,
    inputSchema: objectSchema({
        variantId: idProp('Product variant ID.'),
        quantity: numberProp('Quantity.'),
    }),
})
@Injectable()
export class AddToCartTool implements McpPluginToolHandler<AddToCartInput> {
    constructor(
        private activeOrderService: ActiveOrderService,
        private orderService: OrderService,
    ) {}

    async execute(ctx: RequestContext, input: AddToCartInput) {
        const order = await getActiveOrder(ctx, this.activeOrderService, this.orderService, true);
        if (!order) return orderResult(undefined);
        return orderResult(
            await this.orderService.addItemToOrder(ctx, order.id, input.variantId, input.quantity),
        );
    }
}
