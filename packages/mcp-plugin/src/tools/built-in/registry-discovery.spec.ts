import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
    ActiveOrderService,
    CollectionService,
    ConfigService,
    CustomerService,
    OrderService,
    ProductService,
    SettingsStoreService,
} from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';

import { MCP_PLUGIN_OPTIONS } from '../../constants';
import { McpToolRegistryService } from '../../registry/mcp-tool-registry.service';
import { McpOperationsService } from '../../services/mcp-operations.service';

import { mcpBuiltInToolProviders } from './providers';

const shopToolNames = [
    'add_to_cart',
    'apply_coupon_code',
    'get_cart',
    'get_collection',
    'get_eligible_payment_methods',
    'get_eligible_shipping_methods',
    'get_my_account',
    'get_order',
    'get_product',
    'list_collections',
    'list_my_orders',
    'place_order',
    'remove_coupon_code',
    'remove_from_cart',
    'search_products',
    'set_billing_address',
    'set_shipping_address',
    'set_shipping_method',
    'update_cart_line',
];

describe('built-in registry discovery', () => {
    it('bootstraps Nest providers and discovers exactly the 19 shop tools', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [DiscoveryModule],
            providers: [
                ...mcpBuiltInToolProviders,
                McpToolRegistryService,
                { provide: ActiveOrderService, useValue: {} },
                { provide: CollectionService, useValue: {} },
                { provide: ConfigService, useValue: {} },
                { provide: CustomerService, useValue: {} },
                { provide: OrderService, useValue: {} },
                { provide: ProductService, useValue: {} },
                { provide: SettingsStoreService, useValue: { get: vi.fn(), set: vi.fn() } },
                { provide: McpOperationsService, useValue: {} },
                { provide: MCP_PLUGIN_OPTIONS, useValue: {} },
            ],
        }).compile();

        try {
            await moduleRef.init();
            const registry = moduleRef.get(McpToolRegistryService);
            expect(
                registry
                    .getRegistrySnapshot()
                    .filter(tool => tool.toolset === 'shop')
                    .map(tool => tool.name)
                    .sort(),
            ).toEqual(shopToolNames);
        } finally {
            await moduleRef.close();
        }
    });
});
