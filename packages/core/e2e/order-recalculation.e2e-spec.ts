/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ErrorCode } from '@vendure/common/lib/generated-shop-types';
import {
    defaultShippingCalculator,
    defaultShippingEligibilityChecker,
    LanguageCode,
    manualFulfillmentHandler,
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
    createShippingMethodDocument,
    deletePromotionDocument,
    updateProductVariantsDocument,
    updatePromotionDocument,
    updateShippingMethodDocument,
} from './graphql/shared-definitions';
import {
    addItemToOrderDocument,
    getActiveOrderDocument,
    getActiveOrderWithPriceDataDocument,
    setCustomerDocument,
    setShippingAddressDocument,
    setShippingMethodDocument,
    transitionToStateDocument,
} from './graphql/shop-definitions';

describe('OrderRecalculationStrategy', () => {
    const { server, shopClient, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            orderOptions: {
                orderRecalculationStrategy: new TtlOrderRecalculationStrategy({ ttlMs: 0 }),
            },
        }),
    );

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

// #3510 — checkout gate: verify shipping eligibility + recalc on ArrangingPayment transition
describe('OrderRecalculationStrategy — checkout gate', () => {
    const { server, shopClient, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            orderOptions: {
                orderRecalculationStrategy: new TtlOrderRecalculationStrategy({ ttlMs: 0 }),
            },
            shippingOptions: {
                shippingEligibilityCheckers: [defaultShippingEligibilityChecker],
                shippingCalculators: [defaultShippingCalculator],
            },
        }),
    );

    const orderResultGuard: ErrorResultGuard<{ id: string; totalWithTax: number }> = createErrorResultGuard(
        (input: any) => !!input.lines,
    );

    const transitionGuard: ErrorResultGuard<{ state: string }> = createErrorResultGuard(
        (input: any) => !!input.state,
    );

    const shippingAddress = {
        fullName: 'Test Customer',
        streetLine1: '1 Test Street',
        city: 'Test City',
        province: 'Test',
        postalCode: '12345',
        countryCode: 'US',
        phoneNumber: '555-0100',
    };

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

    // #3510 — checkout refused when chosen shipping method became ineligible
    it('refuses ArrangingPayment when chosen shipping method is ineligible', async () => {
        await shopClient.asAnonymousUser();

        // Create a shipping method eligible for any order (orderMinimum: 0).
        const { createShippingMethod } = await adminClient.query(createShippingMethodDocument, {
            input: {
                code: 'test-ineligible-shipping',
                translations: [{ languageCode: LanguageCode.en, name: 'Test Shipping', description: '' }],
                fulfillmentHandler: manualFulfillmentHandler.code,
                checker: {
                    code: defaultShippingEligibilityChecker.code,
                    arguments: [{ name: 'orderMinimum', value: '0' }],
                },
                calculator: {
                    code: defaultShippingCalculator.code,
                    arguments: [
                        { name: 'rate', value: '500' },
                        { name: 'taxRate', value: '0' },
                        { name: 'includesTax', value: 'auto' },
                    ],
                },
            },
        });
        const shippingMethodId = (createShippingMethod as any).id;

        // Add item to order.
        const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
            productVariantId: 'T_1',
            quantity: 1,
        });
        orderResultGuard.assertSuccess(addItemToOrder);

        // Set customer details and shipping.
        await shopClient.query(setCustomerDocument, {
            input: { firstName: 'Test', lastName: 'User', emailAddress: 'test@test.com' },
        });
        await shopClient.query(setShippingAddressDocument, { input: shippingAddress });
        await shopClient.query(setShippingMethodDocument, { id: [shippingMethodId] });

        // Admin raises the minimum so the current order total no longer qualifies.
        await adminClient.query(updateShippingMethodDocument, {
            input: {
                id: shippingMethodId,
                checker: {
                    code: defaultShippingEligibilityChecker.code,
                    arguments: [{ name: 'orderMinimum', value: '999999999' }],
                },
                translations: [{ languageCode: LanguageCode.en, name: 'Test Shipping', description: '' }],
                calculator: {
                    code: defaultShippingCalculator.code,
                    arguments: [
                        { name: 'rate', value: '500' },
                        { name: 'taxRate', value: '0' },
                        { name: 'includesTax', value: 'auto' },
                    ],
                },
            },
        });

        // Transition should be refused: the shipping method is no longer eligible.
        const { transitionOrderToState } = await shopClient.query(transitionToStateDocument, {
            state: 'ArrangingPayment',
        });
        transitionGuard.assertErrorResult(transitionOrderToState);
        const transitionError = transitionOrderToState as any;
        expect(transitionError.errorCode).toBe(ErrorCode.ORDER_STATE_TRANSITION_ERROR);
        expect(transitionError.transitionError).toContain('no longer eligible');
        expect(transitionError.fromState).toBe('AddingItems');
        expect(transitionError.toState).toBe('ArrangingPayment');
    });

    // #3510 — happy path: price is recalculated when transitioning to ArrangingPayment
    it('recalculates prices and allows transition when shipping method is eligible', async () => {
        await shopClient.asAnonymousUser();

        // Create a shipping method eligible for any order.
        const { createShippingMethod } = await adminClient.query(createShippingMethodDocument, {
            input: {
                code: 'test-eligible-shipping',
                translations: [
                    { languageCode: LanguageCode.en, name: 'Test Eligible Shipping', description: '' },
                ],
                fulfillmentHandler: manualFulfillmentHandler.code,
                checker: {
                    code: defaultShippingEligibilityChecker.code,
                    arguments: [{ name: 'orderMinimum', value: '0' }],
                },
                calculator: {
                    code: defaultShippingCalculator.code,
                    arguments: [
                        { name: 'rate', value: '500' },
                        { name: 'taxRate', value: '0' },
                        { name: 'includesTax', value: 'auto' },
                    ],
                },
            },
        });
        const shippingMethodId = (createShippingMethod as any).id;

        // Add item to order and record the current total.
        const { addItemToOrder } = await shopClient.query(addItemToOrderDocument, {
            productVariantId: 'T_2',
            quantity: 1,
        });
        orderResultGuard.assertSuccess(addItemToOrder);
        const originalTotal = (addItemToOrder as any).totalWithTax;

        // Set customer details and shipping.
        await shopClient.query(setCustomerDocument, {
            input: { firstName: 'Test', lastName: 'User', emailAddress: 'test2@test.com' },
        });
        await shopClient.query(setShippingAddressDocument, { input: shippingAddress });
        await shopClient.query(setShippingMethodDocument, { id: [shippingMethodId] });

        // Admin changes the variant price — should be picked up at checkout.
        await adminClient.query(updateProductVariantsDocument, {
            input: [{ id: 'T_2', price: 99999 }],
        });

        // Transition should succeed and order total should reflect the new price.
        const { transitionOrderToState } = await shopClient.query(transitionToStateDocument, {
            state: 'ArrangingPayment',
        });
        transitionGuard.assertSuccess(transitionOrderToState);
        expect((transitionOrderToState as any).state).toBe('ArrangingPayment');

        const { activeOrder } = await shopClient.query(getActiveOrderWithPriceDataDocument);
        expect(activeOrder!.totalWithTax).not.toBe(originalTotal);
    });
});
