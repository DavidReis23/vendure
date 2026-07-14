import { Injectable } from '@nestjs/common';
import { Permission, ProductService, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { numberProp, objectSchema, optional, stringProp } from '../schema-helpers';
import { page, productSummary, publicProductListOptions } from '../tool-kit';

interface SearchProductsInput extends Record<string, unknown> {
    query?: string;
    limit?: number;
    offset?: number;
}

@McpTool({
    name: 'search_products',
    toolset: 'shop',
    description: 'Perform a basic name/slug lookup and return paginated product summaries.',
    permissions: [Permission.Public],
    readOnly: true,
    inputSchema: objectSchema({
        query: optional(stringProp('Text to look up in product names and slugs.')),
        limit: optional(numberProp('Maximum number of products to return.')),
        offset: optional(numberProp('Number of products to skip.')),
    }),
})
@Injectable()
export class SearchProductsTool implements McpPluginToolHandler<SearchProductsInput> {
    constructor(private productService: ProductService) {}

    async execute(ctx: RequestContext, input: SearchProductsInput) {
        const result = await this.productService.findAll(ctx, publicProductListOptions(input), [
            'featuredAsset',
        ]);
        return page(
            result.items.map(product => productSummary(product)),
            result.totalItems,
            input,
        );
    }
}
