import { getDashboardWidget } from '@/vdb/framework/dashboard-widget/widget-extensions.js';
import { WidgetInstanceContext } from '@/vdb/framework/dashboard-widget/widget-instance-context.js';
import { useLingui } from '@lingui/react/macro';
import { useCallback, useContext, useMemo, useRef } from 'react';

// Shared stable reference used when a widget definition has no `defaultConfig`, so the
// `config` memo below does not re-run every render on a fresh `{}` literal.
const EMPTY_CONFIG = Object.freeze({});

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

    // The registry returns a stable definition object, so `defaultConfig` keeps a stable
    // identity across renders (and falls back to the shared `EMPTY_CONFIG` when unset),
    // which keeps the `config` memo from re-running on every render.
    const defaultConfig = (getDashboardWidget(widgetId)?.defaultConfig ?? EMPTY_CONFIG) as Partial<T>;
    const config = useMemo(
        () => ({ ...defaultConfig, ...instanceConfig }) as T,
        [defaultConfig, instanceConfig],
    );

    // Read the latest config and setter through refs so `setConfig` keeps a stable identity
    // across renders — widgets can safely list it in effect dependency arrays without
    // re-running those effects on every render.
    const configRef = useRef(config);
    configRef.current = config;
    const setInstanceConfigRef = useRef(setInstanceConfig);
    setInstanceConfigRef.current = setInstanceConfig;

    const setConfig = useCallback(
        (update: Partial<T>) => setInstanceConfigRef.current({ ...configRef.current, ...update }),
        [],
    );

    return [config, setConfig];
}
