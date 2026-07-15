import { DashboardWidgetDefinition } from './widgets.js';

/**
 * @description
 * Configuration for the Insights page, grouping all insights-related extension
 * options such as widgets and code-level widget exclusions.
 *
 * @docsCategory extensions-api
 * @docsPage defineDashboardExtension
 * @since 3.8.0
 */
export interface DashboardInsightsExtensionDefinition {
    /**
     * @description
     * Custom widgets to add to the Insights page.
     */
    widgets?: DashboardWidgetDefinition[];
    /**
     * @description
     * The ids of widgets that should be completely removed from the Insights page.
     * Excluded widgets are never rendered, never appear in the user-facing widget
     * picker, and cannot be re-enabled by a user setting. This works for both
     * built-in widgets and widgets registered by other extensions, regardless of
     * registration order.
     *
     * @example
     * ```ts
     * defineDashboardExtension({
     *     insights: {
     *         excludeWidgets: ['latest-orders-widget'],
     *     },
     * });
     * ```
     */
    excludeWidgets?: string[];
}
