import { Injectable } from '@nestjs/common';
import { ID, OrderService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { idProp, objectSchema } from '../schema-helpers';
import { orderSummary } from '../serializers';

interface GetOrderInput {
    id: ID;
}

// Class name is deliberately distinct from the shop `GetOrderTool` (`get_order` exists in both
// toolsets). Declared, not aliased, so stack traces and jump-to-symbol self-disambiguate.
@McpTool({
    name: 'get_order',
    toolset: 'admin',
    description: 'Get an order by id.',
    permissions: [Permission.ReadOrder],
    readOnly: true,
    inputSchema: objectSchema({ id: idProp('Order ID.') }),
})
@Injectable()
export class AdminGetOrderTool implements McpPluginToolHandler<GetOrderInput> {
    constructor(private orderService: OrderService) {}

    async execute(ctx: RequestContext, input: GetOrderInput) {
        return {
            order: orderSummary(
                await this.orderService.findOne(ctx, input.id, ['lines', 'customer', 'payments']),
            ),
        };
    }
}
