import { Injectable } from '@nestjs/common';
import { CustomerService, Order, OrderService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { numberProp, objectSchema, optional } from '../schema-helpers';
import { listOptions, orderSummary, page } from '../tool-kit';

interface ListMyOrdersInput extends Record<string, unknown> {
    limit?: number;
    offset?: number;
}

@McpTool({
    name: 'list_my_orders',
    toolset: 'shop',
    description: 'List orders belonging to the authenticated customer.',
    permissions: [Permission.Authenticated],
    readOnly: true,
    inputSchema: objectSchema({
        limit: optional(numberProp('Maximum number of orders to return.')),
        offset: optional(numberProp('Number of orders to skip.')),
    }),
})
@Injectable()
export class ListMyOrdersTool implements McpPluginToolHandler<ListMyOrdersInput> {
    constructor(
        private customerService: CustomerService,
        private orderService: OrderService,
    ) {}

    async execute(ctx: RequestContext, input: ListMyOrdersInput) {
        if (!ctx.activeUserId) return page([], 0, input);
        const customer = await this.customerService.findOneByUserId(ctx, ctx.activeUserId);
        if (!customer) return page([], 0, input);
        const result = await this.orderService.findByCustomerId(ctx, customer.id, listOptions<Order>(input), [
            'lines',
        ]);
        return page(
            result.items.map(order => orderSummary(order)),
            result.totalItems,
            input,
        );
    }
}
