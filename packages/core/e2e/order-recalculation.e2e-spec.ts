/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
    LanguageCode,
    mergeConfig,
    minimumOrderAmount,
    NoOrderRecalculationStrategy,
    orderPercentageDiscount,
    TtlOrderRecalculationStrategy,
} from '@vendure/core';
import { createErrorResultGuard, createTestEnvironment, ErrorResultGuard } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';

import {
    createPromotionDocument,
    deletePromotionDocument,
    updateProductVariantsDocument,
    updatePromotionDocument,
} from './graphql/shared-definitions';
import {
    addItemToOrderDocument,
    getActiveOrderDocument,
    getActiveOrderWithPriceDataDocument,
} from './graphql/shop-definitions';

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

    // #3510 — promotion discount is removed when promotion is deactivated and order is read with TTL(0) strategy
    it('removes promotion discount on read after promotion is deactivated', async () => {
        await shopClient.asAnonymousUser();

        // Create a promotion: 50% off any order
        const { createPromotion } = await adminClient.query(createPromotionDocument, {
            input: {
                enabled: true,
                translations: [{ languageCode: LanguageCode.en, name: '50% off all orders' }],
                conditions: [
                    {
                        code: minimumOrderAmount.code,
                        arguments: [
                            { name: 'amount', value: '0' },
                            { name: 'taxInclusive', value: 'true' },
                        ],
                    },
                ],
                actions: [
                    {
                        code: orderPercentageDiscount.code,
                        arguments: [{ name: 'discount', value: '50' }],
                    },
                ],
            },
        });
        const promotion = createPromotion as { id: string };

        // Add item to order — discount should apply immediately.
        const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
            productVariantId: 'T_2',
            quantity: 1,
        });
        orderResultGuard.assertSuccess(addItemToOrder);
        const discountedTotal = (addItemToOrder as any).totalWithTax;
        const discounts = (addItemToOrder as any).discounts as Array<{ description: string }>;
        expect(discounts.some((d: any) => d.description === '50% off all orders')).toBe(true);

        // Admin deactivates the promotion.
        await adminClient.query(updatePromotionDocument, {
            input: { id: promotion.id, enabled: false },
        });

        // Reading the active order with TTL(0) triggers recalculation — discount should be gone.
        const { activeOrder } = await shopClient.query(getActiveOrderDocument);
        expect(activeOrder!.discounts.length).toBe(0);
        expect(activeOrder!.totalWithTax).toBeGreaterThan(discountedTotal);

        // Cleanup
        await adminClient.query(deletePromotionDocument, { id: promotion.id });
    });
});

// #3510 — default strategy must not recalculate on read (backward compatibility)
describe('OrderRecalculationStrategy — default (NoOrderRecalculationStrategy)', () => {
    const { server, shopClient, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            orderOptions: {
                orderRecalculationStrategy: new NoOrderRecalculationStrategy(),
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

    // #3510 — default strategy must not recalculate on read (backward compatibility)
    it('does NOT recalculate on read with the default strategy', async () => {
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

        // Reading the active order should NOT recalculate — total stays the same.
        const { activeOrder } = await shopClient.query(getActiveOrderWithPriceDataDocument);
        expect(activeOrder!.totalWithTax).toBe(originalTotal);
    });
});
