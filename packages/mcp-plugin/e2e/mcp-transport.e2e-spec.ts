import { mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import { gql } from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { McpPlugin } from '../src/plugin';
import { McpPluginOptions } from '../src/types';

import { McpTestToolsPlugin } from './fixtures/mcp-test-tools';
import { postMcp, rpc } from './utils/mcp-http-client';
import { runAuthorizationCodeFlow } from './utils/oauth-test-client';

const TOKEN_SECRET = 'mcp-transport-secret-0000000000000000000000';
const ISSUER = 'http://localhost:3500';
const productsCsvPath = path.join(__dirname, 'fixtures/e2e-products.csv');

const AUTH_TOKEN_HEADER = 'vendure-auth-token';
const CHANNEL_TOKEN_HEADER = 'vendure-token';

const callTool = (name: string, args: Record<string, unknown> = {}, id = 1) =>
    rpc('tools/call', { name, arguments: args }, id);

describe('MCP transport (auth, session, channel, destructive)', () => {
    const options: McpPluginOptions = { oauth: { tokenSecret: TOKEN_SECRET } };
    const config = mergeConfig(testConfig(), { plugins: [McpTestToolsPlugin, McpPlugin.init(options)] });
    const { server, adminClient } = createTestEnvironment(config);
    const baseUrl = () => `http://localhost:${config.apiOptions.port}`;
    let adminToken: string;
    let secondChannelToken: string | undefined;

    beforeAll(async () => {
        McpPlugin.init(options);
        await server.init({ initialData, productsCsvPath, customerCount: 1 });
        await adminClient.asSuperAdmin();
        adminToken = (
            await runAuthorizationCodeFlow({
                baseUrl: baseUrl(),
                issuer: ISSUER,
                superAdminToken: adminClient.getAuthToken(),
            })
        ).access_token;

        // Create a second channel so the anonymous channel-selection test has a non-default target.
        const { zones } = await adminClient.query(gql`
            query {
                zones {
                    items {
                        id
                    }
                }
            }
        `);
        const active = await adminClient.query(gql`
            query {
                activeChannel {
                    defaultLanguageCode
                    defaultCurrencyCode
                }
            }
        `);
        const zoneId = zones.items[0].id;
        const created = await adminClient.query(
            gql`
                mutation Create($input: CreateChannelInput!) {
                    createChannel(input: $input) {
                        __typename
                        ... on Channel {
                            id
                            token
                        }
                    }
                }
            `,
            {
                input: {
                    code: 'second-channel',
                    token: 'second-channel-token',
                    defaultLanguageCode: active.activeChannel.defaultLanguageCode,
                    defaultCurrencyCode: active.activeChannel.defaultCurrencyCode,
                    pricesIncludeTax: false,
                    defaultShippingZoneId: zoneId,
                    defaultTaxZoneId: zoneId,
                },
            },
        );
        secondChannelToken = created.createChannel.token;
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('exposes different tool subsets per auth context', async () => {
        const shop = await postMcp(baseUrl(), 'shop', rpc('tools/list', {}, 1));
        const shopNames = shop.body.result.tools.map((t: any) => t.name);
        expect(shopNames).toEqual(expect.arrayContaining(['shop_ping', 'shop_echo']));
        expect(shopNames).not.toContain('admin_list');

        const admin = await postMcp(baseUrl(), 'admin', rpc('tools/list', {}, 2), { token: adminToken });
        const adminNames = admin.body.result.tools.map((t: any) => t.name);
        expect(adminNames).toContain('admin_list');
        expect(adminNames).not.toContain('shop_ping');
    });

    it('threads the anonymous session token so two calls hit the same session', async () => {
        const first = await postMcp(baseUrl(), 'shop', callTool('shop_ping', {}, 1));
        const echoedToken = first.headers.get(AUTH_TOKEN_HEADER);
        expect(echoedToken).toBeTruthy();
        const firstSessionId = first.body.result.structuredContent.sessionId;
        expect(firstSessionId).toBeTruthy();

        const second = await postMcp(baseUrl(), 'shop', callTool('shop_ping', {}, 2), {
            headers: { [AUTH_TOKEN_HEADER]: echoedToken as string },
        });
        expect(second.body.result.structuredContent.sessionId).toBe(firstSessionId);
    });

    it('selects a non-default channel from the channel token header', async () => {
        expect(secondChannelToken).toBeTruthy();
        const defaultCall = await postMcp(baseUrl(), 'shop', callTool('shop_ping', {}, 1));
        const defaultChannelId = defaultCall.body.result.structuredContent.channelId;

        const scoped = await postMcp(baseUrl(), 'shop', callTool('shop_ping', {}, 2), {
            headers: { [CHANNEL_TOKEN_HEADER]: secondChannelToken as string },
        });
        const scopedChannelId = scoped.body.result.structuredContent.channelId;
        expect(scopedChannelId).toBeTruthy();
        expect(scopedChannelId).not.toBe(defaultChannelId);
    });

    it('errors on an invalid channel token (no silent fallback)', async () => {
        const res = await postMcp(baseUrl(), 'shop', callTool('shop_ping', {}, 1), {
            headers: { [CHANNEL_TOKEN_HEADER]: 'not-a-real-channel-token' },
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('gates a destructive tool behind confirmation, then runs it with confirm:true', async () => {
        const preview = await postMcp(baseUrl(), 'shop', callTool('shop_delete', { id: 'abc' }, 1));
        expect(preview.body.result.isError).toBeUndefined();
        expect(preview.body.result.structuredContent).toMatchObject({
            status: 'confirmation_required',
            confirmed: false,
        });

        const confirmed = await postMcp(
            baseUrl(),
            'shop',
            callTool('shop_delete', { id: 'abc', confirm: true }, 2),
        );
        expect(confirmed.body.result.structuredContent).toEqual({ deleted: 'abc' });
    });
});

describe('MCP transport rate limiting', () => {
    const options: McpPluginOptions = {
        oauth: { tokenSecret: TOKEN_SECRET },
        rateLimits: { perSession: { rpm: 0 }, perClient: { rpm: 0 }, anonymousIp: { rpm: 2 } },
    };
    const config = mergeConfig(testConfig(), { plugins: [McpTestToolsPlugin, McpPlugin.init(options)] });
    const { server } = createTestEnvironment(config);
    const baseUrl = () => `http://localhost:${config.apiOptions.port}`;

    beforeAll(async () => {
        McpPlugin.init(options);
        await server.init({ initialData, productsCsvPath, customerCount: 1 });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('handshake rate limit returns -32029 WITH machine-readable error.data', async () => {
        // anonymousIp rpm = 2, so the third sequential anonymous ping trips the limit.
        await postMcp(baseUrl(), 'shop', rpc('ping', {}, 1));
        await postMcp(baseUrl(), 'shop', rpc('ping', {}, 2));
        const tripped = await postMcp(baseUrl(), 'shop', rpc('ping', {}, 3));
        expect(tripped.status).toBe(200);
        expect(tripped.body.error.code).toBe(-32029);
        expect(tripped.body.error.data.retryAfterSeconds).toBeGreaterThan(0);
        expect(tripped.body.error.data.scope).toBe('anonymous IP');
    });

    it('a tool-path rate limit flattens to isError (no -32029 code)', async () => {
        // The anonymous-IP bucket is already tripped from the previous test (60s window), so a
        // tools/call from the same IP is rejected inside the registry and surfaces as isError.
        const res = await postMcp(baseUrl(), 'shop', callTool('shop_echo', { text: 'x' }, 1));
        expect(res.body.error).toBeUndefined();
        expect(res.body.result.isError).toBe(true);
        expect(res.body.result.content[0].text).toMatch(/Rate limit exceeded/);
    });
});
