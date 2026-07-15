import { Injectable } from '@nestjs/common';
import { Channel, ChannelService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { listOptions, page } from '../order-helpers';
import { numberProp, objectSchema, optional } from '../schema-helpers';

interface ListChannelsInput extends Record<string, unknown> {
    limit?: number;
    offset?: number;
}

@McpTool({
    name: 'list_channels',
    toolset: 'admin',
    description: 'List channels available to the current administrator.',
    permissions: [Permission.Authenticated],
    readOnly: true,
    inputSchema: objectSchema({
        limit: optional(numberProp('Maximum number of channels to return.')),
        offset: optional(numberProp('Number of channels to skip.')),
    }),
})
@Injectable()
export class ListChannelsTool implements McpPluginToolHandler<ListChannelsInput> {
    constructor(private channelService: ChannelService) {}

    async execute(ctx: RequestContext, input: ListChannelsInput) {
        const result = await this.channelService.findAll(ctx, listOptions<Channel>(input));
        return page(
            result.items.map(channel => ({ id: channel.id, code: channel.code, token: channel.token })),
            result.totalItems,
            input,
        );
    }
}
