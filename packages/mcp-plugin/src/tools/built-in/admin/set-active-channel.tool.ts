import { Injectable } from '@nestjs/common';
import { ChannelService, Permission, RequestContext, TransactionalConnection } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpOauthGrant } from '../../../entities/mcp-oauth-grant.entity';
import { McpExecutionContext, McpPluginToolHandler } from '../../../types';
import { objectSchema, stringProp } from '../schema-helpers';

interface SetActiveChannelInput {
    channelToken: string;
}

@McpTool({
    name: 'set_active_channel',
    toolset: 'admin',
    description: 'Set the active channel for this MCP grant by channel token.',
    permissions: [Permission.Authenticated],
    inputSchema: objectSchema({
        channelToken: stringProp('Channel token of the channel to activate.'),
    }),
})
@Injectable()
export class SetActiveChannelTool implements McpPluginToolHandler<SetActiveChannelInput> {
    constructor(
        private channelService: ChannelService,
        private connection: TransactionalConnection,
    ) {}

    async execute(ctx: RequestContext, input: SetActiveChannelInput, executionContext?: McpExecutionContext) {
        const channel = await this.channelService.getChannelFromToken(ctx, input.channelToken);
        // Persist the choice on the one merged grant row. Subsequent requests re-authenticate against
        // this grant, so its channelId becomes the active channel for later calls.
        const grant = executionContext?.grant;
        if (grant) {
            grant.channelId = channel.id;
            await this.connection.getRepository(ctx, McpOauthGrant).save(grant);
        }
        return { channel: { id: channel.id, code: channel.code, token: channel.token } };
    }
}
