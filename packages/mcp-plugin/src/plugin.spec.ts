import { ProcessContext } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_OAUTH_OPTIONS } from './constants';
import { McpPlugin } from './plugin';
import { McpPluginOptions } from './types';
describe('McpPlugin production config guard', () => {
    let savedOptions: McpPluginOptions;
    let savedNodeEnv: string | undefined;

    beforeEach(() => {
        savedOptions = McpPlugin.options;
        savedNodeEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
        McpPlugin.options = savedOptions;
        process.env.NODE_ENV = savedNodeEnv;
    });

    function createPlugin(isServer: boolean): McpPlugin {
        const processContext = { isServer } as ProcessContext;
        return new McpPlugin(processContext);
    }

    function setOauth(oauth: McpPluginOptions['oauth']): void {
        McpPlugin.options = {
            toolExposure: 'direct',
            oauth: oauth && { ...DEFAULT_OAUTH_OPTIONS, ...oauth },
        };
    }

    it('throws in production when the issuer is a localhost URL', () => {
        process.env.NODE_ENV = 'production';
        setOauth({ tokenSecret: 'x', issuer: 'http://localhost:3500' });
        const plugin = createPlugin(true);
        expect(() => plugin.onApplicationBootstrap()).toThrow();
    });

    it('does not throw in production when issuer and storefrontConsentUrl are public URLs', () => {
        process.env.NODE_ENV = 'production';
        setOauth({
            tokenSecret: 'x',
            issuer: 'https://shop.example.com',
            storefrontConsentUrl: 'https://shop.example.com/mcp/authorize',
        });
        const plugin = createPlugin(true);
        expect(() => plugin.onApplicationBootstrap()).not.toThrow();
    });

    it('throws in production when the storefrontConsentUrl is a localhost URL', () => {
        process.env.NODE_ENV = 'production';
        setOauth({
            tokenSecret: 'x',
            issuer: 'https://shop.example.com',
            storefrontConsentUrl: 'http://localhost:3000/mcp/authorize',
        });
        const plugin = createPlugin(true);
        expect(() => plugin.onApplicationBootstrap()).toThrow();
    });

    it('does not throw when not running on the server process', () => {
        process.env.NODE_ENV = 'production';
        setOauth({ tokenSecret: 'x', issuer: 'http://localhost:3500' });
        const plugin = createPlugin(false);
        expect(() => plugin.onApplicationBootstrap()).not.toThrow();
    });

    it('does not throw when oauth is not configured', () => {
        process.env.NODE_ENV = 'production';
        setOauth(undefined);
        const plugin = createPlugin(true);
        expect(() => plugin.onApplicationBootstrap()).not.toThrow();
    });

    it('does not throw in development even with a localhost issuer', () => {
        process.env.NODE_ENV = 'development';
        setOauth({ tokenSecret: 'x', issuer: 'http://localhost:3500' });
        const plugin = createPlugin(true);
        expect(() => plugin.onApplicationBootstrap()).not.toThrow();
    });
});
