import {
    Channel,
    mergeConfig,
    Permission,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import crypto from 'crypto';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { mcpServerPermission } from '../src/constants';
import { McpAuthorizationCode } from '../src/entities/mcp-authorization-code.entity';
import { McpOauthGrant } from '../src/entities/mcp-oauth-grant.entity';
import { McpOauthService } from '../src/oauth/oauth.service';
import { deriveHashKey, hashToken } from '../src/oauth/token-hash';
import { McpPlugin } from '../src/plugin';

import { runAuthorizationCodeFlow, runShopAuthorizationCodeFlow } from './utils/oauth-test-client';

const TOKEN_SECRET = 'test-secret';
// The plugin's default issuer (see src/constants.ts), from which the resource is derived.
const ISSUER = 'http://localhost:3500';

describe('McpPlugin OAuth edge & security cases', () => {
    const config = mergeConfig(testConfig(), {
        plugins: [McpPlugin.init({ oauth: { tokenSecret: TOKEN_SECRET } })],
    });
    const { server, adminClient, shopClient } = createTestEnvironment(config);

    // Mirrors McpOauthService.hashLookup: the value stored in a token/code column is the
    // keyed HMAC of `lookup:<plaintext>`. Used to find rows for DB-level tampering.
    const hashKey = deriveHashKey(TOKEN_SECRET);
    const lookupHash = (value: string) => hashToken(`lookup:${value}`, hashKey);

    let superAdminToken: string;
    let customerAuthToken: string;

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products.csv'),
            customerCount: 1,
        });
        // Superadmin bearer approves admin consent; it stands in for an authenticated admin.
        await adminClient.asSuperAdmin();
        superAdminToken = adminClient.getAuthToken();

        // Log in a real seeded customer on the shop client to obtain a customer session
        // token. The storefront consent step approves the grant with this token.
        const { customers } = await adminClient.query<{
            customers: { items: Array<{ emailAddress: string }> };
        }>(gql`
            query {
                customers(options: { take: 1 }) {
                    items {
                        emailAddress
                    }
                }
            }
        `);
        const customerEmail = customers.items[0]?.emailAddress;
        if (!customerEmail) {
            throw new Error('Expected at least one seeded customer');
        }
        const login = await shopClient.asUserWithCredentials(customerEmail, 'test');
        if (!login || login.errorCode) {
            throw new Error(`Customer login failed: ${JSON.stringify(login)}`);
        }
        customerAuthToken = shopClient.getAuthToken();
        if (!customerAuthToken) {
            throw new Error('Customer login did not yield a session token');
        }
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    const baseUrl = () => `http://localhost:${config.apiOptions.port}`;

    /** Runs the full admin authorization-code flow and returns the resulting values. */
    const runAdminFlow = (redirectUri?: string) =>
        runAuthorizationCodeFlow({ baseUrl: baseUrl(), issuer: ISSUER, superAdminToken, redirectUri });

    /** Runs the full shop authorization-code flow with the real customer session token. */
    const runShopFlow = () =>
        runShopAuthorizationCodeFlow({
            baseUrl: baseUrl(),
            issuer: ISSUER,
            vendureAuthToken: customerAuthToken,
        });

    // Drives DCR + authorize + admin-consent and stops at the freshly minted code, so a
    // test can craft its own token-exchange request. The code has not yet been consumed.
    const authorizeAdminToCode = async (overrides?: { redirectUri?: string; resource?: string }) => {
        const redirectUri = overrides?.redirectUri ?? 'https://example.com/cb';
        const code_verifier = 'a'.repeat(64);
        const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
        const resource = overrides?.resource ?? `${ISSUER}/mcp/admin`;

        const registerRes = await fetch(`${baseUrl()}/mcp/oauth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                client_name: `edge-${Math.random().toString(36).slice(2)}`,
                redirect_uris: [redirectUri],
            }),
        });
        const { client_id } = (await registerRes.json()) as { client_id: string };

        const authorizeUrl = new URL(`${baseUrl()}/mcp/oauth/authorize`);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', client_id);
        authorizeUrl.searchParams.set('redirect_uri', redirectUri);
        authorizeUrl.searchParams.set('code_challenge', code_challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        authorizeUrl.searchParams.set('resource', resource);
        const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
        const consentLocation = authorizeRes.headers.get('location');
        if (!consentLocation) {
            throw new Error(`Authorize did not redirect (status ${authorizeRes.status})`);
        }
        const request_token = new URL(consentLocation).searchParams.get('session');
        if (!request_token) {
            throw new Error(`Consent redirect missing session: ${consentLocation}`);
        }

        const consentRes = await fetch(`${baseUrl()}/mcp/oauth/admin-consent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', Authorization: `Bearer ${superAdminToken}` },
            body: JSON.stringify({ session: request_token, approved: true }),
        });
        const { redirectUrl } = (await consentRes.json()) as { redirectUrl: string };
        const code = new URL(redirectUrl).searchParams.get('code');
        if (!code) {
            throw new Error(`Consent redirect missing code: ${redirectUrl}`);
        }

        return { client_id, redirect_uri: redirectUri, code, code_verifier, resource };
    };

    // --- Rejection gates at token exchange ---

    // Relates to OSS-575 — a token request with the wrong PKCE verifier is rejected.
    it('rejects token exchange with an invalid PKCE verifier', async () => {
        const oauth = server.app.get(McpOauthService);
        const flow = await authorizeAdminToCode();

        await expect(
            oauth.exchangeToken({
                grant_type: 'authorization_code',
                code: flow.code,
                client_id: flow.client_id,
                redirect_uri: flow.redirect_uri,
                code_verifier: 'b'.repeat(64), // wrong verifier
                resource: flow.resource,
            }),
        ).rejects.toThrow(/PKCE/i);
    });

    // Relates to OSS-575 — a token request whose client_id differs from the code's is rejected.
    it('rejects token exchange with a client_id that does not match the code', async () => {
        const oauth = server.app.get(McpOauthService);
        const flow = await authorizeAdminToCode();

        await expect(
            oauth.exchangeToken({
                grant_type: 'authorization_code',
                code: flow.code,
                client_id: 'some-other-client',
                redirect_uri: flow.redirect_uri,
                code_verifier: flow.code_verifier,
                resource: flow.resource,
            }),
        ).rejects.toThrow(/does not match client/i);
    });

    // Relates to OSS-575 — a redirect_uri not registered for the client is rejected at authorize.
    it('rejects authorize when redirect_uri is not registered for the client', async () => {
        const redirectUri = 'https://example.com/registered';
        const registerRes = await fetch(`${baseUrl()}/mcp/oauth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                client_name: `unregistered-redirect-${Math.random().toString(36).slice(2)}`,
                redirect_uris: [redirectUri],
            }),
        });
        const { client_id } = (await registerRes.json()) as { client_id: string };

        const code_verifier = 'a'.repeat(64);
        const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
        const authorizeUrl = new URL(`${baseUrl()}/mcp/oauth/authorize`);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', client_id);
        // A redirect_uri the client never registered.
        authorizeUrl.searchParams.set('redirect_uri', 'https://evil.example.com/cb');
        authorizeUrl.searchParams.set('code_challenge', code_challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        authorizeUrl.searchParams.set('resource', `${ISSUER}/mcp/admin`);

        const res = await fetch(authorizeUrl, { redirect: 'manual' });
        expect(res.status).toBe(400);
        expect(await res.text()).toMatch(/redirect_uri is not registered/i);
    });

    // Relates to OSS-575 — a token request whose redirect_uri differs from the code's is rejected.
    it('rejects token exchange when redirect_uri does not match the authorization code', async () => {
        const oauth = server.app.get(McpOauthService);
        // The code is bound to this redirect_uri at authorize time.
        const flow = await authorizeAdminToCode({ redirectUri: 'https://example.com/code-uri' });

        await expect(
            oauth.exchangeToken({
                grant_type: 'authorization_code',
                code: flow.code,
                client_id: flow.client_id,
                redirect_uri: 'https://example.com/different-uri', // not the redirect_uri the code carries
                code_verifier: flow.code_verifier,
                resource: flow.resource,
            }),
        ).rejects.toThrow(/does not match client or redirect_uri/i);
    });

    // Relates to OSS-575 — authorize without a `resource` parameter is rejected.
    it('rejects authorize when the resource parameter is missing', async () => {
        const redirectUri = 'https://example.com/cb';
        const registerRes = await fetch(`${baseUrl()}/mcp/oauth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                client_name: `no-resource-${Math.random().toString(36).slice(2)}`,
                redirect_uris: [redirectUri],
            }),
        });
        const { client_id } = (await registerRes.json()) as { client_id: string };

        const code_verifier = 'a'.repeat(64);
        const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
        const authorizeUrl = new URL(`${baseUrl()}/mcp/oauth/authorize`);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', client_id);
        authorizeUrl.searchParams.set('redirect_uri', redirectUri);
        authorizeUrl.searchParams.set('code_challenge', code_challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        // Deliberately omit the `resource` parameter.

        const res = await fetch(authorizeUrl, { redirect: 'manual' });
        expect(res.status).toBe(400);
        expect(await res.text()).toMatch(/resource is required/i);
    });

    // Relates to OSS-575 — a token request without a `resource` is rejected.
    it('rejects token exchange when the resource is missing', async () => {
        const oauth = server.app.get(McpOauthService);
        const flow = await authorizeAdminToCode();

        await expect(
            oauth.exchangeToken({
                grant_type: 'authorization_code',
                code: flow.code,
                client_id: flow.client_id,
                redirect_uri: flow.redirect_uri,
                code_verifier: flow.code_verifier,
                resource: undefined,
            }),
        ).rejects.toThrow(/resource (is|are) required|are required/i);
    });

    // Relates to OSS-575 — a token request whose resource differs from the code's is rejected.
    it('rejects token exchange when the requested resource does not match the code', async () => {
        const oauth = server.app.get(McpOauthService);
        const flow = await authorizeAdminToCode(); // code bound to the admin resource

        await expect(
            oauth.exchangeToken({
                grant_type: 'authorization_code',
                code: flow.code,
                client_id: flow.client_id,
                redirect_uri: flow.redirect_uri,
                code_verifier: flow.code_verifier,
                resource: `${ISSUER}/mcp/shop`, // valid, but not the code's resource
            }),
        ).rejects.toThrow(/does not match token request resource/i);
    });

    // Relates to OSS-575 — a refresh request whose resource differs from the token's is rejected.
    it('rejects a refresh-token exchange when the resource does not match', async () => {
        const oauth = server.app.get(McpOauthService);
        const flow = await runAdminFlow(); // admin tokens, resource = ${ISSUER}/mcp/admin

        await expect(
            oauth.exchangeToken({
                grant_type: 'refresh_token',
                refresh_token: flow.refresh_token,
                client_id: flow.client_id,
                resource: `${ISSUER}/mcp/shop`, // valid, but not the token's resource
            }),
        ).rejects.toThrow(/does not match token request resource/i);
    });

    // Relates to OSS-575 — an authorization code past its expiry is rejected on exchange.
    it('rejects an expired authorization code', async () => {
        const oauth = server.app.get(McpOauthService);
        const connection = server.app.get(TransactionalConnection);
        const requestContextService = server.app.get(RequestContextService);
        const ctx = await requestContextService.create({ apiType: 'admin' });

        const flow = await authorizeAdminToCode();

        // The stored code is the lookup-hash of the plaintext; expire it directly in the DB.
        const repo = connection.getRepository(ctx, McpAuthorizationCode);
        const stored = await repo.findOneOrFail({ where: { code: lookupHash(flow.code) } });
        stored.expiresAt = new Date(Date.now() - 1000);
        await repo.save(stored);

        await expect(
            oauth.exchangeToken({
                grant_type: 'authorization_code',
                code: flow.code,
                client_id: flow.client_id,
                redirect_uri: flow.redirect_uri,
                code_verifier: flow.code_verifier,
                resource: flow.resource,
            }),
        ).rejects.toThrow(/invalid or expired/i);
    });

    // --- Security checks ---

    // Relates to OSS-575 — revoke() is a soft-revoke: the grant row survives (so
    // McpToolCallLog audit links are preserved) with revokedAt set, and the token is
    // rejected at the resource afterwards.
    it('soft-revokes the grant: keeps the row with revokedAt set and rejects the token', async () => {
        const oauth = server.app.get(McpOauthService);
        const connection = server.app.get(TransactionalConnection);
        const requestContextService = server.app.get(RequestContextService);
        const ctx = await requestContextService.create({ apiType: 'admin' });
        const flow = await runAdminFlow();

        // Sanity: the token authenticates before revocation.
        const ok = await oauth.authenticateBearerToken(flow.access_token, 'admin');
        expect(ok.ctx.apiType).toBe('admin');

        await oauth.revoke(flow.access_token);

        // Soft revoke: the row is kept (not deleted) with revokedAt stamped.
        const grant = await connection
            .getRepository(ctx, McpOauthGrant)
            .findOne({ where: { accessTokenHash: lookupHash(flow.access_token) } });
        expect(grant).toBeTruthy();
        expect(grant?.revokedAt).toBeTruthy();

        await expect(oauth.authenticateBearerToken(flow.access_token, 'admin')).rejects.toThrow(
            /invalid or expired/i,
        );
    });

    // Relates to OSS-575 — a token whose stored resource has been tampered with is rejected
    // on the resource gate, even though the token itself is otherwise valid.
    it('rejects an access token whose stored resource has been tampered with', async () => {
        const oauth = server.app.get(McpOauthService);
        const connection = server.app.get(TransactionalConnection);
        const requestContextService = server.app.get(RequestContextService);
        const ctx = await requestContextService.create({ apiType: 'admin' });

        const flow = await runAdminFlow();

        // Mutate the persisted resource to a different (but well-formed) value.
        const repo = connection.getRepository(ctx, McpOauthGrant);
        const stored = await repo.findOneOrFail({
            where: { accessTokenHash: lookupHash(flow.access_token) },
        });
        stored.resource = `${ISSUER}/mcp/shop`;
        await repo.save(stored);

        await expect(oauth.authenticateBearerToken(flow.access_token, 'admin')).rejects.toThrow(
            /not issued for this MCP resource/i,
        );
    });

    // Relates to OSS-575 — admin consent without an authenticated admin session is rejected.
    it('rejects admin consent from an unauthenticated caller', async () => {
        const flow = await authorizeAdminToCodePreConsent();

        // No Authorization header: the request is anonymous, not an admin.
        const res = await fetch(`${baseUrl()}/mcp/oauth/admin-consent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: flow.request_token, approved: true }),
        });
        expect(res.status).toBe(401);
    });

    // Builds an admin RequestContext authenticated as if by a session cookie: a
    // session with a user, and NO Authorization header on the request, with a
    // caller-supplied Origin. This is exactly the shape the CSRF gate inspects.
    const buildCookieAuthedAdminCtx = ({
        origin,
        permissions = [mcpServerPermission.Update],
    }: {
        origin: string;
        permissions?: Permission[];
    }) =>
        new RequestContext({
            apiType: 'admin',
            channel: new Channel({ id: 1 }),
            session: {
                token: 'mcp-test-session',
                user: { id: 1, channelPermissions: [{ id: 1, permissions }] },
            } as any,
            req: { headers: { origin } } as any,
            isAuthorized: true,
            authorizedAsOwnerOnly: false,
        });

    it('rejects cookie-authenticated admin consent from a foreign origin', async () => {
        const oauth = server.app.get(McpOauthService);
        const flow = await authorizeAdminToCodePreConsent();
        const ctx = buildCookieAuthedAdminCtx({ origin: 'https://evil.example' });

        await expect(oauth.approveAdminRequest(ctx, flow.request_token, true)).rejects.toThrow(
            /consent page/i,
        );
    });

    // Relates to OSS-575 — the same cookie-authenticated consent from the issuer's own
    // origin (the real consent page) is allowed and mints an authorization code.
    it('allows cookie-authenticated admin consent from the consent page origin', async () => {
        const oauth = server.app.get(McpOauthService);
        const flow = await authorizeAdminToCodePreConsent();
        const ctx = buildCookieAuthedAdminCtx({ origin: ISSUER });

        const { redirectUrl } = await oauth.approveAdminRequest(ctx, flow.request_token, true);
        expect(new URL(redirectUrl).searchParams.get('code')).toBeTruthy();
    });

    // Relates to OSS-575 — "admin consent" must require an actual admin permission, not
    // merely an authenticated session. A signed-in principal without UpdateMcpServer (e.g.
    // a shop customer on the same origin) is rejected even from the correct consent origin.
    it('rejects cookie-authenticated consent from a caller lacking the McpServer permission', async () => {
        const oauth = server.app.get(McpOauthService);
        const flow = await authorizeAdminToCodePreConsent();
        const ctx = buildCookieAuthedAdminCtx({ origin: ISSUER, permissions: [] });

        await expect(oauth.approveAdminRequest(ctx, flow.request_token, true)).rejects.toThrow(/permission/i);
    });

    // Relates to OSS-575 — admin consent with a falsey `approved` returns an access_denied
    // redirect and mints no authorization code.
    it('returns access_denied (and no code) when admin consent is not approved', async () => {
        const flow = await authorizeAdminToCodePreConsent();

        // `approved: false` (boolean). The controller treats anything !== true as denial.
        const res = await fetch(`${baseUrl()}/mcp/oauth/admin-consent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', Authorization: `Bearer ${superAdminToken}` },
            body: JSON.stringify({ session: flow.request_token, approved: false }),
        });
        expect(res.status).toBe(201);
        const { redirectUrl } = (await res.json()) as { redirectUrl: string };
        const url = new URL(redirectUrl);
        expect(url.searchParams.get('error')).toBe('access_denied');
        expect(url.searchParams.get('code')).toBeNull();
    });

    // Relates to OSS-575 — the string `'false'` is also treated as a denial (no code minted).
    it('treats a string "false" approved value as a denial', async () => {
        const flow = await authorizeAdminToCodePreConsent();

        const res = await fetch(`${baseUrl()}/mcp/oauth/admin-consent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', Authorization: `Bearer ${superAdminToken}` },
            body: JSON.stringify({ session: flow.request_token, approved: 'false' }),
        });
        expect(res.status).toBe(201);
        const { redirectUrl } = (await res.json()) as { redirectUrl: string };
        const url = new URL(redirectUrl);
        expect(url.searchParams.get('error')).toBe('access_denied');
        expect(url.searchParams.get('code')).toBeNull();
    });

    // Relates to OSS-575 — the storefront callback rejects a garbage Vendure session token.
    it('rejects a storefront callback with an invalid Vendure session token', async () => {
        const flow = await authorizeShopToConsent();

        const res = await fetch(`${baseUrl()}/mcp/oauth/storefront-callback`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                session: flow.request_token,
                vendureAuthToken: 'not-a-real-session-token',
                approved: true,
            }),
        });
        expect(res.status).toBe(401);
        expect(await res.text()).toMatch(/invalid Vendure storefront session/i);
    });

    // --- Shop happy path ---

    // Relates to OSS-575 — the full shop flow issues tokens that authenticate as the customer.
    it('issues a shop token via the full storefront flow and authenticates the customer', async () => {
        const oauth = server.app.get(McpOauthService);
        const flow = await runShopFlow();
        expect(flow.access_token).toBeTruthy();
        expect(flow.refresh_token).toBeTruthy();

        const authenticated = await oauth.authenticateBearerToken(flow.access_token, 'shop');
        expect(authenticated.ctx.apiType).toBe('shop');
        expect(authenticated.grant.userType).toBe('customer');
        expect(authenticated.ctx.activeUserId).toBe(authenticated.grant.userId);
        expect(authenticated.grant.userId).toBeTruthy();
    });

    // --- helpers that stop before consent ---

    // Drives DCR + authorize for the admin resource and returns the request token, so a
    // test can exercise the admin-consent endpoint directly without approving yet.
    async function authorizeAdminToCodePreConsent() {
        const redirectUri = 'https://example.com/cb';
        const registerRes = await fetch(`${baseUrl()}/mcp/oauth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                client_name: `pre-consent-${Math.random().toString(36).slice(2)}`,
                redirect_uris: [redirectUri],
            }),
        });
        const { client_id } = (await registerRes.json()) as { client_id: string };

        const code_verifier = 'a'.repeat(64);
        const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
        const authorizeUrl = new URL(`${baseUrl()}/mcp/oauth/authorize`);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', client_id);
        authorizeUrl.searchParams.set('redirect_uri', redirectUri);
        authorizeUrl.searchParams.set('code_challenge', code_challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        authorizeUrl.searchParams.set('resource', `${ISSUER}/mcp/admin`);
        const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
        const request_token = extractSession(authorizeRes.headers.get('location'));
        return { client_id, request_token };
    }

    // Drives DCR + authorize for the shop resource and returns the request token, so a test
    // can exercise the storefront-callback endpoint directly.
    async function authorizeShopToConsent() {
        const redirectUri = 'https://example.com/cb';
        const registerRes = await fetch(`${baseUrl()}/mcp/oauth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                client_name: `shop-consent-${Math.random().toString(36).slice(2)}`,
                redirect_uris: [redirectUri],
            }),
        });
        const { client_id } = (await registerRes.json()) as { client_id: string };

        const code_verifier = 'a'.repeat(64);
        const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
        const authorizeUrl = new URL(`${baseUrl()}/mcp/oauth/authorize`);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', client_id);
        authorizeUrl.searchParams.set('redirect_uri', redirectUri);
        authorizeUrl.searchParams.set('code_challenge', code_challenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        authorizeUrl.searchParams.set('resource', `${ISSUER}/mcp/shop`);
        const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
        const request_token = extractSession(authorizeRes.headers.get('location'));
        return { client_id, request_token };
    }

    // Pulls the `session` request token out of a consent redirect Location header,
    // throwing a clear error if the redirect is missing or malformed.
    function extractSession(location: string | null): string {
        if (!location) {
            throw new Error('Authorize did not redirect to consent');
        }
        const session = new URL(location).searchParams.get('session');
        if (!session) {
            throw new Error(`Consent redirect missing session: ${location}`);
        }
        return session;
    }
});
