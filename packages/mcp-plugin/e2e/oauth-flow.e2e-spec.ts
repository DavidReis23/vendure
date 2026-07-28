import { ModuleRef } from '@nestjs/core';
import {
    ConfigService,
    Injector,
    mergeConfig,
    RequestContext,
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
import { MS_PER_DAY } from '../src/constants';
import { McpAuthorizationCode } from '../src/entities/mcp-authorization-code.entity';
import { McpAuthorizationRequest } from '../src/entities/mcp-authorization-request.entity';
import { McpOauthGrant } from '../src/entities/mcp-oauth-grant.entity';
import { McpOauthRetentionResult, McpOauthService } from '../src/oauth/oauth.service';
import { deriveHashKey, hashToken } from '../src/oauth/token-hash';
import { McpPlugin } from '../src/plugin';
import { mcpOauthRetentionTask } from '../src/tasks/mcp-oauth-retention.task';

import { runAuthorizationCodeFlow } from './utils/oauth-test-client';

const TOKEN_SECRET = 'test-secret';
// The plugin's default issuer (see src/constants.ts), from which the resource is derived.
const ISSUER = 'http://localhost:3500';

describe('McpPlugin OAuth end-to-end flow', () => {
    const config = mergeConfig(testConfig(), {
        // A deliberately short log retention: how long dead grants are kept is governed by
        // `oauth.grantRetentionDays`, not by how long tool-call logs are kept.
        plugins: [McpPlugin.init({ oauth: { tokenSecret: TOKEN_SECRET }, logging: { ttlDays: 1 } })],
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

    /** The grant row backing an access token the flow issued. */
    const grantFor = async (ctx: RequestContext, accessToken: string): Promise<McpOauthGrant> => {
        const grant = await server.app
            .get(TransactionalConnection)
            .getRepository(ctx, McpOauthGrant)
            .findOne({ where: { accessTokenHash: lookupHash(accessToken) } });
        if (!grant) {
            throw new Error('Expected a minted McpOauthGrant for the access token');
        }
        return grant;
    };

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

    it('deletes the Vendure session behind a grant that has passed its expiry', async () => {
        const oauth = server.app.get(McpOauthService);
        const connection = server.app.get(TransactionalConnection);
        const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });

        const { access_token } = await runFlow();
        const grantRepo = connection.getRepository(ctx, McpOauthGrant);
        const grant = await grantRepo.findOne({ where: { accessTokenHash: lookupHash(access_token) } });
        if (!grant) {
            throw new Error('Expected a minted McpOauthGrant for the access token');
        }
        const sessionRepo = connection.getRepository(ctx, Session);
        expect(await sessionRepo.findOne({ where: { id: grant.vendureSessionId } })).toBeTruthy();

        await grantRepo.update({ id: grant.id }, { expiresAt: new Date(Date.now() - MS_PER_DAY) });

        await oauth.deleteExpiredOauthRecords(ctx);

        expect(await sessionRepo.findOne({ where: { id: grant.vendureSessionId } })).toBeNull();
        // Only sessions an expired grant points at are in scope — the administrator's own
        // session is not referenced by any grant and must survive.
        expect(await sessionRepo.findOne({ where: { token: superAdminToken } })).toBeTruthy();
    });

    // A completed flow leaves one consumed request and one consumed code behind. Both are spent
    // protocol ephemera, and nothing ever removed them.
    it('deletes the authorization request and code a completed flow consumed', async () => {
        const oauth = server.app.get(McpOauthService);
        const connection = server.app.get(TransactionalConnection);
        const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });

        // Drain what the earlier tests' flows left behind, so the counts below are exact.
        await oauth.deleteExpiredOauthRecords(ctx);

        const { request_token, code } = await runFlow();
        const requestRepo = connection.getRepository(ctx, McpAuthorizationRequest);
        const codeRepo = connection.getRepository(ctx, McpAuthorizationCode);
        const findRequest = () => requestRepo.findOne({ where: { requestToken: lookupHash(request_token) } });
        const findCode = () => codeRepo.findOne({ where: { code: lookupHash(code) } });
        expect(await findRequest()).toBeTruthy();
        expect(await findCode()).toBeTruthy();

        const result = await oauth.deleteExpiredOauthRecords(ctx);

        expect(await findRequest()).toBeNull();
        expect(await findCode()).toBeNull();
        // The grant this flow minted is still live, so neither it nor its session is touched.
        expect(result).toEqual({
            deletedSessions: 0,
            deletedRequests: 1,
            deletedCodes: 1,
            deletedGrants: 0,
        });
    });

    // The grant row is the only OAuth record carrying audit value, so it outlives its own expiry
    // and goes only once every tool-call log that could reference it has itself been pruned —
    // i.e. once it has been dead longer than `logging.ttlDays` (30 by default here).
    it('keeps a recently-dead grant and deletes one dead longer than the retention window', async () => {
        const oauth = server.app.get(McpOauthService);
        const connection = server.app.get(TransactionalConnection);
        const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
        const grantRepo = connection.getRepository(ctx, McpOauthGrant);

        const recent = await grantFor(ctx, (await runFlow()).access_token);
        const longDead = await grantFor(ctx, (await runFlow()).access_token);
        await grantRepo.update({ id: recent.id }, { expiresAt: new Date(Date.now() - 2 * MS_PER_DAY) });
        await grantRepo.update({ id: longDead.id }, { expiresAt: new Date(Date.now() - 31 * MS_PER_DAY) });

        const result = await oauth.deleteExpiredOauthRecords(ctx);

        expect(await grantRepo.findOne({ where: { id: recent.id } })).toBeTruthy();
        expect(await grantRepo.findOne({ where: { id: longDead.id } })).toBeNull();
        expect(result.deletedGrants).toBe(1);
        // Both grants were past expiry, so both minted sessions go regardless of the window.
        expect(result.deletedSessions).toBe(2);
    });

    // The scheduled task is the only production caller, so prove the wiring end to end.
    it('prunes when driven through the scheduled task', async () => {
        const connection = server.app.get(TransactionalConnection);
        const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
        const grantRepo = connection.getRepository(ctx, McpOauthGrant);

        const grant = await grantFor(ctx, (await runFlow()).access_token);
        await grantRepo.update({ id: grant.id }, { expiresAt: new Date(Date.now() - MS_PER_DAY) });

        const injector = new Injector(server.app.get(ModuleRef));
        const result = (await mcpOauthRetentionTask.execute(injector)) as McpOauthRetentionResult;

        expect(result.deletedSessions).toBe(1);
        expect(
            await connection.getRepository(ctx, Session).findOne({ where: { id: grant.vendureSessionId } }),
        ).toBeNull();
    });

    it('deletes a grant revoked longer ago than the retention window', async () => {
        const oauth = server.app.get(McpOauthService);
        const connection = server.app.get(TransactionalConnection);
        const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
        const grantRepo = connection.getRepository(ctx, McpOauthGrant);

        const grant = await grantFor(ctx, (await runFlow()).access_token);
        // Revocation already removed the session; only the row's own retention is at stake here.
        await grantRepo.update({ id: grant.id }, { revokedAt: new Date(Date.now() - 31 * MS_PER_DAY) });

        await oauth.deleteExpiredOauthRecords(ctx);

        expect(await grantRepo.findOne({ where: { id: grant.id } })).toBeNull();
    });
});
