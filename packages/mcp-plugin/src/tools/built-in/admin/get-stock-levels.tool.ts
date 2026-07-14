import { Injectable } from '@nestjs/common';
import { ID, Permission, RequestContext, StockLevelService } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { idProp, objectSchema } from '../schema-helpers';

interface GetStockLevelsInput {
    variantId: ID;
}

@McpTool({
    name: 'get_stock_levels',
    toolset: 'admin',
    description: 'Get stock levels for a product variant.',
    permissions: [Permission.ReadProduct],
    readOnly: true,
    inputSchema: objectSchema({ variantId: idProp('Product variant ID.') }),
})
@Injectable()
export class GetStockLevelsTool implements McpPluginToolHandler<GetStockLevelsInput> {
    constructor(private stockLevelService: StockLevelService) {}

    async execute(ctx: RequestContext, input: GetStockLevelsInput) {
        return {
            stockLevels: await this.stockLevelService.getStockLevelsForVariant(ctx, input.variantId),
        };
    }
}
