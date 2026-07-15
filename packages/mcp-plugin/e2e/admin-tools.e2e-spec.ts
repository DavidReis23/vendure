import {
    ConfigService,
    ID,
    mergeConfig,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';
import { createTestEnvironment, SimpleGraphQLClient } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { McpOauthGrant } from '../src/entities/mcp-oauth-grant.entity';
import { deriveHashKey, hashToken } from '../src/oauth/token-hash';
import { McpPlugin } from '../src/plugin';
import { McpPluginOptions } from '../src/types';

import { postMcp, rpc } from './utils/mcp-http-client';
import { runAuthorizationCodeFlow } from './utils/oauth-test-client';

const TOKEN_SECRET = 'admin-tools-secret-0000000000000000000000';
const ISSUER = 'http://localhost:3500';
const productsCsvPath = path.join(__dirname, 'fixtures/e2e-products.csv');

const adminToolNames = [
    'add_customer_to_group',
    'add_note_to_order',
    'adjust_stock',
    'cancel_order',
    'create_customer',
    'create_product',
    'create_variant',
    'get_customer',
    'get_order',
    'get_product',
    'get_stock_levels',
    'list_channels',
    'list_customers',
    'list_orders',
    'list_products',
    'refund_order',
    'set_active_channel',
    'update_customer',
    'update_order_state',
    'update_product',
    'update_product_assets',
    'update_variant',
    'upload_asset',
].sort();

const destructiveToolNames = ['adjust_stock', 'cancel_order', 'refund_order', 'update_order_state'].sort();

const callTool = (name: string, args: Record<string, unknown> = {}, id = 1) =>
    rpc('tools/call', { name, arguments: args }, id);

const LIMITED_ADMIN_EMAIL = 'limited-admin@example.test';
const LIMITED_ADMIN_PASSWORD = 'test';

/**
 * Creates a ReadCustomer-only administrator and returns its admin-API bearer token. Logging in over
 * the admin API directly (rather than via the shared client) avoids rotating the superadmin session.
 */
async function provisionLimitedAdmin(
    adminClient: SimpleGraphQLClient,
    defaultChannelId: string,
    adminApiUrl: string,
): Promise<string> {
    const role = await adminClient.query(
        gql`
            mutation CreateLimitedRole($input: CreateRoleInput!) {
                createRole(input: $input) {
                    id
                }
            }
        `,
        {
            input: {
                code: 'mcp-limited-role',
                description: 'MCP limited role',
                permissions: ['ReadCustomer'],
                channelIds: [defaultChannelId],
            },
        },
    );
    await adminClient.query(
        gql`
            mutation CreateLimitedAdmin($input: CreateAdministratorInput!) {
                createAdministrator(input: $input) {
                    id
                }
            }
        `,
        {
            input: {
                firstName: 'Limited',
                lastName: 'Admin',
                emailAddress: LIMITED_ADMIN_EMAIL,
                password: LIMITED_ADMIN_PASSWORD,
                roleIds: [role.createRole.id],
            },
        },
    );
    const response = await fetch(adminApiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            query: `mutation { login(username: "${LIMITED_ADMIN_EMAIL}", password: "${LIMITED_ADMIN_PASSWORD}") { __typename } }`,
        }),
    });
    const token = response.headers.get('vendure-auth-token');
    if (!token) {
        throw new Error(`Limited admin login failed: ${await response.text()}`);
    }
    return token;
}

describe('MCP built-in admin tools (direct mode)', () => {
    const config = mergeConfig(testConfig(), {
        plugins: [McpPlugin.init({ oauth: { tokenSecret: TOKEN_SECRET } })],
    });
    const { server, adminClient } = createTestEnvironment(config);
    const baseUrl = () => `http://localhost:${config.apiOptions.port}`;
    const lookupHash = (value: string) => hashToken(`lookup:${value}`, deriveHashKey(TOKEN_SECRET));

    let connection: TransactionalConnection;
    let adminCtx: RequestContext;
    let superAdminToken: string;
    let limitedAdminToken: string;
    let seededCustomerEmail: string;
    let productGraphqlId: string;
    let productId: ID;
    let variantId: ID;
    let stockLocationId: ID;
    let secondChannelToken: string;
    let secondChannelDbId: ID;

    beforeAll(async () => {
        McpPlugin.init({ oauth: { tokenSecret: TOKEN_SECRET } });
        await server.init({ initialData, productsCsvPath, customerCount: 1 });
        await adminClient.asSuperAdmin();
        superAdminToken = adminClient.getAuthToken();

        connection = server.app.get(TransactionalConnection);
        const idStrategy = server.app.get(ConfigService).entityOptions.entityIdStrategy;
        adminCtx = await server.app.get(RequestContextService).create({ apiType: 'admin' });

        const fixture = await adminClient.query(gql`
            query AdminToolFixture {
                activeChannel {
                    id
                    defaultLanguageCode
                    defaultCurrencyCode
                }
                zones(options: { take: 1 }) {
                    items {
                        id
                    }
                }
                products(options: { take: 1 }) {
                    items {
                        id
                    }
                }
                productVariants(options: { take: 1 }) {
                    items {
                        id
                    }
                }
                stockLocations {
                    items {
                        id
                    }
                }
                customers(options: { take: 1 }) {
                    items {
                        emailAddress
                    }
                }
            }
        `);
        const defaultChannelId = fixture.activeChannel.id;
        const zoneId = fixture.zones.items[0]?.id;
        productGraphqlId = fixture.products.items[0]?.id;
        const variantGraphqlId = fixture.productVariants.items[0]?.id;
        const stockLocationGraphqlId = fixture.stockLocations.items[0]?.id;
        seededCustomerEmail = fixture.customers.items[0]?.emailAddress;
        if (
            !productGraphqlId ||
            !zoneId ||
            !seededCustomerEmail ||
            !variantGraphqlId ||
            !stockLocationGraphqlId
        ) {
            throw new Error(`Missing seeded fixtures: ${JSON.stringify(fixture)}`);
        }
        productId = idStrategy.decodeId(productGraphqlId);
        variantId = idStrategy.decodeId(variantGraphqlId);
        stockLocationId = idStrategy.decodeId(stockLocationGraphqlId);

        const channelResult = await adminClient.query(
            gql`
                mutation CreateAdminToolChannel($input: CreateChannelInput!) {
                    createChannel(input: $input) {
                        ... on Channel {
                            id
                            token
                        }
                        ... on ErrorResult {
                            errorCode
                            message
                        }
                    }
                }
            `,
            {
                input: {
                    code: 'admin-tools-second-channel',
                    token: 'admin-tools-second-channel-token',
                    defaultLanguageCode: fixture.activeChannel.defaultLanguageCode,
                    defaultCurrencyCode: fixture.activeChannel.defaultCurrencyCode,
                    pricesIncludeTax: false,
                    defaultShippingZoneId: zoneId,
                    defaultTaxZoneId: zoneId,
                },
            },
        );
        if (!channelResult.createChannel.id) {
            throw new Error(
                `Could not create second channel: ${JSON.stringify(channelResult.createChannel)}`,
            );
        }
        secondChannelToken = channelResult.createChannel.token;
        secondChannelDbId = idStrategy.decodeId(channelResult.createChannel.id);

        // A limited administrator (ReadCustomer only) proves permission filtering + call-time rejection.
        limitedAdminToken = await provisionLimitedAdmin(
            adminClient,
            defaultChannelId,
            `${baseUrl()}/${config.apiOptions.adminApiPath ?? 'admin-api'}`,
        );
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    /** Runs a fresh admin OAuth flow (a new grant) and returns its access token. */
    async function adminAccessToken(consentToken: string = superAdminToken): Promise<string> {
        const flow = await runAuthorizationCodeFlow({
            baseUrl: baseUrl(),
            issuer: ISSUER,
            superAdminToken: consentToken,
        });
        return flow.access_token;
    }

    async function createDraftOrder(): Promise<{ graphqlId: string; id: ID }> {
        const result = await adminClient.query(gql`
            mutation {
                createDraftOrder {
                    id
                    state
                }
            }
        `);
        const idStrategy = server.app.get(ConfigService).entityOptions.entityIdStrategy;
        return { graphqlId: result.createDraftOrder.id, id: idStrategy.decodeId(result.createDraftOrder.id) };
    }

    async function orderState(graphqlId: string): Promise<string> {
        const result = await adminClient.query(
            gql`
                query OrderState($id: ID!) {
                    order(id: $id) {
                        id
                        state
                    }
                }
            `,
            { id: graphqlId },
        );
        return result.order.state;
    }

    it('lists exactly the 23 built-in admin tools for a superadmin grant', async () => {
        const token = await adminAccessToken();
        const response = await postMcp(baseUrl(), 'admin', rpc('tools/list', {}, 1), { token });

        expect(response.status).toBe(200);
        expect(response.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
            adminToolNames,
        );
    });

    it('advertises optional confirm on exactly the destructive admin tools (wire schema)', async () => {
        const token = await adminAccessToken();
        const response = await postMcp(baseUrl(), 'admin', rpc('tools/list', {}, 1), { token });
        const tools = response.body.result.tools as Array<{
            name: string;
            inputSchema: { properties?: Record<string, { type?: string }>; required?: string[] };
        }>;

        const withConfirm = tools
            .filter(tool => tool.inputSchema?.properties?.confirm !== undefined)
            .map(tool => tool.name)
            .sort();
        expect(withConfirm).toEqual(destructiveToolNames);

        for (const tool of tools.filter(candidate => destructiveToolNames.includes(candidate.name))) {
            expect(tool.inputSchema.properties?.confirm?.type).toBe('boolean');
            expect(tool.inputSchema.required ?? []).not.toContain('confirm');
        }

        // A representative readonly tool advertises no confirm parameter.
        const listOrders = tools.find(tool => tool.name === 'list_orders');
        expect(listOrders?.inputSchema.properties?.confirm).toBeUndefined();
    });

    it('gates cancel_order until confirm:true, without mutating on the preview call', async () => {
        const token = await adminAccessToken();
        const order = await createDraftOrder();
        const stateBefore = await orderState(order.graphqlId);

        const preview = await postMcp(baseUrl(), 'admin', callTool('cancel_order', { id: order.id }, 1), {
            token,
        });
        expect(preview.body.result.isError).toBeUndefined();
        expect(preview.body.result.structuredContent).toMatchObject({ status: 'confirmation_required' });
        // Proof of no mutation: the order's state is unchanged by the preview.
        expect(await orderState(order.graphqlId)).toBe(stateBefore);

        const confirmed = await postMcp(
            baseUrl(),
            'admin',
            callTool('cancel_order', { id: order.id, confirm: true }, 2),
            { token },
        );
        expect(confirmed.body.result.isError).toBeUndefined();
        // The gate passed and the handler ran the real cancelOrder. An empty draft has no lines to
        // cancel, so the tool surfaces the concrete EmptyOrderLineSelectionError union — proof the
        // handler executed and shaped its business result, not merely that the confirm gate opened.
        expect(confirmed.body.result.structuredContent).toMatchObject({
            result: {
                __typename: 'EmptyOrderLineSelectionError',
                errorCode: 'EMPTY_ORDER_LINE_SELECTION_ERROR',
            },
        });
    });

    it('does not require confirmation for a readonly tool', async () => {
        const token = await adminAccessToken();
        const response = await postMcp(baseUrl(), 'admin', callTool('list_orders', {}, 1), { token });
        expect(response.body.result.isError).toBeUndefined();
        expect(response.body.result.structuredContent).toHaveProperty('items');
        expect((response.body.result.structuredContent as { status?: string }).status).not.toBe(
            'confirmation_required',
        );
    });

    it('filters tools a caller lacks permission for and rejects them at call time', async () => {
        const token = await adminAccessToken(limitedAdminToken);
        const listed = await postMcp(baseUrl(), 'admin', rpc('tools/list', {}, 1), { token });
        const names = (listed.body.result.tools as Array<{ name: string }>).map(tool => tool.name);
        expect(names).toContain('list_customers');
        expect(names).toContain('get_customer');
        expect(names).not.toContain('list_orders');
        expect(names).not.toContain('create_product');

        // list_orders was filtered out of the exposed set, so it is not callable: the SDK rejects the
        // unknown tool at the protocol level. (The registry's in-funnel permission check — which returns
        // an isError result for a registered-but-unpermitted tool — is covered by the registry unit spec
        // and exercised end-to-end via the discovery execute_tool funnel.)
        const denied = await postMcp(baseUrl(), 'admin', callTool('list_orders', {}, 2), { token });
        // Assert exactly that mechanism: a top-level JSON-RPC protocol error and no tool result — not
        // the in-funnel `isError` permission path (which discovery mode + the registry unit spec prove).
        expect(denied.body.error).toBeDefined();
        expect(denied.body.result).toBeUndefined();
    });

    it('set_active_channel writes the grant row and changes the active channel for later calls', async () => {
        const token = await adminAccessToken();

        // The seeded product is on the default channel, so it is visible before switching channels.
        const before = await postMcp(baseUrl(), 'admin', callTool('get_product', { id: productId }, 1), {
            token,
        });
        expect(before.body.result.structuredContent.product).toMatchObject({ id: productId });

        const switched = await postMcp(
            baseUrl(),
            'admin',
            callTool('set_active_channel', { channelToken: secondChannelToken }, 2),
            { token },
        );
        expect(switched.body.result.isError).toBeUndefined();
        expect(switched.body.result.structuredContent.channel).toMatchObject({ token: secondChannelToken });

        const grant = await connection.getRepository(adminCtx, McpOauthGrant).findOneOrFail({
            where: { accessTokenHash: lookupHash(token) },
        });
        expect(String(grant.channelId)).toBe(String(secondChannelDbId));

        // Later calls run on the newly-selected channel, where the seeded product is not assigned.
        const after = await postMcp(baseUrl(), 'admin', callTool('get_product', { id: productId }, 3), {
            token,
        });
        expect(after.body.result.structuredContent).toEqual({ product: null });
    });

    it('runs a create-customer flow and shapes ErrorResult unions as success structuredContent', async () => {
        const token = await adminAccessToken();

        const created = await postMcp(
            baseUrl(),
            'admin',
            callTool(
                'create_customer',
                { input: { firstName: 'Ada', lastName: 'Lovelace', emailAddress: 'ada@example.test' } },
                1,
            ),
            { token },
        );
        expect(created.body.result.isError).toBeUndefined();
        expect(created.body.result.structuredContent.customer).toMatchObject({
            emailAddress: 'ada@example.test',
        });

        // Creating a registered account for an email that already has a user returns an ErrorResult,
        // which the tool surfaces as a non-error result (customer: null), not an isError envelope.
        const conflict = await postMcp(
            baseUrl(),
            'admin',
            callTool(
                'create_customer',
                {
                    input: { firstName: 'Dup', lastName: 'Licate', emailAddress: seededCustomerEmail },
                    password: 'test',
                },
                2,
            ),
            { token },
        );
        expect(conflict.body.result.isError).toBeUndefined();
        expect(conflict.body.result.structuredContent).toEqual({ customer: null });
    });

    it('reads stock levels for a variant through get_stock_levels', async () => {
        const token = await adminAccessToken();
        const response = await postMcp(baseUrl(), 'admin', callTool('get_stock_levels', { variantId }, 1), {
            token,
        });
        expect(response.body.result.isError).toBeUndefined();
        const stockLevels = response.body.result.structuredContent.stockLevels as Array<{
            stockOnHand: number;
            stockAllocated: number;
            stockLocationId: ID;
        }>;
        expect(Array.isArray(stockLevels)).toBe(true);
        // The seeded variant carries stock at the default location (stockOnHand 100 in the fixture CSV),
        // so its level for that location is present and shaped as a stock-level record.
        const atLocation = stockLevels.find(
            level => String(level.stockLocationId) === String(stockLocationId),
        );
        expect(atLocation).toBeDefined();
        expect(typeof atLocation?.stockOnHand).toBe('number');
        expect(typeof atLocation?.stockAllocated).toBe('number');
    });

    it('adjust_stock applies the delta to stock on hand when confirmed', async () => {
        const token = await adminAccessToken();
        // Reads the current on-hand quantity for the fixture location (0 if no level exists yet).
        const readOnHand = async () => {
            const res = await postMcp(baseUrl(), 'admin', callTool('get_stock_levels', { variantId }, 1), {
                token,
            });
            const levels = res.body.result.structuredContent.stockLevels as Array<{
                stockOnHand: number;
                stockLocationId: ID;
            }>;
            return (
                levels.find(level => String(level.stockLocationId) === String(stockLocationId))
                    ?.stockOnHand ?? 0
            );
        };

        const before = await readOnHand();
        const delta = 7;

        const adjusted = await postMcp(
            baseUrl(),
            'admin',
            callTool('adjust_stock', { variantId, locationId: stockLocationId, delta, confirm: true }, 2),
            { token },
        );
        expect(adjusted.body.result.isError).toBeUndefined();
        // The confirmed call returns the refreshed stock levels; the adjusted location reflects the delta.
        const returned = adjusted.body.result.structuredContent.stockLevels as Array<{
            stockOnHand: number;
            stockLocationId: ID;
        }>;
        const returnedAtLocation = returned.find(
            level => String(level.stockLocationId) === String(stockLocationId),
        );
        expect(returnedAtLocation?.stockOnHand).toBe(before + delta);
        // A fresh read confirms the change persisted, not just that the response echoed it.
        expect(await readOnHand()).toBe(before + delta);
    });
});

describe('MCP built-in admin tools (discovery mode)', () => {
    const options: McpPluginOptions = { toolExposure: 'discovery', oauth: { tokenSecret: TOKEN_SECRET } };
    const config = mergeConfig(testConfig(), { plugins: [McpPlugin.init(options)] });
    const { server, adminClient } = createTestEnvironment(config);
    const baseUrl = () => `http://localhost:${config.apiOptions.port}`;

    let superAdminToken: string;
    let limitedAdminToken: string;

    beforeAll(async () => {
        McpPlugin.init(options);
        await server.init({ initialData, productsCsvPath, customerCount: 1 });
        await adminClient.asSuperAdmin();
        superAdminToken = adminClient.getAuthToken();
        const { activeChannel } = await adminClient.query(gql`
            query {
                activeChannel {
                    id
                }
            }
        `);
        limitedAdminToken = await provisionLimitedAdmin(
            adminClient,
            activeChannel.id,
            `${baseUrl()}/${config.apiOptions.adminApiPath ?? 'admin-api'}`,
        );
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    async function adminAccessToken(): Promise<string> {
        const flow = await runAuthorizationCodeFlow({
            baseUrl: baseUrl(),
            issuer: ISSUER,
            superAdminToken,
        });
        return flow.access_token;
    }

    async function createDraftOrder(): Promise<ID> {
        const result = await adminClient.query(gql`
            mutation {
                createDraftOrder {
                    id
                }
            }
        `);
        const idStrategy = server.app.get(ConfigService).entityOptions.entityIdStrategy;
        return idStrategy.decodeId(result.createDraftOrder.id);
    }

    it('exposes exactly the two discovery meta-tools (single execute_tool)', async () => {
        const token = await adminAccessToken();
        const response = await postMcp(baseUrl(), 'admin', rpc('tools/list', {}, 1), { token });
        expect(response.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
            'execute_tool',
            'search_tools',
        ]);
    });

    it('gates a destructive tool via execute_tool, then runs it with confirm:true', async () => {
        const token = await adminAccessToken();
        const orderId = await createDraftOrder();

        const preview = await postMcp(
            baseUrl(),
            'admin',
            callTool('execute_tool', { name: 'cancel_order', arguments: { id: orderId } }, 1),
            { token },
        );
        expect(preview.body.result.isError).toBeUndefined();
        expect(preview.body.result.structuredContent).toMatchObject({ status: 'confirmation_required' });

        const confirmed = await postMcp(
            baseUrl(),
            'admin',
            callTool('execute_tool', { name: 'cancel_order', arguments: { id: orderId, confirm: true } }, 2),
            { token },
        );
        expect(confirmed.body.result.isError).toBeUndefined();
        // Through the discovery funnel too, confirm:true reaches the real cancelOrder: an empty draft
        // has no lines to cancel, so the concrete EmptyOrderLineSelectionError union comes back — not
        // the confirmation gate.
        expect(confirmed.body.result.structuredContent).toMatchObject({
            result: {
                __typename: 'EmptyOrderLineSelectionError',
                errorCode: 'EMPTY_ORDER_LINE_SELECTION_ERROR',
            },
        });
    });

    it('rejects an unpermitted tool at call time through the execute_tool funnel (defense-in-depth)', async () => {
        // The single execute_tool meta-tool routes every call through the registry funnel, which
        // re-checks permissions even for tools the caller was never shown — so a ReadCustomer-only
        // grant is denied list_orders with an isError result, not silently allowed.
        const flow = await runAuthorizationCodeFlow({
            baseUrl: baseUrl(),
            issuer: ISSUER,
            superAdminToken: limitedAdminToken,
        });
        const denied = await postMcp(
            baseUrl(),
            'admin',
            callTool('execute_tool', { name: 'list_orders', arguments: {} }, 1),
            { token: flow.access_token },
        );
        expect(denied.body.result.isError).toBe(true);
        expect(denied.body.result.content[0].text).toMatch(/permission/i);
    });
});
