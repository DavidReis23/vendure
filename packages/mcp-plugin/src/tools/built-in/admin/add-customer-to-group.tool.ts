import { Injectable } from '@nestjs/common';
import { CustomerGroupService, ID, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { idProp, objectSchema } from '../schema-helpers';

interface AddCustomerToGroupInput {
    customerId: ID;
    groupId: ID;
}

@McpTool({
    name: 'add_customer_to_group',
    toolset: 'admin',
    description: 'Add a customer to a customer group.',
    permissions: [Permission.UpdateCustomerGroup],
    inputSchema: objectSchema({
        customerId: idProp('Customer ID.'),
        groupId: idProp('Customer group ID.'),
    }),
})
@Injectable()
export class AddCustomerToGroupTool implements McpPluginToolHandler<AddCustomerToGroupInput> {
    constructor(private customerGroupService: CustomerGroupService) {}

    async execute(ctx: RequestContext, input: AddCustomerToGroupInput) {
        return {
            group: await this.customerGroupService.addCustomersToGroup(ctx, {
                customerGroupId: input.groupId,
                customerIds: [input.customerId],
            }),
        };
    }
}
