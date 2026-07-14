import { Injectable } from '@nestjs/common';
import { OrderService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { numberProp, objectSchema, optional } from '../schema-helpers';
import { orderListOptions, orderSummary, page } from '../tool-kit';

interface ListOrdersInput extends Record<string, unknown> {
    limit?: number;
    offset?: number;
}

@McpTool({
    name: 'list_orders',
    toolset: 'admin',
    description: 'List orders for operations users.',
    permissions: [Permission.ReadOrder],
    readOnly: true,
    inputSchema: objectSchema({
        limit: optional(numberProp('Maximum number of orders to return.')),
        offset: optional(numberProp('Number of orders to skip.')),
    }),
})
@Injectable()
export class ListOrdersTool implements McpPluginToolHandler<ListOrdersInput> {
    constructor(private orderService: OrderService) {}

    async execute(ctx: RequestContext, input: ListOrdersInput) {
        const result = await this.orderService.findAll(ctx, orderListOptions(input), ['lines']);
        return page(
            result.items.map(order => orderSummary(order)),
            result.totalItems,
            input,
        );
    }
}
