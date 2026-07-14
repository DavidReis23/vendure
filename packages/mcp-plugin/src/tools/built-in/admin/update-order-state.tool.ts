import { Injectable } from '@nestjs/common';
import { ID, OrderService, OrderState, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { idProp, objectSchema, stringProp } from '../schema-helpers';
import { orderResult } from '../tool-kit';

interface UpdateOrderStateInput {
    id: ID;
    state: string;
}

@McpTool({
    name: 'update_order_state',
    toolset: 'admin',
    description: 'Transition an order to a new state.',
    permissions: [Permission.UpdateOrder],
    requiresConfirmation: true,
    inputSchema: objectSchema({
        id: idProp('Order ID.'),
        state: stringProp('Target order state, e.g. "Shipped" or "Cancelled".'),
    }),
})
@Injectable()
export class UpdateOrderStateTool implements McpPluginToolHandler<UpdateOrderStateInput> {
    constructor(private orderService: OrderService) {}

    async execute(ctx: RequestContext, input: UpdateOrderStateInput) {
        // The strict input schema guarantees `state` is a string; the state machine validates that it
        // is a legal target, so we cast the validated string straight to OrderState.
        return orderResult(
            await this.orderService.transitionToState(ctx, input.id, input.state as OrderState),
        );
    }
}
