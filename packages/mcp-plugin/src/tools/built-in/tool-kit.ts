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
import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import { isIP, type LookupFunction } from 'net';
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

// --- Remote asset fetching (SSRF-hardened) -------------------------------------------------------

const DEFAULT_MAX_ASSET_BYTES = 20 * 1024 * 1024;
const DEFAULT_ASSET_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ASSET_REDIRECTS = 5;

/**
 * Options for {@link fetchRemoteAsset}. The defaults are the secure production values; the injectable
 * `lookup`/`isBlockedAddress` seams exist so the SSRF guards can be exercised against a loopback
 * test server. Production callers pass nothing.
 */
export interface FetchRemoteAssetOptions {
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    isBlockedAddress?: (ip: string) => boolean;
    lookup?: LookupFunction;
}

type LookupAddress = { address: string; family: number };
type LookupAllCallback = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void;

/**
 * True when `ip` is a loopback, private, link-local, unique-local, multicast, or otherwise
 * non-public address (IPv4 and IPv6, including IPv4-mapped IPv6). Anything not clearly a public
 * address is treated as blocked.
 */
export function isBlockedIp(ip: string): boolean {
    const kind = isIP(ip);
    if (kind === 4) {
        return isBlockedIpv4(ip);
    }
    if (kind === 6) {
        return isBlockedIpv6(ip);
    }
    return true;
}

function isBlockedIpv4(ip: string): boolean {
    const parts = ip.split('.').map(part => Number(part));
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
        return true;
    }
    const [a, b] = parts;
    if (a === 0) return true; // "this host"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
    if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 0) return true; // IETF protocol assignments / TEST-NET-1
    if (a === 192 && b === 168) return true; // private
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
}

function isBlockedIpv6(ip: string): boolean {
    const address = ip.toLowerCase().split('%')[0]; // drop any zone id
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
    if (mapped) {
        return isBlockedIpv4(mapped[1]);
    }
    const groups = expandIpv6(address);
    if (!groups) {
        return true;
    }
    if (groups.every((group, index) => (index === 7 ? group === 1 : group === 0))) {
        return true; // ::1 loopback
    }
    if (groups.every(group => group === 0)) {
        return true; // :: unspecified
    }
    // Prefix ranges expressed arithmetically (the codebase bans bitwise operators).
    const first = groups[0];
    if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
    if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 unique-local
    if (first >= 0xff00) return true; // ff00::/8 multicast
    // IPv4-mapped/compatible forms (::ffff:a.b.c.d / ::a.b.c.d in hextet form): re-check the low 32 bits.
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0) {
        if (groups[5] === 0xffff || groups[5] === 0) {
            const v4 = [
                Math.floor(groups[6] / 256),
                groups[6] % 256,
                Math.floor(groups[7] / 256),
                groups[7] % 256,
            ].join('.');
            return isBlockedIpv4(v4);
        }
    }
    return false;
}

/** Expands an IPv6 string to its 8 numeric 16-bit groups, or null if it is not parseable. */
function expandIpv6(address: string): number[] | null {
    const doubleColon = address.indexOf('::');
    const headText = doubleColon === -1 ? address : address.slice(0, doubleColon);
    const tailText = doubleColon === -1 ? '' : address.slice(doubleColon + 2);
    const head = headText ? headText.split(':') : [];
    const tail = tailText ? tailText.split(':') : [];
    if (doubleColon === -1) {
        if (head.length !== 8) return null;
    } else if (head.length + tail.length > 7) {
        return null;
    }
    const missing = 8 - (head.length + tail.length);
    const parts = doubleColon === -1 ? head : [...head, ...Array<string>(missing).fill('0'), ...tail];
    const groups = parts.map(part => parseInt(part, 16));
    if (groups.length !== 8 || groups.some(group => Number.isNaN(group) || group < 0 || group > 0xffff)) {
        return null;
    }
    return groups;
}

/**
 * Wraps a DNS lookup so that every resolved address is validated before it is handed to the socket.
 * Because the address the socket connects to is the same one that was validated, DNS rebinding cannot
 * pass validation with a public IP and then connect to a private one.
 */
function createGuardedLookup(
    lookup: LookupFunction,
    isBlockedAddress: (ip: string) => boolean,
): LookupFunction {
    const underlying = lookup as unknown as (
        hostname: string,
        options: { all: true },
        callback: LookupAllCallback,
    ) => void;
    const guarded = (hostname: string, optionsOrCallback: unknown, maybeCallback?: unknown): void => {
        const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
        ) as LookupCallback;
        const wantsAll =
            typeof optionsOrCallback === 'object' &&
            optionsOrCallback !== null &&
            (optionsOrCallback as { all?: boolean }).all === true;
        underlying(hostname, { all: true }, (err, addresses) => {
            if (err) {
                callback(err);
                return;
            }
            if (!addresses.length) {
                callback(new Error(`Could not resolve host "${hostname}"`));
                return;
            }
            const blocked = addresses.find(entry => isBlockedAddress(entry.address));
            if (blocked) {
                callback(new Error(`Refusing to connect to non-public address ${blocked.address}`));
                return;
            }
            if (wantsAll) {
                (callback as unknown as LookupAllCallback)(null, addresses);
            } else {
                callback(null, addresses[0].address, addresses[0].family);
            }
        });
    };
    return guarded as unknown as LookupFunction;
}

type FetchOnceResult = { redirect: string } | { data: Buffer };

/** Performs a single guarded GET, returning either a redirect target or the (size-capped) body. */
function fetchOnce(
    target: URL,
    lookup: LookupFunction,
    timeoutMs: number,
    maxBytes: number,
): Promise<FetchOnceResult> {
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise<FetchOnceResult>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void): void => {
            if (!settled) {
                settled = true;
                action();
            }
        };
        const request = transport.request(target, { method: 'GET', lookup, timeout: timeoutMs }, response => {
            const status = response.statusCode ?? 0;
            const location = response.headers.location;
            if (status >= 300 && status < 400 && location) {
                response.resume();
                finish(() => resolve({ redirect: location }));
                return;
            }
            if (status < 200 || status >= 300) {
                response.resume();
                finish(() => reject(new Error(`Unable to fetch asset URL: ${status}`)));
                return;
            }
            const declared = Number(response.headers['content-length']);
            if (Number.isFinite(declared) && declared > maxBytes) {
                response.destroy();
                finish(() => reject(new Error(`Asset exceeds the maximum size of ${maxBytes} bytes`)));
                return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            response.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > maxBytes) {
                    response.destroy();
                    finish(() => reject(new Error(`Asset exceeds the maximum size of ${maxBytes} bytes`)));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => finish(() => resolve({ data: Buffer.concat(chunks) })));
            response.on('error', error => finish(() => reject(error)));
        });
        request.on('timeout', () => request.destroy(new Error('Timed out fetching asset URL')));
        request.on('error', error => finish(() => reject(error)));
        request.end();
    });
}

function parseHttpUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`Invalid asset URL: ${value}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Unsupported asset URL scheme "${url.protocol}" (only http and https are allowed)`);
    }
    return url;
}

/**
 * Fetches a remote asset over HTTP(S) with SSRF protections: scheme validation, per-hop rejection of
 * private/reserved destinations (IPv4 and IPv6) enforced on the actual connection, redirect
 * re-validation, a request timeout, and a hard byte cap (independent of a possibly-missing or lying
 * Content-Length). Returns the fetched bytes and the final resolved URL.
 */
export async function fetchRemoteAsset(
    url: string,
    options: FetchRemoteAssetOptions = {},
): Promise<{ data: Buffer; sourceUrl: string }> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_ASSET_BYTES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_ASSET_FETCH_TIMEOUT_MS;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_ASSET_REDIRECTS;
    const isBlockedAddress = options.isBlockedAddress ?? isBlockedIp;
    const lookup = createGuardedLookup(options.lookup ?? dns.lookup, isBlockedAddress);

    let current = parseHttpUrl(url);
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
        // A literal-IP host bypasses DNS (the guarded lookup never runs), so validate it directly.
        // URL.hostname keeps the brackets on IPv6 literals (e.g. "[::1]"), so strip them first.
        const literalHost = current.hostname.replace(/^\[(.+)\]$/, '$1');
        if (isIP(literalHost) && isBlockedAddress(literalHost)) {
            throw new Error(`Refusing to connect to non-public address ${literalHost}`);
        }
        const result = await fetchOnce(current, lookup, timeoutMs, maxBytes);
        if ('data' in result) {
            return { data: result.data, sourceUrl: current.toString() };
        }
        current = parseHttpUrl(new URL(result.redirect, current).toString());
    }
    throw new Error(`Too many redirects fetching asset URL (max ${maxRedirects})`);
}

export async function uploadAssetFromUrl(
    ctx: RequestContext,
    url: string,
    assetService: AssetService,
    options: FetchRemoteAssetOptions = {},
) {
    const { data, sourceUrl } = await fetchRemoteAsset(url, options);
    return assetService.createFromFileStream(Readable.from(data), sourceUrl, ctx);
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
