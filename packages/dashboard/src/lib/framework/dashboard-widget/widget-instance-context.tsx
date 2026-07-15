import { createContext, PropsWithChildren } from 'react';

/**
 * @description
 * The identity and layout of the Insights widget instance currently being rendered.
 * Provided per widget instance on the Insights page so that hooks such as
 * `useWidgetConfig` can resolve and persist per-instance state.
 */
export interface WidgetInstanceContextValue {
    instanceId: string;
    widgetId: string;
    layout: { x: number; y: number; w: number; h: number };
}

export const WidgetInstanceContext = createContext<WidgetInstanceContextValue | undefined>(undefined);

export function WidgetInstanceProvider({
    children,
    value,
}: PropsWithChildren<{ value: WidgetInstanceContextValue }>) {
    return <WidgetInstanceContext.Provider value={value}>{children}</WidgetInstanceContext.Provider>;
}
