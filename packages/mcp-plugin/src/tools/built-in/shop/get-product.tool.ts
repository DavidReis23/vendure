import { Injectable } from '@nestjs/common';
import { ID, Permission, ProductService, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { idProp, objectSchema, optional, stringProp } from '../schema-helpers';
import { productSummary } from '../tool-kit';

interface GetProductInput {
    id?: ID;
    slug?: string;
}

@McpTool({
    name: 'get_product',
    toolset: 'shop',
    description: 'Get an enabled product by ID or slug.',
    permissions: [Permission.Public],
    readOnly: true,
    inputSchema: objectSchema({
        id: optional(idProp('Product ID.')),
        slug: optional(stringProp('Product slug, used when ID is omitted.')),
    }),
})
@Injectable()
export class ShopGetProductTool implements McpPluginToolHandler<GetProductInput> {
    constructor(private productService: ProductService) {}

    async execute(ctx: RequestContext, input: GetProductInput) {
        const product =
            input.id != null
                ? await this.productService.findOne(ctx, input.id, ['featuredAsset', 'assets'])
                : await this.productService.findOneBySlug(ctx, input.slug ?? '', ['featuredAsset', 'assets']);
        return { product: product?.enabled === true ? productSummary(product) : null };
    }
}
