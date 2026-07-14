import { describe, expect, it, vi } from 'vitest';

const expectedExports = [
    'assetSummary',
    'collectionSummary',
    'customerSummary',
    'customerSummaryResult',
    'fetchRemoteAsset',
    'getActiveOrder',
    'id',
    'idArray',
    'isBlockedIp',
    'isRecord',
    'listOptions',
    'number',
    'object',
    'orderListOptions',
    'orderResult',
    'orderState',
    'orderSummary',
    'page',
    'productListOptions',
    'productSummary',
    'publicCollectionListOptions',
    'publicProductListOptions',
    'string',
    'uploadAssetFromUrl',
    'variantSummary',
];

describe('built-in tool kit', () => {
    it('exports only the helpers consumed by the shipped tools', async () => {
        const toolKit = await import('./tool-kit');

        expect(Object.keys(toolKit).sort()).toEqual(expectedExports);
        expect(Object.values(toolKit).every(value => typeof value === 'function')).toBe(true);
    });

    it('serializes order results and preserves Vendure error results', async () => {
        const { orderResult } = await import('./tool-kit');

        expect(
            orderResult({
                id: '1',
                code: 'T_1',
                lines: [
                    {
                        id: '2',
                        quantity: 3,
                        linePriceWithTax: 1500,
                        productVariant: { id: '3', sku: 'SKU', price: 500 },
                    },
                ],
            }),
        ).toMatchObject({
            order: {
                id: '1',
                code: 'T_1',
                lines: [
                    {
                        id: '2',
                        quantity: 3,
                        productVariant: { id: '3', sku: 'SKU', price: 500 },
                    },
                ],
            },
        });

        const errorResult = { __typename: 'OrderLimitError', message: 'Limit reached' };
        expect(orderResult(errorResult)).toEqual({ result: errorResult });
    });

    it('builds public product list options without losing the query filter', async () => {
        const { publicProductListOptions } = await import('./tool-kit');

        expect(publicProductListOptions({ limit: 10, offset: 5, query: 'shoe' })).toEqual({
            take: 10,
            skip: 5,
            filter: {
                _or: [{ name: { contains: 'shoe' } }, { slug: { contains: 'shoe' } }],
                enabled: { eq: true },
            },
        });
    });

    describe('getActiveOrder', () => {
        it('returns undefined without fetching relations when no active order exists', async () => {
            const { getActiveOrder } = await import('./tool-kit');
            const activeOrderService = {
                getActiveOrder: vi.fn().mockResolvedValue(undefined),
            };
            const orderService = {
                findOne: vi.fn(),
            };

            const result = await getActiveOrder(
                {} as never,
                activeOrderService as never,
                orderService as never,
                false,
            );

            expect(result).toBeUndefined();
            expect(activeOrderService.getActiveOrder).toHaveBeenCalledWith({}, undefined, false);
            expect(orderService.findOne).not.toHaveBeenCalled();
        });

        it('returns the active order re-fetched with line and product variant relations', async () => {
            const { getActiveOrder } = await import('./tool-kit');
            const activeOrder = { id: '1', code: 'T_1' };
            const orderWithRelations = { ...activeOrder, lines: [] };
            const activeOrderService = {
                getActiveOrder: vi.fn().mockResolvedValue(activeOrder),
            };
            const orderService = {
                findOne: vi.fn().mockResolvedValue(orderWithRelations),
            };

            const result = await getActiveOrder(
                {} as never,
                activeOrderService as never,
                orderService as never,
                true,
            );

            expect(activeOrderService.getActiveOrder).toHaveBeenCalledWith({}, undefined, true);
            expect(orderService.findOne).toHaveBeenCalledWith({}, '1', ['lines', 'lines.productVariant']);
            expect(result).toBe(orderWithRelations);
        });

        it('falls back to the active order when the relation fetch finds no order', async () => {
            const { getActiveOrder } = await import('./tool-kit');
            const activeOrder = { id: '1', code: 'T_1' };
            const activeOrderService = {
                getActiveOrder: vi.fn().mockResolvedValue(activeOrder),
            };
            const orderService = {
                findOne: vi.fn().mockResolvedValue(undefined),
            };

            const result = await getActiveOrder(
                {} as never,
                activeOrderService as never,
                orderService as never,
                false,
            );

            expect(result).toBe(activeOrder);
        });
    });
});
