import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

export const MCP_ACCEPT = 'application/json, text/event-stream';

export interface McpHttpResult {
    status: number;
    headers: Headers;
    /** Parsed JSON-RPC response (from a JSON or single-frame SSE body), or undefined for empty bodies. */
    body: any;
    text: string;
}

export interface PostMcpOptions {
    token?: string;
    accept?: string;
    contentType?: string | null;
    protocolVersion?: string | null;
    /** Extra request headers (e.g. session/channel tokens, Host, Origin). */
    headers?: Record<string, string>;
}

/** JSON-RPC request envelope. */
export function rpc(method: string, params?: unknown, id: number | string | null = 1) {
    return { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
}

/** initialize request params. */
export function initializeParams(protocolVersion: string = LATEST_PROTOCOL_VERSION) {
    return {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'mcp-e2e', version: '1.0.0' },
    };
}

/** Parses an MCP HTTP response body, handling both `application/json` and single-frame SSE. */
function parseBody(text: string, contentType: string): any {
    if (!text) {
        return undefined;
    }
    if (contentType.includes('text/event-stream')) {
        // Collect every `data:` frame. A single frame → its object; multiple frames (a JSON-RPC
        // batch) → the array of objects the client reassembles.
        const frames = text
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => JSON.parse(line.slice('data:'.length).trim()));
        if (frames.length === 0) {
            return undefined;
        }
        return frames.length === 1 ? frames[0] : frames;
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** POSTs a JSON-RPC message to `/mcp/{toolset}` and returns the parsed result. */
export async function postMcp(
    baseUrl: string,
    toolset: 'shop' | 'admin',
    message: unknown,
    options: PostMcpOptions = {},
): Promise<McpHttpResult> {
    const headers: Record<string, string> = {
        Accept: options.accept ?? MCP_ACCEPT,
        ...options.headers,
    };
    if (options.contentType !== null) {
        headers['Content-Type'] = options.contentType ?? 'application/json';
    }
    if (options.token) {
        headers.Authorization = `Bearer ${options.token}`;
    }
    // Send a protocol-version header on non-initialize calls unless explicitly overridden.
    const isInitialize = !Array.isArray(message) && (message as any)?.method === 'initialize';
    if (options.protocolVersion !== null && !isInitialize) {
        headers['MCP-Protocol-Version'] = options.protocolVersion ?? LATEST_PROTOCOL_VERSION;
    } else if (options.protocolVersion) {
        headers['MCP-Protocol-Version'] = options.protocolVersion;
    }
    const response = await fetch(`${baseUrl}/mcp/${toolset}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
    });
    const text = await response.text();
    return {
        status: response.status,
        headers: response.headers,
        text,
        body: parseBody(text, response.headers.get('content-type') ?? ''),
    };
}
