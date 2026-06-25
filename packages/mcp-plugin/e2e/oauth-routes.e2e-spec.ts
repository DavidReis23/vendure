import { mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { McpPlugin } from '../src/plugin';

describe('McpPlugin OAuth routes', () => {
    const config = mergeConfig(testConfig(), {
        plugins: [McpPlugin.init({ oauth: { tokenSecret: 'test-secret' } })],
    });
    const { server } = createTestEnvironment(config);

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products.csv'),
            customerCount: 1,
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('GET /.well-known/oauth-authorization-server returns 200 with required fields', async () => {
        const port = config.apiOptions.port;
        const res = await fetch(`http://localhost:${port}/.well-known/oauth-authorization-server`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('issuer');
        expect(body).toHaveProperty('token_endpoint');
        expect(body.code_challenge_methods_supported).toEqual(['S256']);
    });
});
