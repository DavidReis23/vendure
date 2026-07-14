import { Injectable } from '@nestjs/common';
import { CollectionService, ID, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { idProp, objectSchema, optional, stringProp } from '../schema-helpers';
import { collectionSummary } from '../tool-kit';

interface GetCollectionInput {
    id?: ID;
    slug?: string;
}

@McpTool({
    name: 'get_collection',
    toolset: 'shop',
    description: 'Get a public collection by ID or slug.',
    permissions: [Permission.Public],
    readOnly: true,
    inputSchema: objectSchema({
        id: optional(idProp('Collection ID.')),
        slug: optional(stringProp('Collection slug, used when ID is omitted.')),
    }),
})
@Injectable()
export class ShopGetCollectionTool implements McpPluginToolHandler<GetCollectionInput> {
    constructor(private collectionService: CollectionService) {}

    async execute(ctx: RequestContext, input: GetCollectionInput) {
        const collection =
            input.id != null
                ? await this.collectionService.findOne(ctx, input.id, ['featuredAsset'])
                : await this.collectionService.findOneBySlug(ctx, input.slug ?? '', ['featuredAsset']);
        return { collection: collection && !collection.isPrivate ? collectionSummary(collection) : null };
    }
}
