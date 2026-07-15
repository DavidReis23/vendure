import { getDashboardWidget } from '@/vdb/framework/dashboard-widget/widget-extensions.js';
import { WidgetInstanceContext } from '@/vdb/framework/dashboard-widget/widget-instance-context.js';
import { useLingui } from '@lingui/react/macro';
import { useCallback, useContext, useMemo } from 'react';

/**
 * @description
 * Reads and persists the configuration for the current Insights widget instance.
 *
 * The returned config is the widget definition's `defaultConfig` merged with any
 * per-instance overrides. The returned setter merges a partial update into the config and
 * hands it to the Insights page, which decides where it is written: outside edit mode it
 * is persisted immediately (independent of the "Save Layout" action) so config changes
 * such as a selected chart data type survive a page reload; while the layout is being
 * edited it is held in draft state and committed together with the layout on "Save Layout".
 *
 * Must be used within an Insights page widget rendered by the dashboard.
 *
 * @example
 * ```tsx
 * type MyConfig = { dataType: 'count' | 'total' };
 *
 * export function MyWidget() {
 *     const [config, setConfig] = useWidgetConfig<MyConfig>();
 *     return (
 *         <button onClick={() => setConfig({ dataType: 'total' })}>
 *             {config.dataType}
 *         </button>
 *     );
 * }
 * ```
 *
 * @docsCategory hooks
 * @docsPage useWidgetConfig
 * @since 3.8.0
 */
export function useWidgetConfig<T extends Record<string, unknown>>(): [T, (update: Partial<T>) => void] {
    const { t } = useLingui();
    const context = useContext(WidgetInstanceContext);
    if (context === undefined) {
        throw new Error(t`useWidgetConfig must be used within an Insights page widget`);
    }
    const { widgetId, config: instanceConfig, setConfig: setInstanceConfig } = context;

    const defaultConfig = (getDashboardWidget(widgetId)?.defaultConfig ?? {}) as Partial<T>;
    const config = useMemo(
        () => ({ ...defaultConfig, ...instanceConfig }) as T,
        [defaultConfig, instanceConfig],
    );

    const setConfig = useCallback(
        (update: Partial<T>) => setInstanceConfig({ ...config, ...update }),
        [config, setInstanceConfig],
    );

    return [config, setConfig];
}
