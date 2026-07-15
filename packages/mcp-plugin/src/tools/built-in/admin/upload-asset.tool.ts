import { Injectable } from '@nestjs/common';
import { AssetService, ConfigService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { uploadAssetFromUrl } from '../remote-asset';
import { objectSchema, stringProp } from '../schema-helpers';

interface UploadAssetInput {
    url: string;
}

@McpTool({
    name: 'upload_asset',
    toolset: 'admin',
    description: 'Upload an asset from a publicly reachable HTTP(S) URL.',
    permissions: [Permission.CreateAsset],
    inputSchema: objectSchema({
        url: stringProp('Public HTTP(S) URL of the asset to fetch and store.'),
    }),
})
@Injectable()
export class UploadAssetTool implements McpPluginToolHandler<UploadAssetInput> {
    constructor(
        private assetService: AssetService,
        private configService: ConfigService,
    ) {}

    async execute(ctx: RequestContext, input: UploadAssetInput) {
        return {
            asset: await uploadAssetFromUrl(
                ctx,
                input.url,
                this.assetService,
                this.configService.importExportOptions.assetImportStrategy,
            ),
        };
    }
}
