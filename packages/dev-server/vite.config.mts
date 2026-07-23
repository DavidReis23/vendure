import { vendureDashboardPlugin } from '@vendure/dashboard/vite';
import path from 'path';
import { pathToFileURL } from 'url';
import { defineConfig } from 'vite';

export default defineConfig({
    base: '/dashboard/',
    build: {
        outDir: './dist/dashboard',
    },
    plugins: [
        vendureDashboardPlugin({
            vendureConfigPath: pathToFileURL('./dev-config.ts'),
            api: {
                host: 'http://localhost',
                port: Number(process.env.API_PORT) || 3000,
            },
            gqlOutputPath: path.resolve(__dirname, './graphql/'),
            // In this monorepo, `@vendure/core` resolves through a workspace
            // symlink to `packages/core`, so the scanner's default node_modules
            // guess lands on the repo root instead of `node_modules`. Point it
            // at the real node_modules so symlinked workspace plugin packages
            // (e.g. `@vendure/mcp-plugin`) are recognised and their dashboard
            // extensions discovered from source.
            pluginPackageScanner: {
                nodeModulesRoot: path.resolve(__dirname, '../../node_modules'),
            },
        }),
    ],
});
