/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { mergeConfig, TtlOrderRecalculationStrategy } from '@vendure/core';
import { createErrorResultGuard, createTestEnvironment, ErrorResultGuard } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';

import { updateProductVariantsDocument } from './graphql/shared-definitions';
import { addItemToOrderDocument, getActiveOrderWithPriceDataDocument } from './graphql/shop-definitions';

describe('OrderRecalculationStrategy', () => {
    const { server, shopClient, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            orderOptions: {
                orderRecalculationStrategy: new TtlOrderRecalculationStrategy({ ttlMs: 0 }),
            },
        }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orderResultGuard: ErrorResultGuard<{ id: string; totalWithTax: number }> = createErrorResultGuard(
        (input: any) => !!input.lines,
    );

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    // #3510 — active order recalculates variant price change on read when strategy reports stale
    it('recalculates changed variant price on read', async () => {
        await shopClient.asAnonymousUser();
        const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
            productVariantId: 'T_1',
            quantity: 1,
        });
        orderResultGuard.assertSuccess(addItemToOrder);
        const originalTotal = (addItemToOrder as any).totalWithTax;

        // Admin changes the variant price.
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: 'T_1', price: originalTotal * 2 }],
        });

        // Reading the active order triggers a recalculation (ttlMs: 0 => always stale).
        const { activeOrder } = await shopClient.query(getActiveOrderWithPriceDataDocument);
        expect(activeOrder!.totalWithTax).not.toBe(originalTotal);
    });
});
