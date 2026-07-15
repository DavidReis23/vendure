import { DateRangePicker } from '@/vdb/components/date-range-picker.js';
import { Button } from '@/vdb/components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/vdb/components/ui/tooltip.js';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/vdb/components/ui/dropdown-menu.js';
import type { GridLayout as GridLayoutType } from '@/vdb/components/ui/grid-layout.js';
import {
    compactLayouts,
    findNextAvailablePosition,
    GridLayout,
    insertWithReflow,
    tidyLayouts,
} from '@/vdb/components/ui/grid-layout.js';
import {
    getDashboardWidget,
    getDashboardWidgetFilters,
    getVisibleDashboardWidgets,
} from '@/vdb/framework/dashboard-widget/widget-extensions.js';
import { usePermissions } from '@/vdb/hooks/use-permissions.js';
import { DefinedDateRange, WidgetFiltersProvider, } from '@/vdb/framework/dashboard-widget/widget-filters-context.js';
import { WidgetInstanceProvider } from '@/vdb/framework/dashboard-widget/widget-instance-context.js';
import {
    buildInitialWidgetState,
    buildWidgetInstance,
    mergeHiddenWidgetIds,
} from '@/vdb/framework/dashboard-widget/insights-layout.js';
import { DashboardWidgetDefinition, DashboardWidgetInstance } from '@/vdb/framework/extension-api/types/widgets.js';
import {
    FullWidthPageBlock,
    Page,
    PageActionBar,
    PageLayout,
    PageTitle,
} from '@/vdb/framework/layout-engine/page-layout.js';
import { ActionBarItem } from '@/vdb/framework/layout-engine/action-bar-item-wrapper.js';
import { useInsightsRefresh } from '@/vdb/hooks/use-insights-refresh.js';
import { useUserSettings } from '@/vdb/hooks/use-user-settings.js';
import { createFileRoute } from '@tanstack/react-router';
import { endOfDay, startOfMonth } from 'date-fns';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useLingui as useLinguiRuntime } from '@lingui/react';
import { PlusIcon, RefreshCw, Sparkles, SquarePen, XIcon } from 'lucide-react';

export const Route = createFileRoute('/_authenticated/')({
    component: DashboardPage,
});

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

    const {
        settings,
        settingsReady,
        saveWidgetInstanceLayouts,
        setHiddenWidgets: persistHiddenWidgets,
        updateWidgetInstanceConfig,
    } = useUserSettings();
    const { hasPermissions } = usePermissions();

    // Page-level refresh signal shared with every widget via the WidgetFiltersProvider. Auto-refresh
    // polling is paused while editing the layout so a background refetch can't disrupt a live edit.
    const { refresh, isRefreshing } = useInsightsRefresh({ enabled: !editMode });

    // Latest values read inside the one-shot initializer and the config-write handler without
    // making them effect/callback dependencies (which would otherwise re-run initialization on
    // every config write and discard the unsaved draft).
    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    const editModeRef = useRef(editMode);
    editModeRef.current = editMode;
    const widgetsRef = useRef(widgets);
    widgetsRef.current = widgets;

    // Initialize the draft widget state from persisted settings exactly once, when settings
    // become ready, and again only when the set of permitted widgets changes. This is
    // deliberately NOT reactive to `settings.widgetInstances`: widget config is persisted
    // immediately via `updateWidgetInstanceConfig`, and rebuilding here on those writes would
    // wipe out the user's unsaved edit-mode draft (dragged positions, hidden widgets,
    // never-saved multi-instance instances). Re-initialization is also skipped while editing so
    // an out-of-band settings change (e.g. synced from another tab) can't corrupt a live edit
    // session.
    useEffect(() => {
        if (!settingsReady || editModeRef.current) {
            return;
        }
        const registered = getVisibleDashboardWidgets().filter(([, widget]) => {
            if (!widget.requiresPermissions || widget.requiresPermissions.length === 0) {
                return true;
            }
            return hasPermissions(widget.requiresPermissions);
        });
        const state = buildInitialWidgetState(settingsRef.current, registered);
        setWidgets(state.visible);
        setHiddenWidgets(state.hidden);
        setLoadedWidgetIds(state.loadedWidgetIds);
        setIsInitialized(true);
    }, [settingsReady, hasPermissions]);

    // Routes a widget instance's config change to the correct destination. The config is always
    // reflected in draft state so the widget re-renders immediately and "Save Layout" commits
    // the right value. Outside edit mode there is no Save step, so it is also persisted to user
    // settings right away (e.g. the Metrics widget's Count/Total tab must survive a reload).
    // While editing, the config stays in draft only — committed together with the layout on
    // "Save Layout" — which is what stops a config change from silently making a never-saved
    // draft instance permanent.
    const handleConfigChange = useCallback(
        (instanceId: string, config: Record<string, unknown>) => {
            setWidgets(prev =>
                prev.map(widget => (widget.id === instanceId ? { ...widget, config } : widget)),
            );
            if (!editModeRef.current) {
                const target = widgetsRef.current.find(widget => widget.id === instanceId);
                if (target) {
                    updateWidgetInstanceConfig({
                        instanceId,
                        widgetId: target.widgetId,
                        layout: target.layout,
                        config,
                    });
                }
            }
        },
        [updateWidgetInstanceConfig],
    );

    // Save layout and hidden widgets when edit mode is turned off
    useEffect(() => {
        // Only save when transitioning from edit mode ON to OFF
        if (prevEditModeRef.current && !editMode && isInitialized) {
            // Commit the current layouts of both visible and hidden widgets so a hidden
            // single-instance widget keeps its position/size when re-added. The draft `config`
            // is committed here too, so any config changes made during the edit session
            // (including on never-saved draft instances) are persisted atomically with the layout.
            const layouts = [...widgets, ...hiddenWidgets].map(widget => ({
                instanceId: widget.id,
                widgetId: widget.widgetId,
                layout: {
                    x: widget.layout.x,
                    y: widget.layout.y,
                    w: widget.layout.w,
                    h: widget.layout.h,
                },
                config: widget.config,
            }));
            saveWidgetInstanceLayouts(layouts, loadedWidgetIds);
            // A widget is hidden when it has no visible instance left — this covers both a
            // hidden single-instance widget and a multi-instance widget whose last instance
            // was removed. The hidden-list model keeps newly-registered widgets visible.
            const visibleWidgetIds = new Set(widgets.map(widget => widget.widgetId));
            persistHiddenWidgets(
                mergeHiddenWidgetIds(
                    settingsRef.current.hiddenWidgets ?? [],
                    loadedWidgetIds,
                    visibleWidgetIds,
                ),
            );
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
            const pos = findNextAvailablePosition({ ...toGridLayout(instance), y: 0 }, prev.map(toGridLayout));
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
                        config: widget.config,
                        setConfig: config => handleConfigChange(widget.id, config),
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
                            <Sparkles className="mr-1 h-4 w-4" />
                            <Trans>Tidy</Trans>
                        </Button>
                    </ActionBarItem>
                )}
                {!editMode && (
                    <ActionBarItem itemId="refresh-widgets">
                        <Button
                            variant="outline"
                            className="mr-2"
                            onClick={refresh}
                            disabled={isRefreshing}
                        >
                            <RefreshCw
                                className={isRefreshing ? 'animate-rotate mr-1 h-4 w-4' : 'mr-1 h-4 w-4'}
                            />
                            <Trans>Refresh</Trans>
                        </Button>
                    </ActionBarItem>
                )}
                <ActionBarItem itemId="edit-layout-button">
                    {editMode ? (
                        <Button variant="default" onClick={() => setEditMode(false)}>
                            <Trans>Save Layout</Trans>
                        </Button>
                    ) : (
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        onClick={() => setEditMode(true)}
                                    />
                                }
                            >
                                <SquarePen />
                            </TooltipTrigger>
                            <TooltipContent>
                                <Trans>Edit layout</Trans>
                            </TooltipContent>
                        </Tooltip>
                    )}
                </ActionBarItem>
            </PageActionBar>
            <PageLayout>
                <FullWidthPageBlock blockId="widgets">
                    <div className="w-full">
                        {!isInitialized ? null : widgets.length > 0 ? (
                            <WidgetFiltersProvider
                                filters={{ dateRange, filters: filterValues }}
                            >
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
