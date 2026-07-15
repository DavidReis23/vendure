import { Injectable } from '@nestjs/common';
import { CustomerService, ID, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { idProp, objectSchema } from '../schema-helpers';
import { customerSummary } from '../serializers';

interface GetCustomerInput {
    id: ID;
}

@McpTool({
    name: 'get_customer',
    toolset: 'admin',
    description: 'Get a customer by id.',
    permissions: [Permission.ReadCustomer],
    readOnly: true,
    inputSchema: objectSchema({ id: idProp('Customer ID.') }),
})
@Injectable()
export class GetCustomerTool implements McpPluginToolHandler<GetCustomerInput> {
    constructor(private customerService: CustomerService) {}

    async execute(ctx: RequestContext, input: GetCustomerInput) {
        return { customer: customerSummary(await this.customerService.findOne(ctx, input.id, ['user'])) };
    }
}
