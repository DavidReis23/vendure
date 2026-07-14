import type { AssetService, RequestContext } from '@vendure/core';
import * as http from 'http';
import { AddressInfo, isIP, type LookupFunction } from 'net';
import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchRemoteAsset, isBlockedIp, uploadAssetFromUrl } from './tool-kit';

interface TestServer {
    port: number;
    close: () => Promise<void>;
}

const openServers: TestServer[] = [];

function startServer(handler: http.RequestListener): Promise<TestServer> {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port;
            const testServer: TestServer = {
                port,
                close: () =>
                    new Promise<void>(res => {
                        server.closeAllConnections?.();
                        server.close(() => res());
                    }),
            };
            openServers.push(testServer);
            resolve(testServer);
        });
    });
}

/** A DNS lookup that maps hostnames to fixed IPs (for driving the guards against a loopback server). */
function hostLookup(map: Record<string, string>): LookupFunction {
    return ((hostname: string, _options: unknown, callback: unknown) => {
        const cb = callback as (err: Error | null, addresses?: unknown) => void;
        const ip = map[hostname];
        if (!ip) {
            cb(new Error(`no test mapping for ${hostname}`));
            return;
        }
        cb(null, [{ address: ip, family: isIP(ip) || 4 }]);
    }) as unknown as LookupFunction;
}

// In the network tests, the loopback test server (127.0.0.1) must be reachable, so the "blocked"
// sentinel is the 10.x range instead. The real isBlockedIp classifier is tested separately below.
const blockTenDotRange = (ip: string): boolean => ip.startsWith('10.');

afterEach(async () => {
    while (openServers.length) {
        await openServers.pop()?.close();
    }
    vi.restoreAllMocks();
});

describe('isBlockedIp classifier', () => {
    it.each([
        '0.0.0.0',
        '127.0.0.1',
        '10.0.0.1',
        '10.255.255.255',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.1',
        '169.254.169.254',
        '100.64.0.1',
        '::1',
        '0:0:0:0:0:0:0:1',
        '::ffff:127.0.0.1',
        '::ffff:10.0.0.1',
        'fe80::1',
        'fc00::1',
        'fd12:3456:789a:1::1',
        'ff02::1',
    ])('blocks the non-public address %s', ip => {
        expect(isBlockedIp(ip)).toBe(true);
    });

    it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111'])(
        'allows the public address %s',
        ip => {
            expect(isBlockedIp(ip)).toBe(false);
        },
    );
});

describe('fetchRemoteAsset SSRF guards', () => {
    it('rejects an unsupported URL scheme', async () => {
        await expect(fetchRemoteAsset('file:///etc/passwd')).rejects.toThrow(/scheme/);
    });

    it('rejects a direct request to a loopback/private literal IP (real guard)', async () => {
        await expect(fetchRemoteAsset('http://127.0.0.1:9/')).rejects.toThrow(/non-public/);
        await expect(fetchRemoteAsset('http://[::1]:9/')).rejects.toThrow(/non-public/);
        await expect(fetchRemoteAsset('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
            /non-public/,
        );
    });

    it('rejects a redirect that points at a private host', async () => {
        const server = await startServer((_req, res) => {
            res.writeHead(302, { location: 'http://internal.evil/secret' });
            res.end();
        });
        await expect(
            fetchRemoteAsset(`http://origin.example:${server.port}/`, {
                lookup: hostLookup({ 'origin.example': '127.0.0.1', 'internal.evil': '10.0.0.5' }),
                isBlockedAddress: blockTenDotRange,
            }),
        ).rejects.toThrow(/non-public/);
    });

    it('refuses when the resolved address is private, closing the DNS-rebinding gap', async () => {
        const lookup = vi.fn(((_hostname: string, _options: unknown, callback: unknown) => {
            (callback as (err: Error | null, addresses: unknown) => void)(null, [
                { address: '10.0.0.9', family: 4 },
            ]);
        }) as unknown as LookupFunction);

        await expect(
            fetchRemoteAsset('http://rebind.example/', { lookup, isBlockedAddress: blockTenDotRange }),
        ).rejects.toThrow(/non-public/);
        // The connected address is the one that was validated — resolved exactly once, no TOCTOU window.
        expect(lookup).toHaveBeenCalledTimes(1);
    });

    it('rejects when the server does not respond within the timeout', async () => {
        const server = await startServer(() => {
            // Never respond.
        });
        await expect(
            fetchRemoteAsset(`http://slow.example:${server.port}/`, {
                lookup: hostLookup({ 'slow.example': '127.0.0.1' }),
                isBlockedAddress: blockTenDotRange,
                timeoutMs: 150,
            }),
        ).rejects.toThrow(/Timed out/);
    });

    it('rejects a response whose declared Content-Length exceeds the cap', async () => {
        const server = await startServer((_req, res) => {
            res.writeHead(200, { 'content-length': '1000' });
            res.end(Buffer.alloc(1000));
        });
        await expect(
            fetchRemoteAsset(`http://big.example:${server.port}/`, {
                lookup: hostLookup({ 'big.example': '127.0.0.1' }),
                isBlockedAddress: blockTenDotRange,
                maxBytes: 100,
            }),
        ).rejects.toThrow(/maximum size/);
    });

    it('caps the streamed size even without a Content-Length header', async () => {
        const server = await startServer((_req, res) => {
            // Chunked (no content-length): the byte cap must still fire mid-stream.
            res.writeHead(200);
            res.write(Buffer.alloc(80));
            res.write(Buffer.alloc(80));
            res.end();
        });
        await expect(
            fetchRemoteAsset(`http://chunked.example:${server.port}/`, {
                lookup: hostLookup({ 'chunked.example': '127.0.0.1' }),
                isBlockedAddress: blockTenDotRange,
                maxBytes: 100,
            }),
        ).rejects.toThrow(/maximum size/);
    });

    it('accepts a normal response over a validated public host', async () => {
        const body = Buffer.from('pretend-image-bytes');
        const server = await startServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'image/png' });
            res.end(body);
        });
        const result = await fetchRemoteAsset(`http://assets.example:${server.port}/logo.png`, {
            lookup: hostLookup({ 'assets.example': '127.0.0.1' }),
            isBlockedAddress: blockTenDotRange,
        });
        expect(result.data.equals(body)).toBe(true);
        expect(result.sourceUrl).toContain('assets.example');
    });
});

describe('uploadAssetFromUrl', () => {
    it('creates an asset from the fetched stream over a validated public host', async () => {
        const body = Buffer.from('pretend-image-bytes');
        const server = await startServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'image/png' });
            res.end(body);
        });
        const createFromFileStream = vi.fn().mockResolvedValue({ id: 'A_1', name: 'logo.png' });
        const assetService = { createFromFileStream } as unknown as AssetService;

        const result = await uploadAssetFromUrl(
            {} as unknown as RequestContext,
            `http://assets.example:${server.port}/logo.png`,
            assetService,
            { lookup: hostLookup({ 'assets.example': '127.0.0.1' }), isBlockedAddress: blockTenDotRange },
        );

        expect(createFromFileStream).toHaveBeenCalledOnce();
        const [stream, filePath] = createFromFileStream.mock.calls[0];
        expect(stream).toBeInstanceOf(Readable);
        expect(filePath).toContain('assets.example');
        expect(result).toEqual({ id: 'A_1', name: 'logo.png' });
    });
});
