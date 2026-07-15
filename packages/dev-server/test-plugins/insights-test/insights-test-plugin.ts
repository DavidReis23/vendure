import { VendurePlugin } from '@vendure/core';

/**
 * A test plugin that exercises every Insights extension API added in the
 * insights-page-improvements work:
 *
 * - a custom widget registered via `insights.widgets` with `defaultConfig`
 *   plus a control persisted through `useWidgetConfig`
 * - a multi-instance widget (`allowMultipleInstances: true`) whose instances
 *   are differentiated purely via their persisted config
 * - a global filter registered via `insights.filters` that a demo widget reads
 *   through `useWidgetFilters()`
 * - a commented-out `insights.excludeWidgets` example targeting a built-in widget
 *
 * See `./dashboard/index.tsx` for the dashboard extension entry point.
 */
@VendurePlugin({
    dashboard: './dashboard/index.tsx',
})
export class InsightsTestPlugin {}
