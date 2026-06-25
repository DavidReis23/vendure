import { DiscoveryService } from '@nestjs/core';
import { mergeConfig } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { McpPlugin } from '../src/plugin';

describe('McpPlugin bootstrap', () => {
    const { server } = createTestEnvironment(
        mergeConfig(testConfig(), {
            plugins: [McpPlugin.init({})],
        }),
    );

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

    it('boots a Vendure app with McpPlugin registered', () => {
        expect(server.app).toBeDefined();
        expect(McpPlugin.options.toolExposure).toBe('discovery');
    });

    it('DiscoveryService is injectable from the running app', () => {
        const discoveryService = server.app.get(DiscoveryService);
        expect(discoveryService).toBeDefined();
        expect(typeof discoveryService.getProviders).toBe('function');
    });
});
