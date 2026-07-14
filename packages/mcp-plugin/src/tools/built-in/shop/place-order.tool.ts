import { Injectable } from '@nestjs/common';
import { PaymentInput } from '@vendure/common/lib/generated-shop-types';
import { ActiveOrderService, OrderService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { jsonObjectProp, objectSchema, optional, stringProp } from '../schema-helpers';
import { getActiveOrder, orderResult } from '../tool-kit';

interface PlaceOrderInput {
    paymentMethodCode: string;
    paymentMetadata?: Record<string, unknown>;
}

@McpTool({
    name: 'place_order',
    toolset: 'shop',
    description: 'Add payment to the active cart and place the order.',
    permissions: [Permission.Public],
    readOnly: false,
    requiresConfirmation: true,
    inputSchema: objectSchema({
        paymentMethodCode: stringProp('Payment method code.'),
        paymentMetadata: optional(jsonObjectProp('Metadata passed to the payment handler.')),
    }),
})
@Injectable()
export class PlaceOrderTool implements McpPluginToolHandler<PlaceOrderInput> {
    constructor(
        private activeOrderService: ActiveOrderService,
        private orderService: OrderService,
    ) {}

    async execute(ctx: RequestContext, input: PlaceOrderInput) {
        if (!ctx.activeUserId) {
            return {
                requiresAuthorization: true,
                message: 'Authorize with shop.checkout before placing an order.',
            };
        }
        const order = await getActiveOrder(ctx, this.activeOrderService, this.orderService, true);
        if (!order) return orderResult(undefined);
        const payment: PaymentInput = {
            method: input.paymentMethodCode,
            metadata: input.paymentMetadata ?? {},
        };
        return orderResult(await this.orderService.addPaymentToOrder(ctx, order.id, payment));
    }
}
