import { Injectable } from '@nestjs/common';
import { ID, Permission, ProductService, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { idArrayProp, idProp, objectSchema, optional } from '../schema-helpers';
import { productSummary } from '../serializers';

interface UpdateProductAssetsInput {
    id: ID;
    assetIds: ID[];
    featuredAssetId?: ID;
}

@McpTool({
    name: 'update_product_assets',
    toolset: 'admin',
    description: 'Update product asset ids.',
    permissions: [Permission.UpdateProduct],
    inputSchema: objectSchema({
        id: idProp('Product ID.'),
        assetIds: idArrayProp('Ordered asset IDs to set on the product.'),
        featuredAssetId: optional(idProp('Featured asset ID.')),
    }),
})
@Injectable()
export class UpdateProductAssetsTool implements McpPluginToolHandler<UpdateProductAssetsInput> {
    constructor(private productService: ProductService) {}

    async execute(ctx: RequestContext, input: UpdateProductAssetsInput) {
        return {
            product: productSummary(
                await this.productService.update(ctx, {
                    id: input.id,
                    assetIds: input.assetIds,
                    featuredAssetId: input.featuredAssetId,
                }),
            ),
        };
    }
}
