import { getConfigurationFunction, Logger, ProcessContext } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('McpPlugin logging options + retention task', () => {
    let savedOptions: McpPluginOptions;

    beforeEach(() => {
        savedOptions = McpPlugin.options;
    });
    afterEach(() => {
        McpPlugin.options = savedOptions;
    });

    /** Runs the plugin's real `configuration` hook against a minimal config and returns it. */
    async function runConfiguration() {
        const config = {
            authOptions: { customPermissions: [] },
            settingsStoreFields: {},
            schedulerOptions: { tasks: [] },
        } as any;
        await getConfigurationFunction(McpPlugin)?.(config);
        return config;
    }

    /** Resolves a ScheduledTask's (function-form) schedule to "H:M" without cron-time-generator. */
    function resolveDayTime(task: any): string {
        const schedule = task.options.schedule as (cron: {
            everyDayAt: (h: number, m: number) => string;
        }) => string;
        return schedule({ everyDayAt: (h, m) => `${h}:${m}` });
    }

    it("applies logging defaults (ttlDays 30, capture 'metadata', 02:30 retention) when omitted", async () => {
        McpPlugin.init({});
        expect(McpPlugin.options.logging?.ttlDays).toBe(30);
        expect(McpPlugin.options.logging?.capture).toBe('metadata');
        const config = await runConfiguration();
        const task = config.schedulerOptions.tasks.find((t: any) => t.id === 'mcp-tool-call-log-retention');
        expect(task).toBeDefined();
        expect(resolveDayTime(task)).toBe('2:30');
    });

    it('registers the retention task with the configured schedule (configured wins over default)', async () => {
        McpPlugin.init({ logging: { retentionSchedule: cron => cron.everyDayAt(4, 15) } });
        const config = await runConfiguration();
        const task = config.schedulerOptions.tasks.find((t: any) => t.id === 'mcp-tool-call-log-retention');
        expect(resolveDayTime(task)).toBe('4:15');
    });

    it("honours a custom ttlDays and capture: 'full'", () => {
        McpPlugin.init({ logging: { ttlDays: 7, capture: 'full' } });
        expect(McpPlugin.options.logging?.ttlDays).toBe(7);
        expect(McpPlugin.options.logging?.capture).toBe('full');
    });

    it("warns at bootstrap when capture is 'full' without a redact function", () => {
        McpPlugin.init({ logging: { capture: 'full' } });
        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        new McpPlugin({ isServer: true } as ProcessContext).onApplicationBootstrap();
        expect(warnSpy).toHaveBeenCalledOnce();
        warnSpy.mockRestore();
    });

    it("does not warn when capture is 'full' with a redact function", () => {
        McpPlugin.init({ logging: { capture: 'full', redact: ({ input, output }) => ({ input, output }) } });
        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        new McpPlugin({ isServer: true } as ProcessContext).onApplicationBootstrap();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('does not warn under the default metadata capture', () => {
        McpPlugin.init({});
        const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        new McpPlugin({ isServer: true } as ProcessContext).onApplicationBootstrap();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});
