import { defineDashboardExtension } from '@vendure/dashboard';

import { RegionFilter, REGION_FILTER_ID } from './region-filter';
import {
    RegionSummaryWidget,
    REGION_SUMMARY_DEFAULT_CONFIG,
    REGION_SUMMARY_WIDGET_ID,
} from './region-summary-widget';
import { StickyNoteWidget, STICKY_NOTE_DEFAULT_CONFIG, STICKY_NOTE_WIDGET_ID } from './sticky-note-widget';

defineDashboardExtension({
    insights: {
        widgets: [
            {
                // Custom widget with defaultConfig + a control persisted via useWidgetConfig,
                // that also responds to the global region filter below.
                id: REGION_SUMMARY_WIDGET_ID,
                name: 'Region Summary (test)',
                component: RegionSummaryWidget,
                defaultSize: { w: 3, h: 3 },
                defaultConfig: REGION_SUMMARY_DEFAULT_CONFIG,
            },
            {
                // Multi-instance widget: can be added several times, each instance
                // differentiated purely via its persisted config (the selected tone).
                id: STICKY_NOTE_WIDGET_ID,
                name: 'Sticky Note (test)',
                component: StickyNoteWidget,
                defaultSize: { w: 3, h: 3 },
                defaultConfig: STICKY_NOTE_DEFAULT_CONFIG,
                allowMultipleInstances: true,
            },
        ],
        // Global filter rendered in the Insights action bar. Its value flows to every
        // widget via useWidgetFilters().filters[REGION_FILTER_ID]; the Region Summary
        // widget above reflects the current selection.
        filters: [
            {
                id: REGION_FILTER_ID,
                component: RegionFilter,
                defaultValue: 'all',
            },
        ],
        // Code-level exclusion example — OFF by default so the dev server's default
        // Insights page is unchanged. Uncomment to hard-remove a built-in widget: it
        // will never render and never appear in the "Add widget" picker.
        // excludeWidgets: ['top-products-widget'],
    },
});
