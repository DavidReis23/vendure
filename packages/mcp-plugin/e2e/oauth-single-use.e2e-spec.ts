import { mergeConfig, RequestContextService, Session, TransactionalConnection, User } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import crypto from 'crypto';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { McpAuthorizationCode } from '../src/entities/mcp-authorization-code.entity';
import { McpOauthClient } from '../src/entities/mcp-oauth-client.entity';
import { McpOauthGrant } from '../src/entities/mcp-oauth-grant.entity';
import { McpOauthService } from '../src/oauth/oauth.service';
import { deriveHashKey, hashToken } from '../src/oauth/token-hash';
import { McpPlugin } from '../src/plugin';

const TOKEN_SECRET = 'test-secret';
const RESOURCE = 'http://localhost:3500/mcp/admin';

describe('McpPlugin OAuth single-use code', () => {
    const config = mergeConfig(testConfig(), {
        plugins: [McpPlugin.init({ oauth: { tokenSecret: TOKEN_SECRET } })],
    });
    const { server } = createTestEnvironment(config);

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products.csv'),
            customerCount: 1,
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    // T11 — two concurrent exchanges of the same authorization code must yield
    // exactly one success and one failure (the atomic claim makes the code single-use).
    it('exchanges the same authorization code concurrently with exactly one winner', async () => {
        const connection = server.app.get(TransactionalConnection);
        const requestContextService = server.app.get(RequestContextService);
        const oauth = server.app.get(McpOauthService);
        const ctx = await requestContextService.create({ apiType: 'admin' });

        const superadmin = await connection
            .getRepository(ctx, User)
            .findOne({ where: { identifier: 'superadmin' } });
        if (!superadmin) {
            throw new Error('Expected a seeded superadmin user');
        }

        const client = await connection.getRepository(ctx, McpOauthClient).save(
            new McpOauthClient({
                clientId: 'test-client',
                clientName: 'Test Client',
                clientUri: null,
                logoUri: null,
                redirectUris: ['https://example.com/cb'],
                grantTypes: ['authorization_code', 'refresh_token'],
                tokenEndpointAuthMethod: 'none',
                lastUsedAt: null,
            }),
        );

        const CODE_PLAINTEXT = 'single-use-code';
        const verifier = 'a'.repeat(64);
        const codeChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const storedCodeHash = hashToken(`lookup:${CODE_PLAINTEXT}`, deriveHashKey(TOKEN_SECRET));

        await connection.getRepository(ctx, McpAuthorizationCode).save(
            new McpAuthorizationCode({
                code: storedCodeHash,
                oauthClient: client,
                oauthClientId: client.id,
                userId: superadmin.id,
                userType: 'admin',
                redirectUri: 'https://example.com/cb',
                resource: RESOURCE,
                codeChallenge,
                codeChallengeMethod: 'S256',
                channelId: null,
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
                consumedAt: null,
            }),
        );

        const input = {
            grant_type: 'authorization_code',
            code: CODE_PLAINTEXT,
            client_id: 'test-client',
            redirect_uri: 'https://example.com/cb',
            code_verifier: verifier,
            resource: RESOURCE,
        } as const;

        const [a, b] = await Promise.allSettled([
            oauth.exchangeToken({ ...input }),
            oauth.exchangeToken({ ...input }),
        ]);

        const fulfilled = [a, b].filter(r => r.status === 'fulfilled');
        const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason.message).toBe('Authorization code invalid or expired');
    });

    // T12 — refresh-token rotation must be atomic and in place: the same grant row swaps
    // to the new token hashes, remembers the rotated-away refresh hash, and a replay of
    // the original refresh token is rejected.
    it('rotates a refresh token atomically in place on the same grant row', async () => {
        const connection = server.app.get(TransactionalConnection);
        const requestContextService = server.app.get(RequestContextService);
        const oauth = server.app.get(McpOauthService);
        const ctx = await requestContextService.create({ apiType: 'admin' });
        const hashKey = deriveHashKey(TOKEN_SECRET);
        const lookupHash = (value: string) => hashToken(`lookup:${value}`, hashKey);

        const superadmin = await connection
            .getRepository(ctx, User)
            .findOne({ where: { identifier: 'superadmin' } });
        if (!superadmin) {
            throw new Error('Expected a seeded superadmin user');
        }

        const client = await connection.getRepository(ctx, McpOauthClient).save(
            new McpOauthClient({
                clientId: 'rotation-client',
                clientName: 'Rotation Client',
                clientUri: null,
                logoUri: null,
                redirectUris: ['https://example.com/cb'],
                grantTypes: ['authorization_code', 'refresh_token'],
                tokenEndpointAuthMethod: 'none',
                lastUsedAt: null,
            }),
        );

        const CODE_PLAINTEXT = 'rotation-code';
        const verifier = 'b'.repeat(64);
        const codeChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');

        await connection.getRepository(ctx, McpAuthorizationCode).save(
            new McpAuthorizationCode({
                code: lookupHash(CODE_PLAINTEXT),
                oauthClient: client,
                oauthClientId: client.id,
                userId: superadmin.id,
                userType: 'admin',
                redirectUri: 'https://example.com/cb',
                resource: RESOURCE,
                codeChallenge,
                codeChallengeMethod: 'S256',
                channelId: null,
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
                consumedAt: null,
            }),
        );

        // Exercise the real authorization-code grant so a genuine access+refresh pair and a
        // minted McpOauthGrant exist before we rotate.
        const first = await oauth.exchangeToken({
            grant_type: 'authorization_code',
            code: CODE_PLAINTEXT,
            client_id: 'rotation-client',
            redirect_uri: 'https://example.com/cb',
            code_verifier: verifier,
            resource: RESOURCE,
        });

        const priorGrant = await connection.getRepository(ctx, McpOauthGrant).findOne({
            where: { accessTokenHash: lookupHash(first.access_token) },
        });
        if (!priorGrant) {
            throw new Error('Expected the issued grant to be persisted');
        }
        const grantId = priorGrant.id;
        const priorVendureSessionId = priorGrant.vendureSessionId;

        const second = await oauth.exchangeToken({
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: 'rotation-client',
            resource: RESOURCE,
        });
        expect(second.access_token).not.toBe(first.access_token);

        // Rotation happened in place: the same grant row carries the new hashes and
        // remembers the rotated-away refresh hash for reuse detection.
        const rotatedGrant = await connection.getRepository(ctx, McpOauthGrant).findOne({
            where: { accessTokenHash: lookupHash(second.access_token) },
        });
        if (!rotatedGrant) {
            throw new Error('Expected the rotated grant row to exist');
        }
        expect(rotatedGrant.id).toBe(grantId);
        expect(rotatedGrant.refreshTokenHash).toBe(lookupHash(second.refresh_token));
        expect(rotatedGrant.previousRefreshTokenHash).toBe(lookupHash(first.refresh_token));
        expect(rotatedGrant.revokedAt).toBeNull();

        // The prior access token no longer resolves, and the minted Vendure session
        // was re-keyed to the new access token.
        const staleAccess = await connection.getRepository(ctx, McpOauthGrant).findOne({
            where: { accessTokenHash: lookupHash(first.access_token) },
        });
        expect(staleAccess).toBeNull();
        expect(rotatedGrant.vendureSessionId).not.toBe(priorVendureSessionId);

        // Replaying the original refresh token is rejected (and, per OAuth 2.1 reuse
        // detection, revokes the grant — covered by the dedicated test below).
        await expect(
            oauth.exchangeToken({
                grant_type: 'refresh_token',
                refresh_token: first.refresh_token,
                client_id: 'rotation-client',
                resource: RESOURCE,
            }),
        ).rejects.toThrow('Refresh token invalid or expired');
    });

    // OAuth 2.1 refresh-token reuse detection — a rotated-away refresh token presented
    // again means it leaked, so the whole grant is revoked, killing the new tokens too.
    it('revokes the whole grant when a rotated refresh token is reused', async () => {
        const connection = server.app.get(TransactionalConnection);
        const requestContextService = server.app.get(RequestContextService);
        const oauth = server.app.get(McpOauthService);
        const ctx = await requestContextService.create({ apiType: 'admin' });
        const hashKey = deriveHashKey(TOKEN_SECRET);
        const lookupHash = (value: string) => hashToken(`lookup:${value}`, hashKey);

        const superadmin = await connection
            .getRepository(ctx, User)
            .findOne({ where: { identifier: 'superadmin' } });
        if (!superadmin) {
            throw new Error('Expected a seeded superadmin user');
        }

        const client = await connection.getRepository(ctx, McpOauthClient).save(
            new McpOauthClient({
                clientId: 'reuse-client',
                clientName: 'Reuse Client',
                clientUri: null,
                logoUri: null,
                redirectUris: ['https://example.com/cb'],
                grantTypes: ['authorization_code', 'refresh_token'],
                tokenEndpointAuthMethod: 'none',
                lastUsedAt: null,
            }),
        );

        const CODE_PLAINTEXT = 'reuse-code';
        const verifier = 'c'.repeat(64);
        const codeChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');

        await connection.getRepository(ctx, McpAuthorizationCode).save(
            new McpAuthorizationCode({
                code: lookupHash(CODE_PLAINTEXT),
                oauthClient: client,
                oauthClientId: client.id,
                userId: superadmin.id,
                userType: 'admin',
                redirectUri: 'https://example.com/cb',
                resource: RESOURCE,
                codeChallenge,
                codeChallengeMethod: 'S256',
                channelId: null,
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
                consumedAt: null,
            }),
        );

        const first = await oauth.exchangeToken({
            grant_type: 'authorization_code',
            code: CODE_PLAINTEXT,
            client_id: 'reuse-client',
            redirect_uri: 'https://example.com/cb',
            code_verifier: verifier,
            resource: RESOURCE,
        });
        const second = await oauth.exchangeToken({
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: 'reuse-client',
            resource: RESOURCE,
        });

        // Reusing the rotated-away refresh token is rejected...
        await expect(
            oauth.exchangeToken({
                grant_type: 'refresh_token',
                refresh_token: first.refresh_token,
                client_id: 'reuse-client',
                resource: RESOURCE,
            }),
        ).rejects.toThrow('Refresh token invalid or expired');

        // ...and revokes the whole grant: the row is marked revoked and its minted
        // Vendure session is deleted.
        const grant = await connection.getRepository(ctx, McpOauthGrant).findOne({
            where: { accessTokenHash: lookupHash(second.access_token) },
        });
        if (!grant) {
            throw new Error('Expected the grant row to survive revocation');
        }
        expect(grant.revokedAt).toBeTruthy();
        const mintedSession = await connection
            .getRepository(ctx, Session)
            .findOne({ where: { id: grant.vendureSessionId } });
        expect(mintedSession).toBeNull();

        // The rotated-to tokens are dead as well.
        await expect(oauth.authenticateBearerToken(second.access_token, 'admin')).rejects.toThrow(
            /invalid or expired/i,
        );
        await expect(
            oauth.exchangeToken({
                grant_type: 'refresh_token',
                refresh_token: second.refresh_token,
                client_id: 'reuse-client',
                resource: RESOURCE,
            }),
        ).rejects.toThrow('Refresh token invalid or expired');
    });
});
