import { OrderListOptions } from '@vendure/common/lib/generated-types';
import {
    ActiveOrderService,
    AssetService,
    Collection,
    ID,
    ListQueryOptions,
    Order,
    OrderService,
    Product,
    ProductVariant,
    RequestContext,
    VendureEntity,
} from '@vendure/core';
import { Readable } from 'stream';

type Input = Record<string, unknown>;

export async function getActiveOrder(
    ctx: RequestContext,
    activeOrderService: ActiveOrderService,
    orderService: OrderService,
    createIfNotExists: boolean,
): Promise<Order | undefined> {
    const findActiveOrder = activeOrderService.getActiveOrder.bind(activeOrderService) as (
        ctx: RequestContext,
        input: undefined,
        createIfNotExists: boolean,
    ) => Promise<Order | undefined>;
    const order = await findActiveOrder(ctx, undefined, createIfNotExists);
    if (!order) {
        return undefined;
    }
    return (await orderService.findOne(ctx, order.id, ['lines', 'lines.productVariant'])) ?? order;
}

export function orderResult(result: unknown) {
    if (isRecord(result) && 'message' in result && '__typename' in result) {
        return { result };
    }
    return { order: orderSummary(result as Order | undefined) };
}

export function productSummary(
    product: (Product & { name?: string; slug?: string; description?: string }) | undefined | null,
) {
    if (!product) return null;
    return {
        id: product.id,
        name: product.name,
        slug: product.slug,
        description: product.description,
        enabled: product.enabled,
        featuredAsset: product.featuredAsset ? assetSummary(product.featuredAsset) : null,
    };
}

export function variantSummary(variant: (ProductVariant & { name?: string }) | undefined | null) {
    if (!variant) return null;
    return {
        id: variant.id,
        name: variant.name,
        sku: variant.sku,
        enabled: variant.enabled,
        price: variant.price,
        priceWithTax: variant.priceWithTax,
    };
}

export function collectionSummary(
    collection:
        | { id: ID; name?: string; slug?: string; description?: string; featuredAsset?: unknown }
        | undefined
        | null,
) {
    if (!collection) return null;
    return {
        id: collection.id,
        name: collection.name,
        slug: collection.slug,
        description: collection.description,
        featuredAsset: collection.featuredAsset ? assetSummary(collection.featuredAsset) : null,
    };
}

export function orderSummary(order: Order | undefined | null) {
    if (!order) return null;
    return {
        id: order.id,
        code: order.code,
        state: order.state,
        active: order.active,
        total: order.total,
        totalWithTax: order.totalWithTax,
        currencyCode: order.currencyCode,
        totalQuantity: order.totalQuantity,
        lines:
            order.lines?.map(line => ({
                id: line.id,
                quantity: line.quantity,
                linePriceWithTax: line.linePriceWithTax,
                productVariant: line.productVariant ? variantSummary(line.productVariant) : null,
            })) ?? [],
    };
}

export function customerSummary(
    customer:
        | { id?: ID; firstName?: string; lastName?: string; emailAddress?: string; phoneNumber?: string }
        | undefined
        | null,
) {
    if (!customer || !('id' in customer)) return null;
    return {
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        emailAddress: customer.emailAddress,
        phoneNumber: customer.phoneNumber,
    };
}

export function customerSummaryResult(customer: unknown) {
    if (isRecord(customer) && '__typename' in customer && 'message' in customer) {
        return null;
    }
    return customerSummary(
        customer as
            | {
                  id?: ID;
                  firstName?: string;
                  lastName?: string;
                  emailAddress?: string;
                  phoneNumber?: string;
              }
            | undefined
            | null,
    );
}

export function assetSummary(asset: unknown) {
    if (!isRecord(asset)) return null;
    return {
        id: asset.id,
        name: asset.name,
        type: asset.type,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        fileSize: asset.fileSize,
        source: asset.source,
        preview: asset.preview,
        focalPoint: asset.focalPoint,
        tags: Array.isArray(asset.tags)
            ? asset.tags.map(tag => (isRecord(tag) ? tag.value : tag))
            : undefined,
    };
}

export function page<T>(items: T[], totalItems: number, input: Input) {
    const offset = number(input.offset, 0);
    return { items, total: totalItems, hasMore: offset + items.length < totalItems };
}

export function listOptions<T extends VendureEntity>(input: Input): ListQueryOptions<T> {
    return {
        take: number(input.limit, 25),
        skip: number(input.offset, 0),
    } as ListQueryOptions<T>;
}

export function productListOptions(input: Input): ListQueryOptions<Product> {
    const options = listOptions<Product>(input);
    const query = string(input.query).trim();
    if (!query) {
        return options;
    }
    return {
        ...options,
        filter: {
            _or: [{ name: { contains: query } }, { slug: { contains: query } }],
        },
    } as ListQueryOptions<Product>;
}

export function publicProductListOptions(input: Input): ListQueryOptions<Product> {
    const options = productListOptions(input);
    return {
        ...options,
        filter: {
            ...options.filter,
            enabled: { eq: true },
        },
    } as ListQueryOptions<Product>;
}

export function publicCollectionListOptions(input: Input): ListQueryOptions<Collection> {
    const options = listOptions<Collection>(input);
    return {
        ...options,
        filter: {
            ...options.filter,
            isPrivate: { eq: false },
        },
    } as ListQueryOptions<Collection>;
}

export function orderListOptions(input: Input): OrderListOptions {
    return {
        take: number(input.limit, 25),
        skip: number(input.offset, 0),
    };
}

export async function uploadAssetFromUrl(ctx: RequestContext, url: string, assetService: AssetService) {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
        throw new Error(`Unable to fetch asset URL: ${response.status}`);
    }
    const stream = Readable.fromWeb(response.body as import('stream/web').ReadableStream<Uint8Array>);
    return assetService.createFromFileStream(stream, url, ctx);
}

export function id(value: unknown): ID {
    return string(value);
}

export function orderState(value: unknown): Parameters<OrderService['transitionToState']>[2] {
    return string(value) as Parameters<OrderService['transitionToState']>[2];
}

export function idArray(value: unknown): ID[] {
    return Array.isArray(value) ? value.map(item => id(item)) : [];
}

export function string(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export function number(value: unknown, fallback = 0): number {
    return typeof value === 'number' ? value : fallback;
}

export function object(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
