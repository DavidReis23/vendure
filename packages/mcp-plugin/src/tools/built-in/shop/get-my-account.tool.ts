import { Injectable } from '@nestjs/common';
import { CustomerService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { objectSchema } from '../schema-helpers';
import { customerSummary } from '../tool-kit';

@McpTool({
    name: 'get_my_account',
    toolset: 'shop',
    description: 'Get the authenticated customer account.',
    permissions: [Permission.Authenticated],
    readOnly: true,
    inputSchema: objectSchema({}),
})
@Injectable()
export class GetMyAccountTool implements McpPluginToolHandler<Record<string, never>> {
    constructor(private customerService: CustomerService) {}

    async execute(ctx: RequestContext) {
        const customer = ctx.activeUserId
            ? await this.customerService.findOneByUserId(ctx, ctx.activeUserId)
            : undefined;
        return { customer: customerSummary(customer) };
    }
}
