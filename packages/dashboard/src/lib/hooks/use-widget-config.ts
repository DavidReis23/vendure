import { getDashboardWidget } from '@/vdb/framework/dashboard-widget/widget-extensions.js';
import { WidgetInstanceContext } from '@/vdb/framework/dashboard-widget/widget-instance-context.js';
import { useUserSettings } from '@/vdb/hooks/use-user-settings.js';
import { useLingui } from '@lingui/react/macro';
import { useCallback, useContext, useMemo } from 'react';

/**
 * @description
 * Reads and persists the configuration for the current Insights widget instance.
 *
 * The returned config is the widget definition's `defaultConfig` merged with any
 * per-instance overrides the user has persisted. The returned setter merges a partial
 * update into the config and persists it immediately (independent of the "Save Layout"
 * action), so config changes such as a selected chart data type survive a page reload.
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
    const { instanceId, widgetId, layout } = context;
    const { settings, updateWidgetInstanceConfig } = useUserSettings();

    const defaultConfig = (getDashboardWidget(widgetId)?.defaultConfig ?? {}) as Partial<T>;
    const persisted = settings.widgetInstances?.find(instance => instance.instanceId === instanceId)
        ?.config as Partial<T> | undefined;

    const config = useMemo(() => ({ ...defaultConfig, ...persisted }) as T, [defaultConfig, persisted]);

    const setConfig = useCallback(
        (update: Partial<T>) => {
            updateWidgetInstanceConfig({
                instanceId,
                widgetId,
                layout,
                config: { ...config, ...update },
            });
        },
        [instanceId, widgetId, layout, config, updateWidgetInstanceConfig],
    );

    return [config, setConfig];
}
