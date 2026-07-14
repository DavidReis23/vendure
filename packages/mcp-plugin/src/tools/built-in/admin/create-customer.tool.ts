import { Injectable } from '@nestjs/common';
import { CreateCustomerInput } from '@vendure/common/lib/generated-types';
import { CustomerService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { jsonObjectProp, objectSchema, optional, stringProp } from '../schema-helpers';
import { customerSummaryResult } from '../tool-kit';

interface CreateCustomerToolInput {
    input: CreateCustomerInput;
    password?: string;
}

const customerInputSchema = objectSchema({
    firstName: stringProp('Customer first name.'),
    lastName: stringProp('Customer last name.'),
    emailAddress: { ...stringProp('Customer email address.'), format: 'email' },
    phoneNumber: optional(stringProp('Customer phone number.')),
    title: optional(stringProp('Customer title, e.g. "Mr" or "Ms".')),
    customFields: optional(jsonObjectProp('Customer custom fields.')),
});

@McpTool({
    name: 'create_customer',
    toolset: 'admin',
    description: 'Create a customer.',
    permissions: [Permission.CreateCustomer],
    inputSchema: objectSchema({
        input: customerInputSchema,
        password: optional(stringProp('Optional password to create a registered account.')),
    }),
})
@Injectable()
export class CreateCustomerTool implements McpPluginToolHandler<CreateCustomerToolInput> {
    constructor(private customerService: CustomerService) {}

    async execute(ctx: RequestContext, input: CreateCustomerToolInput) {
        return {
            customer: customerSummaryResult(
                await this.customerService.create(ctx, input.input, input.password),
            ),
        };
    }
}
