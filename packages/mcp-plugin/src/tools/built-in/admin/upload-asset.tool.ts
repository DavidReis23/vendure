import { Injectable } from '@nestjs/common';
import { AssetService, Permission, RequestContext } from '@vendure/core';
import { McpTool } from '@vendure/mcp-sdk';

import { McpPluginToolHandler } from '../../../types';
import { objectSchema, stringProp } from '../schema-helpers';
import { uploadAssetFromUrl } from '../tool-kit';

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
    constructor(private assetService: AssetService) {}

    async execute(ctx: RequestContext, input: UploadAssetInput) {
        // The server fetches the caller-supplied URL, so uploadAssetFromUrl is SSRF-hardened (scheme +
        // private/reserved address rejection, redirect re-validation, timeout, and size caps).
        return { asset: await uploadAssetFromUrl(ctx, input.url, this.assetService) };
    }
}
