import { mergeConfig, RequestContextService, TransactionalConnection, User } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import crypto from 'crypto';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { McpAuthorizationCode } from '../src/entities/mcp-authorization-code.entity';
import { McpOauthClient } from '../src/entities/mcp-oauth-client.entity';
import { McpOauthToken } from '../src/entities/mcp-oauth-token.entity';
import { McpSession } from '../src/entities/mcp-session.entity';
import { deriveHashKey, hashToken } from '../src/oauth/crypto';
import { OAuthService } from '../src/oauth/oauth.service';
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
        const oauth = server.app.get(OAuthService);
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

    // T12 — refresh-token rotation must be atomic and self-cleaning: rotating revokes the
    // refresh token, hard-deletes the prior access token and its minted McpSession, and a
    // replay of the original refresh token is rejected.
    it('rotates a refresh token atomically and cleans up the prior grant', async () => {
        const connection = server.app.get(TransactionalConnection);
        const requestContextService = server.app.get(RequestContextService);
        const oauth = server.app.get(OAuthService);
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
        // minted McpSession exist before we rotate.
        const first = await oauth.exchangeToken({
            grant_type: 'authorization_code',
            code: CODE_PLAINTEXT,
            client_id: 'rotation-client',
            redirect_uri: 'https://example.com/cb',
            code_verifier: verifier,
            resource: RESOURCE,
        });

        const priorAccess = await connection.getRepository(ctx, McpOauthToken).findOne({
            where: { token: lookupHash(first.access_token), tokenType: 'access' },
        });
        if (!priorAccess) {
            throw new Error('Expected the issued access token to be persisted');
        }
        const priorAccessId = priorAccess.id;
        const priorSession = await connection
            .getRepository(ctx, McpSession)
            .findOne({ where: { oauthTokenId: priorAccessId } });
        expect(priorSession).toBeTruthy();

        const second = await oauth.exchangeToken({
            grant_type: 'refresh_token',
            refresh_token: first.refresh_token,
            client_id: 'rotation-client',
            resource: RESOURCE,
        });
        expect(second.access_token).not.toBe(first.access_token);

        // The original refresh token row is now revoked.
        const rotatedRefresh = await connection.getRepository(ctx, McpOauthToken).findOne({
            where: { token: lookupHash(first.refresh_token), tokenType: 'refresh' },
        });
        if (!rotatedRefresh) {
            throw new Error('Expected the original refresh token row to still exist');
        }
        expect(rotatedRefresh.revokedAt).toBeTruthy();

        // The prior access token is hard-deleted, and its minted McpSession is gone with it.
        const goneAccess = await connection
            .getRepository(ctx, McpOauthToken)
            .findOne({ where: { id: priorAccessId } });
        expect(goneAccess).toBeNull();
        const goneSession = await connection
            .getRepository(ctx, McpSession)
            .findOne({ where: { oauthTokenId: priorAccessId } });
        expect(goneSession).toBeNull();

        // Replaying the original refresh token is rejected.
        await expect(
            oauth.exchangeToken({
                grant_type: 'refresh_token',
                refresh_token: first.refresh_token,
                client_id: 'rotation-client',
                resource: RESOURCE,
            }),
        ).rejects.toThrow('Refresh token invalid or expired');
    });
});
