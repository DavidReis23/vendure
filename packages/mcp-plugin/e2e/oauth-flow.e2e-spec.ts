import {
    ConfigService,
    mergeConfig,
    RequestContextService,
    Session,
    TransactionalConnection,
    User,
} from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { McpOauthGrant } from '../src/entities/mcp-oauth-grant.entity';
import { McpOauthService } from '../src/oauth/oauth.service';
import { deriveHashKey, hashToken } from '../src/oauth/token-hash';
import { McpPlugin } from '../src/plugin';

import { runAuthorizationCodeFlow } from './utils/oauth-test-client';

const TOKEN_SECRET = 'test-secret';
// The plugin's default issuer (see src/constants.ts), from which the resource is derived.
const ISSUER = 'http://localhost:3500';

describe('McpPlugin OAuth end-to-end flow', () => {
    const config = mergeConfig(testConfig(), {
        plugins: [McpPlugin.init({ oauth: { tokenSecret: TOKEN_SECRET } })],
    });
    const { server, adminClient } = createTestEnvironment(config);

    // Hash helpers mirroring the McpOauthService: the `lookup:`-prefixed hash is what's
    // stored in the token column; the unprefixed hash is the minted session's token.
    const hashKey = deriveHashKey(TOKEN_SECRET);
    const lookupHash = (value: string) => hashToken(`lookup:${value}`, hashKey);

    let superAdminToken: string;

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products.csv'),
            customerCount: 1,
        });
        // Logging in as superadmin yields the Vendure bearer token the admin-consent
        // step needs; it stands in for an authenticated administrator.
        await adminClient.asSuperAdmin();
        superAdminToken = adminClient.getAuthToken();
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    const baseUrl = () => `http://localhost:${config.apiOptions.port}`;

    /** Runs the full admin authorization-code flow and returns the resulting tokens. */
    const runFlow = () =>
        runAuthorizationCodeFlow({
            baseUrl: baseUrl(),
            issuer: ISSUER,
            superAdminToken,
        });

    // T7 — the full DCR -> authorize -> consent -> token-exchange flow yields a usable token pair.
    it('issues a non-empty access + refresh token pair through the full flow', async () => {
        const result = await runFlow();
        expect(result.access_token).toBeTruthy();
        expect(result.refresh_token).toBeTruthy();
    });

    it('authenticates the issued access token and binds the granting user', async () => {
        const oauth = server.app.get(McpOauthService);
        const connection = server.app.get(TransactionalConnection);
        const requestContextService = server.app.get(RequestContextService);
        const ctx = await requestContextService.create({ apiType: 'admin' });

        const { access_token } = await runFlow();
        const authenticated = await oauth.authenticateBearerToken(access_token, 'admin');

        // The resolved context and stored token both bind to the superadmin who approved consent.
        const superadmin = await connection
            .getRepository(ctx, User)
            .findOne({ where: { identifier: 'superadmin' } });
        if (!superadmin) {
            throw new Error('Expected a seeded superadmin user');
        }
        expect(authenticated.ctx.activeUserId).toBe(superadmin.id);
        expect(authenticated.grant.userId).toBe(superadmin.id);
    });

    it('stores the access token hashed, never in plaintext', async () => {
        const connection = server.app.get(TransactionalConnection);
        const requestContextService = server.app.get(RequestContextService);
        const ctx = await requestContextService.create({ apiType: 'admin' });

        const { access_token } = await runFlow();

        // The stored grant row is keyed by the lookup hash, not the plaintext.
        const stored = await connection
            .getRepository(ctx, McpOauthGrant)
            .findOne({ where: { accessTokenHash: lookupHash(access_token) } });
        expect(stored).toBeTruthy();

        // The plaintext token must never appear in the token column.
        const plaintextRow = await connection
            .getRepository(ctx, McpOauthGrant)
            .findOne({ where: { accessTokenHash: access_token } });
        expect(plaintextRow).toBeNull();
    });

    it('rotates the refresh token and rejects a replay of the original', async () => {
        const oauth = server.app.get(McpOauthService);
        const first = await runFlow();

        const rotated = await oauth.exchangeToken({
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: first.client_id,
            resource: first.resource,
        });
        expect(rotated.access_token).toBeTruthy();
        expect(rotated.access_token).not.toBe(first.access_token);

        // Replaying the now-rotated original refresh token is rejected.
        await expect(
            oauth.exchangeToken({
                grant_type: 'refresh_token',
                refresh_token: first.refresh_token,
                client_id: first.client_id,
                resource: first.resource,
            }),
        ).rejects.toThrow(/invalid or expired/i);
    });

    it('rejects re-exchange of an already-used authorization code', async () => {
        const oauth = server.app.get(McpOauthService);
        // The flow has already exchanged this code once; a sequential replay must fail.
        const { code, client_id, redirect_uri, code_verifier, resource } = await runFlow();

        await expect(
            oauth.exchangeToken({
                grant_type: 'authorization_code',
                code,
                client_id,
                redirect_uri,
                code_verifier,
                resource,
            }),
        ).rejects.toThrow(/invalid or expired/i);
    });

    // T7 regression — when the minted Vendure session lapses, re-authenticating the same
    // access token must re-mint a fresh session rather than fail.
    it('re-mints the dedicated Vendure session after it lapses', async () => {
        const oauth = server.app.get(McpOauthService);
        const connection = server.app.get(TransactionalConnection);
        const configService = server.app.get(ConfigService);
        const requestContextService = server.app.get(RequestContextService);
        const ctx = await requestContextService.create({ apiType: 'admin' });

        const { access_token } = await runFlow();

        // Find the grant row backing this access token, and note which Vendure
        // session currently backs it.
        const mcpSessionBefore = await connection
            .getRepository(ctx, McpOauthGrant)
            .findOne({ where: { accessTokenHash: lookupHash(access_token) } });
        if (!mcpSessionBefore) {
            throw new Error('Expected a minted McpOauthGrant for the access token');
        }
        const sessionIdBefore = mcpSessionBefore.vendureSessionId;

        // Simulate the Vendure session lapsing. Its token is the unprefixed hash of the
        // access-token plaintext. Expire the DB row and clear the cache entry so the next
        // lookup misses (Vendure clears expired sessions lazily, not on read), forcing the
        // re-mint path.
        const sessionToken = hashToken(access_token, hashKey);
        const vendureSession = await connection
            .getRepository(ctx, Session)
            .findOne({ where: { id: sessionIdBefore } });
        if (!vendureSession) {
            throw new Error('Expected the minted Vendure session to exist');
        }
        vendureSession.expires = new Date(Date.now() - 60 * 1000);
        await connection.getRepository(ctx, Session).save(vendureSession);
        await configService.authOptions.sessionCacheStrategy.delete(sessionToken);

        // Re-authenticating succeeds by re-minting a new session, and the McpOauthGrant now
        // points at a different Vendure session id.
        const reauthenticated = await oauth.authenticateBearerToken(access_token, 'admin');
        expect(reauthenticated.ctx.activeUserId).toBe(mcpSessionBefore.userId);

        const mcpSessionAfter = await connection
            .getRepository(ctx, McpOauthGrant)
            .findOne({ where: { accessTokenHash: lookupHash(access_token) } });
        if (!mcpSessionAfter) {
            throw new Error('Expected the McpOauthGrant to persist after re-mint');
        }
        expect(mcpSessionAfter.vendureSessionId).not.toBe(sessionIdBefore);
    });
});
