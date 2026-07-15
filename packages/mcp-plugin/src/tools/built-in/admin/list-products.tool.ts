import { Injectable } from '@nestjs/common';
import { Permission, Product, ProductService, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { listOptions, page } from '../order-helpers';
import { numberProp, objectSchema, optional } from '../schema-helpers';
import { productSummary } from '../serializers';

interface ListProductsInput extends Record<string, unknown> {
    limit?: number;
    offset?: number;
}

@McpTool({
    name: 'list_products',
    toolset: 'admin',
    description: 'List products.',
    permissions: [Permission.ReadProduct],
    readOnly: true,
    inputSchema: objectSchema({
        limit: optional(numberProp('Maximum number of products to return.')),
        offset: optional(numberProp('Number of products to skip.')),
    }),
})
@Injectable()
export class ListProductsTool implements McpPluginToolHandler<ListProductsInput> {
    constructor(private productService: ProductService) {}

    async execute(ctx: RequestContext, input: ListProductsInput) {
        const result = await this.productService.findAll(ctx, listOptions<Product>(input), ['featuredAsset']);
        return page(
            result.items.map(product => productSummary(product)),
            result.totalItems,
            input,
        );
    }
}
