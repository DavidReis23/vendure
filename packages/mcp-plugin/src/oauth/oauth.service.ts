import {
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import {
    AuthenticatedSession,
    ChannelService,
    ID,
    idsAreEqual,
    RequestContext,
    RequestContextService,
    Session,
    SessionService,
    TransactionalConnection,
    User,
    UserService,
} from '@vendure/core';
import { McpToolset } from '@vendure/mcp-sdk';

import { MCP_PLUGIN_OPTIONS, mcpServerPermission } from '../constants';
import { McpAuthorizationCode } from '../entities/mcp-authorization-code.entity';
import { McpAuthorizationRequest } from '../entities/mcp-authorization-request.entity';
import { McpOauthClient } from '../entities/mcp-oauth-client.entity';
import { McpOauthGrant } from '../entities/mcp-oauth-grant.entity';
import { McpActorType, McpAuthenticatedContext, McpPluginOptions, ResolvedMcpOauthOptions } from '../types';

import {
    AuthorizationRequestInfo,
    AuthorizeInput,
    OAuthTokenResponse,
    RegisterClientInput,
    RegisteredClientResponse,
    StorefrontCallbackInput,
    TokenInput,
} from './oauth-types';
import { addSeconds, appendOAuthParams, randomToken, verifyPkceChallenge } from './oauth-utils';
import { deriveHashKey, hashToken } from './token-hash';

/**
 * Name recorded against the dedicated Vendure session minted for an MCP grant.
 */
const MCP_SESSION_STRATEGY = 'mcp-dedicated-session';

/**
 * Implements the MCP OAuth 2.1 authorization server.
 *
 * Core Features:
 * - Handles Dynamic Client Registration, authorize/consent flows, revocation, and `.well-known` metadata.
 * - Supports authorization-code and refresh-token grants.
 *
 * Session & Security Mechanics:
 * - Dedicated Sessions: Each grant mints a new, isolated Vendure session instead of copying the user's session token.
 * - Token Hashing: Uses an unprefixed hash of the access token.
 *   This intentionally differs from Vendure's `lookup:`-prefixed database entries so a compromised column value cannot be weaponized as a session.
 * - Lifecycle: Tracks the session via {@link McpOauthGrant.vendureSessionId} to handle automated lookups, re-minting on expiration, and cleanup on revocation.
 */
@Injectable()
export class McpOauthService {
    private cachedHashKey: Buffer | undefined;

    constructor(
        private connection: TransactionalConnection,
        private requestContextService: RequestContextService,
        private sessionService: SessionService,
        private channelService: ChannelService,
        private userService: UserService,
        @Inject(MCP_PLUGIN_OPTIONS) private options: McpPluginOptions,
    ) {}

    async registerClient(input: RegisterClientInput): Promise<RegisteredClientResponse> {
        if (!input.client_name) {
            throw new BadRequestException('client_name is required');
        }
        if (!input.redirect_uris || input.redirect_uris.length === 0) {
            throw new BadRequestException('redirect_uris is required');
        }
        for (const redirectUri of input.redirect_uris) {
            this.assertSafeRedirectUri(redirectUri);
        }
        const ctx = await this.createAdminCtx();
        const client = await this.connection.getRepository(ctx, McpOauthClient).save(
            new McpOauthClient({
                clientId: randomToken(),
                clientName: input.client_name,
                clientUri: input.client_uri ?? null,
                logoUri: input.logo_uri ?? null,
                redirectUris: input.redirect_uris,
                grantTypes: input.grant_types ?? ['authorization_code', 'refresh_token'],
                tokenEndpointAuthMethod: input.token_endpoint_auth_method ?? 'none',
                lastUsedAt: null,
            }),
        );

        return {
            client_id: client.clientId,
            client_name: client.clientName,
            ...(client.clientUri ? { client_uri: client.clientUri } : {}),
            ...(client.logoUri ? { logo_uri: client.logoUri } : {}),
            redirect_uris: client.redirectUris,
            grant_types: client.grantTypes,
            token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        };
    }

    metadata() {
        const issuer = this.issuerOrigin();
        return {
            issuer,
            authorization_endpoint: `${issuer}/mcp/oauth/authorize`,
            token_endpoint: `${issuer}/mcp/oauth/token`,
            registration_endpoint: `${issuer}/mcp/oauth/register`,
            revocation_endpoint: `${issuer}/mcp/oauth/revoke`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
        };
    }

    protectedResourceMetadata(endpoint: McpToolset) {
        const issuer = this.issuerOrigin();
        return {
            resource: this.resourceForToolset(endpoint),
            authorization_servers: [issuer],
            bearer_methods_supported: ['header'],
            resource_name: `Vendure ${endpoint} MCP`,
        };
    }

    protectedResourceMetadataUrl(endpoint: McpToolset): string {
        return `${this.issuerOrigin()}/.well-known/oauth-protected-resource/mcp/${endpoint}`;
    }

    async createAuthorizationRedirect(input: AuthorizeInput): Promise<string> {
        if (input.response_type !== 'code') {
            throw new BadRequestException('Only response_type=code is supported');
        }
        if (!input.client_id || !input.redirect_uri || !input.code_challenge) {
            throw new BadRequestException('client_id, redirect_uri and code_challenge are required');
        }
        if (input.code_challenge_method !== 'S256') {
            throw new BadRequestException('Only PKCE S256 is supported');
        }
        const ctx = await this.createAdminCtx();
        const client = await this.findClient(ctx, input.client_id);
        if (!client.redirectUris.includes(input.redirect_uri)) {
            throw new BadRequestException('redirect_uri is not registered for client');
        }
        const { resource, toolset } = this.resolveResource(input.resource);
        const requestTokenPlaintext = randomToken();
        await this.connection.getRepository(ctx, McpAuthorizationRequest).save(
            new McpAuthorizationRequest({
                requestToken: this.hashLookup(requestTokenPlaintext),
                oauthClient: client,
                oauthClientId: client.id,
                redirectUri: input.redirect_uri,
                state: input.state ?? null,
                codeChallenge: input.code_challenge,
                codeChallengeMethod: 'S256',
                toolset,
                resource,
                expiresAt: addSeconds(new Date(), this.resolvedOauth().authorizationRequestTtlSeconds),
                consumedAt: null,
            }),
        );
        const consentUrl =
            toolset === 'admin'
                ? new URL(this.resolvedOauth().adminConsentPath, this.resolvedOauth().issuer)
                : new URL(this.resolvedOauth().storefrontConsentUrl);
        consentUrl.searchParams.set('session', requestTokenPlaintext);
        return consentUrl.toString();
    }

    async getAuthorizationRequestInfo(requestToken: string | undefined): Promise<AuthorizationRequestInfo> {
        if (!requestToken) {
            throw new BadRequestException('session is required');
        }
        const request = await this.findActiveAuthorizationRequest(requestToken);
        const client = request.oauthClient;
        return {
            client_id: client.clientId,
            client_name: client.clientName,
            ...(client.clientUri ? { client_uri: client.clientUri } : {}),
            ...(client.logoUri ? { logo_uri: client.logoUri } : {}),
            redirect_uri: request.redirectUri,
            resource: request.resource,
            toolset: request.toolset,
        };
    }

    async approveAdminRequest(
        ctx: RequestContext,
        requestToken: string,
        approved: boolean,
    ): Promise<{ redirectUrl: string }> {
        if (!ctx.activeUserId || !ctx.session?.token) {
            throw new UnauthorizedException('Admin consent requires an authenticated administrator session');
        }

        if (!ctx.userHasPermissions([mcpServerPermission.Update])) {
            throw new ForbiddenException(
                'Admin consent requires an administrator with the UpdateMcpServer permission',
            );
        }
        this.assertConsentRequestOrigin(ctx);
        return this.completeAuthorizationRequest(requestToken, approved, ctx.activeUserId, 'admin');
    }

    async completeStorefrontRequest(input: StorefrontCallbackInput): Promise<{ redirectUrl: string }> {
        if (!input.session) {
            throw new BadRequestException('session is required');
        }
        if (input.approved === false) {
            return this.completeAuthorizationRequest(input.session, false, null, 'customer');
        }
        if (!input.vendureAuthToken) {
            throw new BadRequestException('vendureAuthToken is required');
        }
        const vendureSession = await this.sessionService.getSessionFromToken(input.vendureAuthToken);
        if (!vendureSession?.user) {
            throw new UnauthorizedException('Invalid Vendure storefront session');
        }
        const channelId = input.channelToken
            ? await this.resolveChannelId(input.channelToken)
            : (vendureSession.activeChannelId ?? null);
        return this.completeAuthorizationRequest(
            input.session,
            true,
            vendureSession.user.id,
            'customer',
            channelId,
        );
    }

    async exchangeToken(input: TokenInput) {
        if (input.grant_type === 'authorization_code') {
            return this.exchangeAuthorizationCode(input);
        }
        if (input.grant_type === 'refresh_token') {
            return this.exchangeRefreshToken(input);
        }
        throw new BadRequestException('Unsupported grant_type');
    }

    async revoke(token: string | undefined): Promise<Record<string, never>> {
        if (!token) {
            return {};
        }
        const ctx = await this.createAdminCtx();
        const hash = this.hashLookup(token);
        // Either token of the pair identifies the grant, and revoking one kills the
        // whole grant (RFC 7009: revoking a refresh token invalidates its access token).
        const grant = await this.connection.getRepository(ctx, McpOauthGrant).findOne({
            where: [{ accessTokenHash: hash }, { refreshTokenHash: hash }],
        });
        if (grant && !grant.revokedAt) {
            await this.revokeGrant(ctx, grant);
        }
        return {};
    }

    async revokeGrantById(ctx: RequestContext, grantId: ID): Promise<boolean> {
        const grant = await this.connection
            .getRepository(ctx, McpOauthGrant)
            .findOne({ where: { id: grantId } });
        if (!grant) {
            return false;
        }
        if (
            ctx.channelId != null &&
            grant.channelId != null &&
            !idsAreEqual(grant.channelId, ctx.channelId)
        ) {
            return false;
        }
        if (!grant.revokedAt) {
            await this.revokeGrant(ctx, grant);
        }
        return true;
    }

    private async revokeGrant(ctx: RequestContext, grant: McpOauthGrant): Promise<void> {
        await this.deleteVendureSession(ctx, grant.vendureSessionId);
        await this.connection
            .getRepository(ctx, McpOauthGrant)
            .update({ id: grant.id }, { revokedAt: new Date() });
    }

    async authenticateBearerToken(token: string, apiType: McpToolset): Promise<McpAuthenticatedContext> {
        const adminCtx = await this.createAdminCtx();
        const grant = await this.connection.getRepository(adminCtx, McpOauthGrant).findOne({
            where: { accessTokenHash: this.hashLookup(token) },
            relations: ['oauthClient'],
        });
        if (!grant || grant.revokedAt || grant.accessTokenExpiresAt <= new Date()) {
            throw new UnauthorizedException('Invalid or expired access token');
        }
        if (
            (apiType === 'admin' && grant.userType !== 'admin') ||
            (apiType === 'shop' && grant.userType !== 'customer')
        ) {
            throw new UnauthorizedException('Access token does not allow this MCP endpoint');
        }
        if (grant.resource !== this.resourceForToolset(apiType)) {
            throw new UnauthorizedException('Access token was not issued for this MCP resource');
        }
        if (grant.expiresAt <= new Date()) {
            throw new UnauthorizedException('MCP grant is expired');
        }

        const sessionToken = hashToken(token, this.getHashKey());
        let vendureSession = await this.sessionService.getSessionFromToken(sessionToken);
        if (!vendureSession) {
            const user = await this.userService.getUserById(adminCtx, grant.userId);
            if (!user) {
                throw new UnauthorizedException('Vendure user no longer exists');
            }
            // The lapsed session row may still be in the table — Vendure clears expired
            // sessions with a background job, not on read — and it holds the same unique
            // token we are about to mint, so we delete.
            await this.deleteVendureSession(adminCtx, grant.vendureSessionId);
            const minted = await this.mintVendureSession(adminCtx, user, token);
            grant.vendureSessionId = minted.id;
            vendureSession = await this.sessionService.getSessionFromToken(sessionToken);
            if (!vendureSession) {
                throw new UnauthorizedException('Failed to establish Vendure session');
            }
        }

        const channel = grant.channelId
            ? await this.channelService.findOne(adminCtx, grant.channelId)
            : await this.channelService.getDefaultChannel(adminCtx);
        const ctx = new RequestContext({
            apiType,
            channel: channel ?? (await this.channelService.getDefaultChannel(adminCtx)),
            session: vendureSession,
            isAuthorized: true,
            authorizedAsOwnerOnly: false,
        });
        grant.lastActivityAt = new Date();
        await this.connection.getRepository(adminCtx, McpOauthGrant).save(grant);
        return { ctx, grant };
    }

    async createAnonymousShopContext(sessionToken?: string, channelToken?: string): Promise<RequestContext> {
        const existingSession = sessionToken
            ? await this.sessionService.getSessionFromToken(sessionToken)
            : undefined;
        const vendureSession =
            existingSession && !existingSession.user
                ? existingSession
                : await this.sessionService.createAnonymousSession();
        const adminCtx = await this.createAdminCtx();
        const channel = channelToken
            ? await this.channelService.getChannelFromToken(adminCtx, channelToken)
            : await this.channelService.getDefaultChannel(adminCtx);
        return new RequestContext({
            apiType: 'shop',
            channel,
            session: vendureSession,
            isAuthorized: false,
            authorizedAsOwnerOnly: true,
        });
    }

    private async completeAuthorizationRequest(
        requestToken: string,
        approved: boolean,
        userId: ID | null,
        userType: McpActorType,
        channelId: ID | null = null,
    ): Promise<{ redirectUrl: string }> {
        const ctx = await this.createAdminCtx();
        const request = await this.findActiveAuthorizationRequest(requestToken, ctx);
        const claim = await this.connection
            .getRepository(ctx, McpAuthorizationRequest)
            .createQueryBuilder()
            .update(McpAuthorizationRequest)
            .set({ consumedAt: () => 'CURRENT_TIMESTAMP' })
            .where('requestToken = :requestToken', { requestToken: this.hashLookup(requestToken) })
            .andWhere('consumedAt IS NULL')
            .execute();
        if (!claim.affected) {
            throw new BadRequestException('Authorization request invalid or expired');
        }

        if (!approved) {
            return {
                redirectUrl: appendOAuthParams(request.redirectUri, {
                    error: 'access_denied',
                    state: request.state ?? undefined,
                }),
            };
        }
        if (userId == null) {
            throw new UnauthorizedException('Authenticated Vendure session required');
        }
        const codePlaintext = randomToken();
        await this.connection.getRepository(ctx, McpAuthorizationCode).save(
            new McpAuthorizationCode({
                code: this.hashLookup(codePlaintext),
                oauthClient: request.oauthClient,
                oauthClientId: request.oauthClientId,
                userId,
                userType,
                redirectUri: request.redirectUri,
                resource: request.resource,
                codeChallenge: request.codeChallenge,
                codeChallengeMethod: request.codeChallengeMethod,
                channelId,
                expiresAt: addSeconds(new Date(), this.resolvedOauth().authorizationCodeTtlSeconds),
                consumedAt: null,
            }),
        );
        return {
            redirectUrl: appendOAuthParams(request.redirectUri, {
                code: codePlaintext,
                state: request.state ?? undefined,
            }),
        };
    }

    private async exchangeAuthorizationCode(input: TokenInput) {
        if (
            !input.code ||
            !input.client_id ||
            !input.redirect_uri ||
            !input.code_verifier ||
            !input.resource
        ) {
            throw new BadRequestException(
                'code, client_id, redirect_uri, code_verifier and resource are required',
            );
        }
        const { resource } = this.resolveResource(input.resource);
        const ctx = await this.createAdminCtx();
        const codeRepo = this.connection.getRepository(ctx, McpAuthorizationCode);
        const code = await codeRepo.findOne({
            where: { code: this.hashLookup(input.code) },
            relations: ['oauthClient'],
        });
        if (!code || code.consumedAt || code.expiresAt <= new Date()) {
            throw new BadRequestException('Authorization code invalid or expired');
        }
        if (code.oauthClient.clientId !== input.client_id || code.redirectUri !== input.redirect_uri) {
            throw new BadRequestException('Authorization code does not match client or redirect_uri');
        }
        if (code.resource !== resource) {
            throw new BadRequestException('Authorization code does not match token request resource');
        }
        if (!verifyPkceChallenge(input.code_verifier, code.codeChallenge)) {
            throw new BadRequestException('Invalid PKCE verifier');
        }
        const claim = await codeRepo
            .createQueryBuilder()
            .update(McpAuthorizationCode)
            .set({ consumedAt: () => 'CURRENT_TIMESTAMP' })
            .where('code = :code', { code: this.hashLookup(input.code) })
            .andWhere('consumedAt IS NULL')
            .execute();
        if (!claim.affected) {
            throw new BadRequestException('Authorization code invalid or expired');
        }
        return this.issueTokenPair(
            ctx,
            code.oauthClient,
            code.userId,
            code.userType,
            code.resource,
            code.channelId,
        );
    }

    private async exchangeRefreshToken(input: TokenInput) {
        if (!input.refresh_token || !input.client_id || !input.resource) {
            throw new BadRequestException('refresh_token, client_id and resource are required');
        }
        const { resource } = this.resolveResource(input.resource);
        const ctx = await this.createAdminCtx();
        const sessionRepo = this.connection.getRepository(ctx, McpOauthGrant);
        const refreshTokenHash = this.hashLookup(input.refresh_token);
        const grant = await sessionRepo.findOne({
            where: { refreshTokenHash },
            relations: ['oauthClient'],
        });
        if (!grant) {
            const reused = await sessionRepo.findOne({
                where: { previousRefreshTokenHash: refreshTokenHash },
            });
            if (reused && !reused.revokedAt) {
                await this.revokeGrant(ctx, reused);
            }
            throw new BadRequestException('Refresh token invalid or expired');
        }
        if (grant.revokedAt || grant.expiresAt <= new Date()) {
            throw new BadRequestException('Refresh token invalid or expired');
        }
        if (grant.oauthClient.clientId !== input.client_id) {
            throw new BadRequestException('Refresh token does not match client');
        }
        if (grant.resource !== resource) {
            throw new BadRequestException('Refresh token does not match token request resource');
        }

        const now = new Date();
        const accessPlaintext = randomToken();
        const refreshPlaintext = randomToken();
        // Atomically claim the rotation by swapping the token hashes in place. If two
        // requests race with the same refresh token, only one UPDATE matches; the loser
        // sees affected=0 and is rejected. The old refresh hash is kept so a later
        // replay of it is recognized as reuse (above) rather than an unknown token.
        const claim = await sessionRepo
            .createQueryBuilder()
            .update(McpOauthGrant)
            .set({
                accessTokenHash: this.hashLookup(accessPlaintext),
                refreshTokenHash: this.hashLookup(refreshPlaintext),
                previousRefreshTokenHash: refreshTokenHash,
                accessTokenExpiresAt: addSeconds(now, this.resolvedOauth().accessTokenTtlSeconds),
                expiresAt: addSeconds(now, this.resolvedOauth().refreshTokenTtlSeconds),
                lastActivityAt: now,
            })
            .where('id = :id', { id: grant.id })
            .andWhere('refreshTokenHash = :refreshTokenHash', { refreshTokenHash })
            .andWhere('revokedAt IS NULL')
            .execute();
        if (!claim.affected) {
            throw new BadRequestException('Refresh token invalid or expired');
        }

        // The minted Vendure session is keyed by the access-token plaintext hash, so
        // the new access token needs a freshly minted session.
        const user = await this.userService.getUserById(ctx, grant.userId);
        if (!user) {
            throw new BadRequestException('Vendure user no longer exists');
        }
        await this.deleteVendureSession(ctx, grant.vendureSessionId);
        const minted = await this.mintVendureSession(ctx, user, accessPlaintext);
        await sessionRepo.update({ id: grant.id }, { vendureSessionId: minted.id });

        grant.oauthClient.lastUsedAt = now;
        await this.connection.getRepository(ctx, McpOauthClient).save(grant.oauthClient);
        return this.tokenResponse(accessPlaintext, refreshPlaintext);
    }

    private async issueTokenPair(
        ctx: RequestContext,
        client: McpOauthClient,
        userId: ID,
        userType: McpActorType,
        resource: string,
        channelId: ID | null = null,
    ): Promise<OAuthTokenResponse> {
        const user = await this.userService.getUserById(ctx, userId);
        if (!user) {
            throw new BadRequestException('Vendure user no longer exists');
        }
        const now = new Date();
        const accessPlaintext = randomToken();
        const refreshPlaintext = randomToken();
        const mintedSession = await this.mintVendureSession(ctx, user, accessPlaintext);
        await this.connection.getRepository(ctx, McpOauthGrant).save(
            new McpOauthGrant({
                accessTokenHash: this.hashLookup(accessPlaintext),
                refreshTokenHash: this.hashLookup(refreshPlaintext),
                previousRefreshTokenHash: null,
                oauthClient: client,
                oauthClientId: client.id,
                userId,
                userType,
                resource,
                accessTokenExpiresAt: addSeconds(now, this.resolvedOauth().accessTokenTtlSeconds),
                expiresAt: addSeconds(now, this.resolvedOauth().refreshTokenTtlSeconds),
                revokedAt: null,
                vendureSessionId: mintedSession.id,
                channelId,
                lastActivityAt: now,
            }),
        );

        client.lastUsedAt = now;
        await this.connection.getRepository(ctx, McpOauthClient).save(client);
        return this.tokenResponse(accessPlaintext, refreshPlaintext);
    }

    private tokenResponse(accessPlaintext: string, refreshPlaintext: string): OAuthTokenResponse {
        return {
            access_token: accessPlaintext,
            refresh_token: refreshPlaintext,
            token_type: 'Bearer',
            expires_in: this.resolvedOauth().accessTokenTtlSeconds,
        };
    }

    /**
     * Mints a dedicated Vendure session whose token is the unprefixed hash of the
     * access-token plaintext. This is NOT the `lookup:`-prefixed hash stored in the
     * token column, so a stored column value can't be replayed as a session token.
     */
    private mintVendureSession(
        ctx: RequestContext,
        user: User,
        accessTokenPlaintext: string,
    ): Promise<AuthenticatedSession> {
        return this.sessionService.createNewAuthenticatedSession(
            ctx,
            user,
            MCP_SESSION_STRATEGY,
            hashToken(accessTokenPlaintext, this.getHashKey()),
        );
    }

    /** Removes a Vendure session row by id, if it still exists. */
    private async deleteVendureSession(ctx: RequestContext, sessionId: ID): Promise<void> {
        const session = await this.connection
            .getRepository(ctx, Session)
            .findOne({ where: { id: sessionId } });
        if (session) {
            await this.connection.getRepository(ctx, Session).remove(session);
        }
    }

    private async findClient(ctx: RequestContext, clientId: string): Promise<McpOauthClient> {
        const client = await this.connection.getRepository(ctx, McpOauthClient).findOne({
            where: { clientId },
        });
        if (!client) {
            throw new BadRequestException('Unknown OAuth client');
        }
        return client;
    }

    private async findActiveAuthorizationRequest(
        requestToken: string,
        ctx?: RequestContext,
    ): Promise<McpAuthorizationRequest> {
        const requestCtx = ctx ?? (await this.createAdminCtx());
        const request = await this.connection.getRepository(requestCtx, McpAuthorizationRequest).findOne({
            where: { requestToken: this.hashLookup(requestToken) },
            relations: ['oauthClient'],
        });
        if (!request || request.consumedAt || request.expiresAt <= new Date()) {
            throw new BadRequestException('Authorization request invalid or expired');
        }
        return request;
    }

    private createAdminCtx(): Promise<RequestContext> {
        return this.requestContextService.create({ apiType: 'admin' });
    }

    private resolveResource(resource?: string): { resource: string; toolset: McpToolset } {
        if (!resource) {
            throw new BadRequestException('resource is required');
        }
        try {
            const url = new URL(resource);
            if (url.search || url.hash) {
                throw new Error('OAuth resource must not include query parameters or fragments');
            }
            for (const toolset of ['shop', 'admin'] as const) {
                if (this.sameResourceUrl(url, new URL(this.resourceForToolset(toolset)))) {
                    return { resource: this.resourceForToolset(toolset), toolset };
                }
            }
        } catch {
            throw new BadRequestException('Unsupported OAuth resource');
        }
        throw new BadRequestException('Unsupported OAuth resource');
    }

    private sameResourceUrl(left: URL, right: URL): boolean {
        return (
            left.protocol.toLowerCase() === right.protocol.toLowerCase() &&
            left.hostname.toLowerCase() === right.hostname.toLowerCase() &&
            left.port === right.port &&
            this.normalizeResourcePath(left.pathname) === this.normalizeResourcePath(right.pathname)
        );
    }

    private normalizeResourcePath(pathname: string): string {
        return pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
    }

    /** The configured issuer URL with any trailing slash removed. */
    private issuerOrigin(): string {
        return this.resolvedOauth().issuer.replace(/\/$/, '');
    }

    private resourceForToolset(toolset: McpToolset): string {
        return `${this.issuerOrigin()}/mcp/${toolset}`;
    }

    /**
     * Blocks CSRF on admin consent: the approval rides the admin's login cookie
     * (auto-sent by the browser), so we require the request to come from our own
     * consent page (its Origin, or Referer). A request with an `Authorization` header
     * can't be forged cross-site, so it skips the check (also covers API clients).
     */
    private assertConsentRequestOrigin(ctx: RequestContext): void {
        const headers = ctx.req?.headers;
        if (headers?.authorization) {
            return;
        }
        const rawOrigin = headers?.origin;
        const originHeader = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
        const source = originHeader ?? headers?.referer;
        let requestOrigin: string | undefined;
        if (source) {
            try {
                requestOrigin = new URL(source).origin;
            } catch {
                requestOrigin = undefined;
            }
        }
        const expectedOrigin = new URL(this.resolvedOauth().issuer).origin;
        if (requestOrigin !== expectedOrigin) {
            throw new ForbiddenException('Admin consent must be submitted from the Vendure consent page');
        }
    }

    private assertSafeRedirectUri(redirectUri: string): void {
        let url: URL;
        try {
            url = new URL(redirectUri);
        } catch {
            throw new BadRequestException('redirect_uri must be an absolute URL');
        }
        const hostname = url.hostname.toLowerCase();
        const isLoopback =
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '::1' ||
            hostname === '[::1]';
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
            throw new BadRequestException('redirect_uri must use HTTPS or localhost HTTP');
        }
    }

    private async resolveChannelId(channelToken: string): Promise<ID> {
        const ctx = await this.createAdminCtx();
        return (await this.channelService.getChannelFromToken(ctx, channelToken)).id;
    }

    /**
     * Returns the resolved OAuth options, throwing if OAuth was not configured
     * (i.e. no `oauth.tokenSecret` was supplied to the plugin).
     */
    private resolvedOauth(): ResolvedMcpOauthOptions {
        if (!this.options.oauth?.tokenSecret) {
            throw new BadRequestException('MCP OAuth is not configured (oauth.tokenSecret is required)');
        }
        return this.options.oauth as ResolvedMcpOauthOptions;
    }

    /**
     * Derives (once) and returns the HMAC key used to hash MCP tokens — both the
     * `lookup:`-prefixed values stored in the token/code/request columns and the
     * unprefixed session-token derivation for the Option-D session bridge.
     */
    private getHashKey(): Buffer {
        if (!this.cachedHashKey) {
            this.cachedHashKey = deriveHashKey(this.resolvedOauth().tokenSecret);
        }
        return this.cachedHashKey;
    }

    /**
     * Hashes a credential for storage and lookup in a token/code lookup column. The
     * 'lookup:' prefix keeps this distinct from the session-token derivation (plain
     * hashToken), so a stored column value can never be reused as a Vendure session token.
     */
    private hashLookup(value: string): string {
        return hashToken(`lookup:${value}`, this.getHashKey());
    }
}
