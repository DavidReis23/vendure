import { describe, expect, it, vi } from 'vitest';

const expectedExports = [
    'getActiveOrder',
    'listOptions',
    'orderListOptions',
    'orderResult',
    'page',
    'productListOptions',
    'publicCollectionListOptions',
    'publicProductListOptions',
];

describe('built-in order helpers', () => {
    it('exports only the helpers consumed by the shipped tools', async () => {
        const orderHelpers = await import('./order-helpers');

        expect(Object.keys(orderHelpers).sort()).toEqual(expectedExports);
        expect(Object.values(orderHelpers).every(value => typeof value === 'function')).toBe(true);
    });

    it('serializes order results and preserves Vendure error results', async () => {
        const { orderResult } = await import('./order-helpers');

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
        const { publicProductListOptions } = await import('./order-helpers');

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
            const { getActiveOrder } = await import('./order-helpers');
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
            expect(activeOrderService.getActiveOrder).toHaveBeenCalledWith({}, undefined);
            expect(orderService.findOne).not.toHaveBeenCalled();
        });

        it('returns the active order re-fetched with line and product variant relations', async () => {
            const { getActiveOrder } = await import('./order-helpers');
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
            const { getActiveOrder } = await import('./order-helpers');
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
