import { DateRangePicker } from '@/vdb/components/date-range-picker.js';
import { Button } from '@/vdb/components/ui/button.js';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/vdb/components/ui/dropdown-menu.js';
import type { GridLayout as GridLayoutType } from '@/vdb/components/ui/grid-layout.js';
import { compactLayouts, GridLayout, insertWithReflow, tidyLayouts } from '@/vdb/components/ui/grid-layout.js';
import {
    getDashboardWidget,
    getDashboardWidgetFilters,
    getVisibleDashboardWidgets,
} from '@/vdb/framework/dashboard-widget/widget-extensions.js';
import { usePermissions } from '@/vdb/hooks/use-permissions.js';
import { DefinedDateRange, WidgetFiltersProvider, } from '@/vdb/framework/dashboard-widget/widget-filters-context.js';
import { WidgetInstanceProvider } from '@/vdb/framework/dashboard-widget/widget-instance-context.js';
import { DashboardWidgetDefinition, DashboardWidgetInstance } from '@/vdb/framework/extension-api/types/widgets.js';
import {
    FullWidthPageBlock,
    Page,
    PageActionBar,
    PageLayout,
    PageTitle,
} from '@/vdb/framework/layout-engine/page-layout.js';
import { ActionBarItem } from '@/vdb/framework/layout-engine/action-bar-item-wrapper.js';
import { useUserSettings } from '@/vdb/hooks/use-user-settings.js';
import { createFileRoute } from '@tanstack/react-router';
import { endOfDay, startOfMonth } from 'date-fns';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useLingui as useLinguiRuntime } from '@lingui/react';
import { LayoutGridIcon, PlusIcon, XIcon } from 'lucide-react';

export const Route = createFileRoute('/_authenticated/')({
    component: DashboardPage,
});

const findNextPosition = (
    existingWidgets: DashboardWidgetInstance[],
    newWidgetSize: { w: number; h: number },
) => {
    const occupied = new Set();
    let maxExistingRow = 0;

    existingWidgets.forEach(widget => {
        const { x, y, w, h } = widget.layout;
        maxExistingRow = Math.max(maxExistingRow, y + h);

        for (let i = x; i < x + w; i++) {
            for (let j = y; j < y + h; j++) {
                occupied.add(`${i},${j}`);
            }
        }
    });

    const maxSearchRows = maxExistingRow + 3;

    for (let y = 0; y < maxSearchRows; y++) {
        for (let x = 0; x <= 12 - newWidgetSize.w; x++) {
            let fits = true;
            for (let i = x; i < x + newWidgetSize.w; i++) {
                for (let j = y; j < y + newWidgetSize.h; j++) {
                    if (occupied.has(`${i},${j}`)) {
                        fits = false;
                        break;
                    }
                }
                if (!fits) break;
            }
            if (fits) {
                return { x, y };
            }
        }
    }
    return { x: 0, y: maxExistingRow };
};

/**
 * Builds a widget instance from its definition, applying a saved layout when present and
 * otherwise falling back to the definition's default/min/max size. `instanceId` equals the
 * `widgetId` for single-instance widgets (which keeps migration from the legacy layout
 * stable) and is a freshly-generated id for additional multi-instance instances.
 */
const buildWidgetInstance = (
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

// Multi-instance widgets get a unique instance id so each instance persists its own layout
// and config independently. Single-instance widgets keep instanceId === widgetId.
const generateInstanceId = (widgetId: string) => `${widgetId}:${crypto.randomUUID()}`;

const toGridLayout = (widget: DashboardWidgetInstance): GridLayoutType => ({
    ...widget.layout,
    i: widget.id,
});

// Applies the x/y/w/h from a reflowed/compacted grid back onto the widget instances, keeping
// every other instance property (config, min/max constraints) intact.
const applyGridLayouts = (
    instances: DashboardWidgetInstance[],
    grid: GridLayoutType[],
): DashboardWidgetInstance[] =>
    instances.map(instance => {
        const layout = grid.find(g => g.i === instance.id);
        return layout
            ? { ...instance, layout: { ...instance.layout, x: layout.x, y: layout.y, w: layout.w, h: layout.h } }
            : instance;
    });

function DashboardPage() {
    const [widgets, setWidgets] = useState<DashboardWidgetInstance[]>([]);
    // Draft list of hidden widget instances. Their layout is preserved so that
    // re-adding a widget restores its previous position and size. Committed to
    // user settings together with the layout on "Save Layout".
    const [hiddenWidgets, setHiddenWidgets] = useState<DashboardWidgetInstance[]>([]);
    // The ids of all currently-registered widgets the user is permitted to see. Captured on
    // load so the save step knows which widgets it "owns" when pruning removed instances and
    // computing the hidden list.
    const [loadedWidgetIds, setLoadedWidgetIds] = useState<string[]>([]);
    const [editMode, setEditMode] = useState(false);
    const [isInitialized, setIsInitialized] = useState(false);
    const prevEditModeRef = useRef(editMode);
    const { t } = useLingui();
    const { i18n } = useLinguiRuntime();
    const [dateRange, setDateRange] = useState<DefinedDateRange>({
        from: startOfMonth(new Date()),
        to: endOfDay(new Date()),
    });
    // Global Insights filters registered via `insights.filters`. Their values are session-only
    // state seeded from each filter's `defaultValue`, and are shared with every widget through
    // the WidgetFiltersProvider so widgets can read them via `useWidgetFilters().filters[id]`.
    const widgetFilters = useMemo(() => getDashboardWidgetFilters(), []);
    const [filterValues, setFilterValues] = useState<Record<string, unknown>>(() =>
        Object.fromEntries(widgetFilters.map(filter => [filter.id, filter.defaultValue])),
    );

    const { settings, saveWidgetInstanceLayouts, setHiddenWidgets: persistHiddenWidgets } = useUserSettings();
    const { hasPermissions } = usePermissions();

    useEffect(() => {
        // Saved instances are the source of truth. A widget may have several persisted
        // instances (multi-instance). The legacy `widgetLayout` record is read only as a
        // fallback so existing single-instance layouts migrate transparently.
        const persistedInstances = settings.widgetInstances ?? [];
        const legacyLayouts = settings.widgetLayout ?? {};
        // Stale ids (widgets that are no longer registered) are naturally ignored because we
        // only iterate over currently-registered widgets below.
        const hiddenIds = new Set(settings.hiddenWidgets ?? []);

        const registered = getVisibleDashboardWidgets().filter(([, widget]) => {
            if (!widget.requiresPermissions || widget.requiresPermissions.length === 0) {
                return true;
            }
            return hasPermissions(widget.requiresPermissions);
        });

        const visible: DashboardWidgetInstance[] = [];
        const hidden: DashboardWidgetInstance[] = [];

        registered.forEach(([id, widget]) => {
            const persistedForWidget = persistedInstances.filter(instance => instance.widgetId === id);
            const isHidden = hiddenIds.has(id);

            if (persistedForWidget.length > 0) {
                // Restore each persisted instance at its saved position/size and config.
                persistedForWidget.forEach(instance => {
                    (isHidden ? hidden : visible).push(
                        buildWidgetInstance(widget, instance.instanceId, instance.layout, instance.config),
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
            // it via findNextPosition unless a legacy layout supplies a saved position.
            const instance = buildWidgetInstance(widget, id, legacyLayout);
            if (!legacyLayout) {
                const pos = findNextPosition(visible, { w: instance.layout.w, h: instance.layout.h });
                instance.layout.x = pos.x;
                instance.layout.y = pos.y;
            }
            visible.push(instance);
        });

        setWidgets(visible);
        setHiddenWidgets(hidden);
        setLoadedWidgetIds(registered.map(([id]) => id));
        setIsInitialized(true);
    }, [settings.widgetInstances, settings.widgetLayout, settings.hiddenWidgets, hasPermissions]);

    // Save layout and hidden widgets when edit mode is turned off
    useEffect(() => {
        // Only save when transitioning from edit mode ON to OFF
        if (prevEditModeRef.current && !editMode && isInitialized) {
            // Commit the current layouts of both visible and hidden widgets so a hidden
            // single-instance widget keeps its position/size when re-added. Persisted
            // per-instance config is preserved by saveWidgetInstanceLayouts.
            const layouts = [...widgets, ...hiddenWidgets].map(widget => ({
                instanceId: widget.id,
                widgetId: widget.widgetId,
                layout: {
                    x: widget.layout.x,
                    y: widget.layout.y,
                    w: widget.layout.w,
                    h: widget.layout.h,
                },
            }));
            saveWidgetInstanceLayouts(layouts, loadedWidgetIds);
            // A widget is hidden when it has no visible instance left — this covers both a
            // hidden single-instance widget and a multi-instance widget whose last instance
            // was removed. The hidden-list model keeps newly-registered widgets visible.
            const visibleWidgetIds = new Set(widgets.map(widget => widget.widgetId));
            persistHiddenWidgets(loadedWidgetIds.filter(id => !visibleWidgetIds.has(id)));
        }

        // Update the ref for next render
        prevEditModeRef.current = editMode;
    }, [
        editMode,
        isInitialized,
        widgets,
        hiddenWidgets,
        loadedWidgetIds,
        saveWidgetInstanceLayouts,
        persistHiddenWidgets,
    ]);

    const handleLayoutChange = (layouts: GridLayoutType[]) => {
        setWidgets(prev =>
            prev.map((widget, i) => ({
                ...widget,
                layout: layouts[i] || widget.layout,
            })),
        );
    };

    const handleRemoveWidget = (instanceId: string) => {
        const target = widgets.find(widget => widget.id === instanceId);
        if (!target) {
            return;
        }
        // Vertically compact the remaining widgets so the freed space is filled automatically —
        // both when discarding a multi-instance instance and when hiding a single-instance
        // widget (including the last-instance-hide case). The user should not have to re-arrange.
        setWidgets(prev => {
            const remaining = prev.filter(widget => widget.id !== instanceId);
            return applyGridLayouts(remaining, compactLayouts(remaining.map(toGridLayout)));
        });
        // Multi-instance widgets are re-added as fresh instances from the picker, so a removed
        // instance is simply discarded. Single-instance widgets are kept (with their layout) so
        // re-adding restores their previous position and size.
        const definition = getDashboardWidget(target.widgetId);
        if (!definition?.allowMultipleInstances) {
            setHiddenWidgets(prev => [...prev, target]);
        }
    };

    // Restores a hidden single-instance widget to its previous position and size, reflowing any
    // widgets that now overlap that saved space out of the way (rather than overlapping or
    // dumping the re-added widget at the next free slot).
    const handleAddWidget = (instanceId: string) => {
        const target = hiddenWidgets.find(widget => widget.id === instanceId);
        if (!target) {
            return;
        }
        setHiddenWidgets(prev => prev.filter(widget => widget.id !== instanceId));
        setWidgets(prev => {
            const combined = [...prev, target];
            return applyGridLayouts(combined, insertWithReflow(prev.map(toGridLayout), toGridLayout(target)));
        });
    };

    // Re-arranges every visible widget into the tightest gap-free grid, preserving each widget's
    // size and only changing positions. Affects draft state; persisted on "Save Layout".
    const handleTidy = () => {
        setWidgets(prev => applyGridLayouts(prev, tidyLayouts(prev.map(toGridLayout))));
    };

    // Adds a fresh instance of a multi-instance widget, placed at the next free grid slot.
    const handleAddWidgetInstance = (widgetId: string) => {
        const definition = getDashboardWidget(widgetId);
        if (!definition) {
            return;
        }
        setWidgets(prev => {
            const instance = buildWidgetInstance(definition, generateInstanceId(widgetId));
            const pos = findNextPosition(prev, { w: instance.layout.w, h: instance.layout.h });
            instance.layout.x = pos.x;
            instance.layout.y = pos.y;
            return [...prev, instance];
        });
    };

    const renderWidget = (widget: DashboardWidgetInstance) => {
        const definition = getDashboardWidget(widget.widgetId);
        if (!definition) return null;
        const WidgetComponent = definition.component;

        return (
            <div key={widget.id} className="relative h-full w-full">
                {editMode && (
                    <button
                        type="button"
                        aria-label={t`Remove widget`}
                        className="absolute -right-2 -top-2 z-20 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground"
                        onMouseDown={event => event.stopPropagation()}
                        onClick={() => handleRemoveWidget(widget.id)}
                    >
                        <XIcon className="h-3.5 w-3.5" />
                    </button>
                )}
                <WidgetInstanceProvider
                    value={{
                        instanceId: widget.id,
                        widgetId: widget.widgetId,
                        layout: {
                            x: widget.layout.x,
                            y: widget.layout.y,
                            w: widget.layout.w,
                            h: widget.layout.h,
                        },
                    }}
                >
                    <WidgetComponent id={widget.id} config={widget.config} />
                </WidgetInstanceProvider>
            </div>
        );
    };

    // Multi-instance widgets are always offered in the picker (even when already on the page)
    // so the user can add additional independent instances.
    const multiInstanceWidgets = loadedWidgetIds
        .map(id => getDashboardWidget(id))
        .filter((definition): definition is DashboardWidgetDefinition => !!definition?.allowMultipleInstances);
    const hasPickerOptions = hiddenWidgets.length > 0 || multiInstanceWidgets.length > 0;

    return (
        <Page pageId="insights">
            <PageTitle>
                <Trans>Insights</Trans>
            </PageTitle>
            <PageActionBar>
                <ActionBarItem itemId="date-range-picker">
                    <DateRangePicker
                        dateRange={dateRange}
                        onDateRangeChange={setDateRange}
                        className="mr-2"
                    />
                </ActionBarItem>
                {widgetFilters.map(filter => {
                    const FilterComponent = filter.component;
                    return (
                        <ActionBarItem key={filter.id} itemId={`widget-filter-${filter.id}`}>
                            <div className="mr-2">
                                <FilterComponent
                                    value={filterValues[filter.id]}
                                    onChange={value =>
                                        setFilterValues(prev => ({ ...prev, [filter.id]: value }))
                                    }
                                />
                            </div>
                        </ActionBarItem>
                    );
                })}
                {editMode && (
                    <ActionBarItem itemId="add-widget-picker">
                        <DropdownMenu>
                            <DropdownMenuTrigger render={<Button variant="outline" className="mr-2" />}>
                                <PlusIcon className="mr-1 h-4 w-4" />
                                <Trans>Add widget</Trans>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                {hasPickerOptions ? (
                                    <>
                                        {hiddenWidgets.map(widget => {
                                            const definition = getDashboardWidget(widget.widgetId);
                                            return (
                                                <DropdownMenuItem
                                                    key={widget.id}
                                                    onClick={() => handleAddWidget(widget.id)}
                                                >
                                                    {definition ? i18n.t(definition.name) : widget.widgetId}
                                                </DropdownMenuItem>
                                            );
                                        })}
                                        {multiInstanceWidgets.map(definition => (
                                            <DropdownMenuItem
                                                key={definition.id}
                                                onClick={() => handleAddWidgetInstance(definition.id)}
                                            >
                                                {i18n.t(definition.name)}
                                            </DropdownMenuItem>
                                        ))}
                                    </>
                                ) : (
                                    <DropdownMenuItem disabled>
                                        <Trans>No widgets to add</Trans>
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </ActionBarItem>
                )}
                {editMode && (
                    <ActionBarItem itemId="tidy-widgets">
                        <Button
                            variant="outline"
                            className="mr-2"
                            disabled={widgets.length === 0}
                            onClick={handleTidy}
                        >
                            <LayoutGridIcon className="mr-1 h-4 w-4" />
                            <Trans>Tidy</Trans>
                        </Button>
                    </ActionBarItem>
                )}
                <ActionBarItem itemId="edit-layout-button">
                    <Button
                        variant={editMode ? 'default' : 'outline'}
                        onClick={() => setEditMode(prev => !prev)}
                    >
                        {editMode ? t`Save Layout` : t`Edit Layout`}
                    </Button>
                </ActionBarItem>
            </PageActionBar>
            <PageLayout>
                <FullWidthPageBlock blockId="widgets">
                    <div className="w-full">
                        {widgets.length > 0 ? (
                            <WidgetFiltersProvider filters={{ dateRange, filters: filterValues }}>
                                <GridLayout
                                    layouts={widgets.map(w => ({ ...w.layout, i: w.id }))}
                                    onLayoutChange={handleLayoutChange}
                                    cols={12}
                                    rowHeight={100}
                                    isDraggable={editMode}
                                    isResizable={editMode}
                                    className="min-h-[400px]"
                                    gutter={10}
                                >
                                    {
                                        widgets
                                            .map(widget => renderWidget(widget))
                                            .filter(Boolean) as React.ReactElement[]
                                    }
                                </GridLayout>
                            </WidgetFiltersProvider>
                        ) : (
                            <div
                                className="flex items-center justify-center text-center text-muted-foreground"
                                style={{ height: '400px' }}
                            >
                                {editMode ? (
                                    <Trans>
                                        All widgets are hidden. Use the "Add widget" button to add them
                                        back.
                                    </Trans>
                                ) : (
                                    <Trans>No widgets to display. Use "Edit Layout" to add widgets.</Trans>
                                )}
                            </div>
                        )}
                    </div>
                </FullWidthPageBlock>
            </PageLayout>
        </Page>
    );
}
