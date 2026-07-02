import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { Ctx, RequestContext } from '@vendure/core';
import type { Response } from 'express';

import { McpToolset } from '../types';

import { AuthorizeInput, RegisterClientInput, StorefrontCallbackInput, TokenInput } from './oauth-types';
import { OAuthService } from './oauth.service';

@Controller()
export class McpOAuthController {
    constructor(private oauthService: OAuthService) {}

    @Get('.well-known/oauth-authorization-server')
    metadata() {
        return this.oauthService.metadata();
    }

    @Get('.well-known/oauth-protected-resource/mcp/:endpoint')
    protectedResourceMetadata(@Param('endpoint') endpoint: McpToolset) {
        return this.oauthService.protectedResourceMetadata(endpoint);
    }

    @Post('mcp/oauth/register')
    register(@Body() input: RegisterClientInput) {
        return this.oauthService.registerClient(input);
    }

    @Get('mcp/oauth/authorize')
    async authorize(@Query() input: AuthorizeInput, @Res() res: Response): Promise<void> {
        const redirectUrl = await this.oauthService.createAuthorizationRedirect(input);
        res.redirect(redirectUrl);
    }

    @Get('mcp/oauth/authorization-request')
    authorizationRequest(@Query('session') session: string) {
        return this.oauthService.getAuthorizationRequestInfo(session);
    }

    @Post('mcp/oauth/token')
    token(@Body() input: TokenInput) {
        return this.oauthService.exchangeToken(input);
    }

    @Post('mcp/oauth/revoke')
    revoke(@Body('token') token?: string) {
        return this.oauthService.revoke(token);
    }

    @Post('mcp/oauth/admin-consent')
    adminConsent(
        @Ctx() ctx: RequestContext,
        @Body('session') session: string,
        @Body('approved') approved: boolean,
    ) {
        return this.oauthService.approveAdminRequest(ctx, session, approved === true);
    }

    @Post('mcp/oauth/storefront-callback')
    storefrontCallback(@Body() input: StorefrontCallbackInput) {
        return this.oauthService.completeStorefrontRequest(input);
    }
}
