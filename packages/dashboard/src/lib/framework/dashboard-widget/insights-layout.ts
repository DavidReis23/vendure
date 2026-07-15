import { findNextAvailablePosition } from '@/vdb/components/ui/grid-layout.js';
import type {
    DashboardWidgetDefinition,
    DashboardWidgetInstance,
} from '@/vdb/framework/extension-api/types/widgets.js';
import type { UserSettings } from '@/vdb/providers/user-settings.js';

/**
 * Builds a widget instance from its definition, applying a saved layout when present and
 * otherwise falling back to the definition's default/min/max size. `instanceId` equals the
 * `widgetId` for single-instance widgets (which keeps migration from the legacy layout
 * stable) and is a freshly-generated id for additional multi-instance instances.
 */
export const buildWidgetInstance = (
    widget: DashboardWidgetDefinition,
    instanceId: string,
    savedLayout?: { x?: number; y?: number; w?: number; h?: number },
    config?: Record<string, unknown>,
): DashboardWidgetInstance => {
    const defaultSize = {
        w: widget.defaultSize.w ?? 4,
        h: widget.defaultSize.h ?? 3,
    };
    const minSize = {
        w: widget.minSize?.w ?? defaultSize.w,
        h: widget.minSize?.h ?? defaultSize.h,
    };
    return {
        id: instanceId,
        widgetId: widget.id,
        layout: {
            w: savedLayout?.w ?? defaultSize.w,
            h: savedLayout?.h ?? defaultSize.h,
            x: savedLayout?.x ?? widget.defaultSize.x ?? 0,
            y: savedLayout?.y ?? widget.defaultSize.y ?? 0,
            minW: minSize.w,
            minH: minSize.h,
            maxW: widget.maxSize?.w,
            maxH: widget.maxSize?.h,
        },
        config,
    };
};

export interface InitialWidgetState {
    visible: DashboardWidgetInstance[];
    hidden: DashboardWidgetInstance[];
    loadedWidgetIds: string[];
}

/**
 * Builds the initial visible/hidden widget draft state from persisted user settings.
 *
 * This is a pure function of (settings, registered widgets) so it can be unit-tested and,
 * critically, so the Insights page can run it as a **one-shot initializer** — once when
 * settings become ready, and again only when the set of permitted widgets changes.
 *
 * It must NOT be re-run on every `settings.widgetInstances` write. Widget config is
 * persisted immediately via `updateWidgetInstanceConfig`, which mutates
 * `settings.widgetInstances`. Rebuilding draft state from settings on those writes would
 * discard the user's unsaved edit-mode draft (dragged positions, hidden widgets, and
 * never-saved multi-instance widgets that have no persisted entry to rebuild from).
 * Decoupling initialization from config writes is what keeps the draft intact.
 */
export function buildInitialWidgetState(
    settings: Pick<UserSettings, 'widgetInstances' | 'widgetLayout' | 'hiddenWidgets'>,
    registered: Array<[string, DashboardWidgetDefinition]>,
): InitialWidgetState {
    // Saved instances are the source of truth. A widget may have several persisted
    // instances (multi-instance). The legacy `widgetLayout` record is read only as a
    // fallback so existing single-instance layouts migrate transparently.
    const persistedInstances = settings.widgetInstances ?? [];
    const legacyLayouts = settings.widgetLayout ?? {};
    // Stale ids (widgets that are no longer registered) are naturally ignored because we
    // only iterate over currently-registered widgets below.
    const hiddenIds = new Set(settings.hiddenWidgets ?? []);

    const visible: DashboardWidgetInstance[] = [];
    const hidden: DashboardWidgetInstance[] = [];

    registered.forEach(([id, widget]) => {
        const persistedForWidget = persistedInstances.filter(
            persistedInstance => persistedInstance.widgetId === id,
        );
        const isHidden = hiddenIds.has(id);

        if (persistedForWidget.length > 0) {
            // Restore each persisted instance at its saved position/size and config.
            persistedForWidget.forEach(persistedInstance => {
                (isHidden ? hidden : visible).push(
                    buildWidgetInstance(
                        widget,
                        persistedInstance.instanceId,
                        persistedInstance.layout,
                        persistedInstance.config,
                    ),
                );
            });
            return;
        }

        const legacyLayout = legacyLayouts[id];

        if (isHidden) {
            // A hidden widget with no saved instances. Keep a restorable default instance
            // only for single-instance widgets; multi-instance widgets carry no default
            // instance and are re-added as fresh instances from the picker.
            if (!widget.allowMultipleInstances) {
                hidden.push(buildWidgetInstance(widget, id, legacyLayout));
            }
            return;
        }

        // Newly-registered / default-visible widget: create its default instance, placing
        // it at the first free slot (scanning from the top) unless a legacy layout supplies
        // a saved position.
        const instance = buildWidgetInstance(widget, id, legacyLayout);
        if (!legacyLayout) {
            const pos = findNextAvailablePosition(
                { ...instance.layout, i: instance.id, y: 0 },
                visible.map(v => ({ ...v.layout, i: v.id })),
            );
            instance.layout.x = pos.x;
            instance.layout.y = pos.y;
        }
        visible.push(instance);
    });

    return { visible, hidden, loadedWidgetIds: registered.map(([id]) => id) };
}
