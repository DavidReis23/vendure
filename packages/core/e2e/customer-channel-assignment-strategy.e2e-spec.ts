import { CurrencyCode, LanguageCode } from '@vendure/common/lib/generated-types';
import { CustomerChannelAssignmentStrategy, mergeConfig, RequestContext } from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';

import { ResultOf } from './graphql/graphql-admin';
import { createChannelDocument, getCustomerListDocument, MeDocument } from './graphql/shared-definitions';
import { getProductsTake3Document, logOutDocument } from './graphql/shop-definitions';
import { assertThrowsWithMessage } from './utils/assert-throws-with-message';

const GATED_CHANNEL_CODE = 'gated-channel';
const GATED_CHANNEL_TOKEN = 'gated_channel_token';
const NO_AUTOJOIN_CHANNEL_CODE = 'no-autojoin-channel';
const NO_AUTOJOIN_CHANNEL_TOKEN = 'no_autojoin_channel_token';
const OPEN_CHANNEL_CODE = 'open-channel';
const OPEN_CHANNEL_TOKEN = 'open_channel_token';

/**
 * Denies access to the gated channel entirely, and allows access — but suppresses the silent
 * auto-join — for the no-autojoin channel. Every other channel behaves as the default (allow and
 * auto-join).
 */
class TestCustomerChannelAssignmentStrategy implements CustomerChannelAssignmentStrategy {
    canCustomerAccessChannel(ctx: RequestContext): boolean {
        return ctx.channel.code !== GATED_CHANNEL_CODE;
    }

    canAssignCustomerToChannel(ctx: RequestContext): boolean {
        return ctx.channel.code !== NO_AUTOJOIN_CHANNEL_CODE;
    }
}

type CustomerListItem = ResultOf<typeof getCustomerListDocument>['customers']['items'][number];

describe('CustomerChannelAssignmentStrategy', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            authOptions: {
                customerChannelAssignmentStrategy: new TestCustomerChannelAssignmentStrategy(),
            },
        }),
    );
    let customer: CustomerListItem;

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();

        const { customers } = await adminClient.query(getCustomerListDocument, { options: { take: 1 } });
        customer = customers.items[0];

        for (const [code, token] of [
            [GATED_CHANNEL_CODE, GATED_CHANNEL_TOKEN],
            [NO_AUTOJOIN_CHANNEL_CODE, NO_AUTOJOIN_CHANNEL_TOKEN],
            [OPEN_CHANNEL_CODE, OPEN_CHANNEL_TOKEN],
        ]) {
            await adminClient.query(createChannelDocument, {
                input: {
                    code,
                    token,
                    defaultLanguageCode: LanguageCode.en,
                    currencyCode: CurrencyCode.GBP,
                    pricesIncludeTax: true,
                    defaultShippingZoneId: 'T_1',
                    defaultTaxZoneId: 'T_1',
                },
            });
        }
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    async function customerListForChannel(token: string) {
        adminClient.setChannelToken(token);
        const { customers } = await adminClient.query(getCustomerListDocument);
        return customers.items.map(c => c.emailAddress);
    }

    it(
        'denies an authenticated customer access to a gated channel',
        assertThrowsWithMessage(async () => {
            shopClient.setChannelToken(GATED_CHANNEL_TOKEN);
            await shopClient.asUserWithCredentials(customer.emailAddress, 'test');
            await shopClient.query(MeDocument);
        }, 'You are not currently authorized to perform this action'),
    );

    it('does not assign the customer when access to a gated channel was denied', async () => {
        const emails = await customerListForChannel(GATED_CHANNEL_TOKEN);
        expect(emails).not.toContain(customer.emailAddress);
    });

    it('allows access to a no-autojoin channel but does not persist membership', async () => {
        shopClient.setChannelToken(NO_AUTOJOIN_CHANNEL_TOKEN);
        await shopClient.asUserWithCredentials(customer.emailAddress, 'test');
        const { me } = await shopClient.query(MeDocument);
        expect(me?.identifier).toBe(customer.emailAddress);

        const emails = await customerListForChannel(NO_AUTOJOIN_CHANNEL_TOKEN);
        expect(emails).not.toContain(customer.emailAddress);
    });

    it('still auto-joins the customer on an open channel', async () => {
        shopClient.setChannelToken(OPEN_CHANNEL_TOKEN);
        await shopClient.asUserWithCredentials(customer.emailAddress, 'test');
        await shopClient.query(MeDocument);

        const emails = await customerListForChannel(OPEN_CHANNEL_TOKEN);
        expect(emails).toContain(customer.emailAddress);
    });

    it(
        'membership of the open channel does not grant access to the gated channel',
        assertThrowsWithMessage(async () => {
            // Auto-join the customer to the open channel, then confirm that membership does not
            // grant access to a different, gated channel.
            shopClient.setChannelToken(OPEN_CHANNEL_TOKEN);
            await shopClient.asUserWithCredentials(customer.emailAddress, 'test');
            shopClient.setChannelToken(GATED_CHANNEL_TOKEN);
            await shopClient.query(MeDocument);
        }, 'You are not currently authorized to perform this action'),
    );

    it('allows logout while pointed at a gated channel (a Public operation is never blocked)', async () => {
        shopClient.setChannelToken(OPEN_CHANNEL_TOKEN);
        await shopClient.asUserWithCredentials(customer.emailAddress, 'test');
        shopClient.setChannelToken(GATED_CHANNEL_TOKEN);
        const { logout } = await shopClient.query(logOutDocument);
        expect(logout.success).toBe(true);
    });

    it('allows a Public catalog query while pointed at a gated channel', async () => {
        shopClient.setChannelToken(OPEN_CHANNEL_TOKEN);
        await shopClient.asUserWithCredentials(customer.emailAddress, 'test');
        shopClient.setChannelToken(GATED_CHANNEL_TOKEN);
        // Resolves to a ProductList rather than throwing a ForbiddenError; the gate exempts Public ops.
        const { products } = await shopClient.query(getProductsTake3Document);
        expect(Array.isArray(products.items)).toBe(true);
    });

    it('does not gate an authenticated user that has no Customer record', async () => {
        // The SuperAdmin user has no Customer, so the gate must skip it on a non-default channel
        // rather than denying the request.
        adminClient.setChannelToken(GATED_CHANNEL_TOKEN);
        const { customers } = await adminClient.query(getCustomerListDocument);
        expect(customers.items).toBeDefined();
    });
});

describe('default channel is never gated', () => {
    class DenyAllStrategy implements CustomerChannelAssignmentStrategy {
        canCustomerAccessChannel(): boolean {
            return false;
        }

        canAssignCustomerToChannel(): boolean {
            return false;
        }
    }

    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            authOptions: { customerChannelAssignmentStrategy: new DenyAllStrategy() },
        }),
    );
    let email: string;

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();
        const { customers } = await adminClient.query(getCustomerListDocument, { options: { take: 1 } });
        email = customers.items[0].emailAddress;
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('still authenticates on the default channel under a deny-all strategy', async () => {
        shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
        await shopClient.asUserWithCredentials(email, 'test');
        const { me } = await shopClient.query(MeDocument);
        expect(me?.identifier).toBe(email);
    });
});
