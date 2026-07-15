import { EmptyState, ErrorState, LoadingState } from '@/vdb/components/ui/state-views.js';
import { Badge } from '@/vdb/components/ui/badge.js';
import { Tabs, TabsList, TabsTrigger } from '@/vdb/components/ui/tabs.js';
import { api } from '@/vdb/graphql/api.js';
import { useWidgetConfig } from '@/vdb/hooks/use-widget-config.js';
import { useWidgetFilters } from '@/vdb/hooks/use-widget-filters.js';
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PackageCheck } from 'lucide-react';
import { DashboardBaseWidget } from '../base-widget.js';
import { lowStockVariantsQuery } from './low-stock-widget.graphql.js';

const WIDGET_ID = 'low-stock-widget';
const MAX_ITEMS = 10;
// Selectable low-stock thresholds. A variant is "low" when its saleable stock
// (stockOnHand - stockAllocated) is at or below the chosen threshold.
const THRESHOLD_OPTIONS = [5, 10, 20, 50] as const;
// The core API cannot sort or filter productVariants by stockOnHand/stockAllocated
// (they are resolved at runtime from the StockLevel entity, not DB columns), so we
// fetch a bounded pool of variants and compute the low-stock list on the client.
// This means the result is a SAMPLE: variants outside the first CANDIDATE_POOL_SIZE
// are never inspected, so the widget cannot guarantee it has surfaced every low-stock
// variant. The description and empty state make this sampling explicit.
const CANDIDATE_POOL_SIZE = 100;

interface LowStockWidgetConfig extends Record<string, unknown> {
    threshold: number;
}

export function LowStockWidget() {
    const { t } = useLingui();
    const [config, setConfig] = useWidgetConfig<LowStockWidgetConfig>();
    const { refreshToken } = useWidgetFilters();
    const threshold = config.threshold;

    const { data, isPending, isError, refetch } = useQuery({
        queryKey: ['low-stock-widget', refreshToken],
        queryFn: () =>
            api.query(lowStockVariantsQuery, {
                options: {
                    take: CANDIDATE_POOL_SIZE,
                },
            }),
    });

    const variants = (data?.productVariants.items ?? [])
        .map(variant => ({ ...variant, saleable: variant.stockOnHand - variant.stockAllocated }))
        .filter(variant => variant.saleable <= threshold)
        .sort((a, b) => a.saleable - b.saleable)
        .slice(0, MAX_ITEMS);

    return (
        <DashboardBaseWidget
            id={WIDGET_ID}
            title={t`Low Stock`}
            description={t`Saleable stock at or below ${threshold}, from a sample of ${CANDIDATE_POOL_SIZE} variants`}
            actions={
                <Tabs
                    value={String(threshold)}
                    onValueChange={value => setConfig({ threshold: Number(value) })}
                >
                    <TabsList>
                        {THRESHOLD_OPTIONS.map(option => (
                            <TabsTrigger key={option} value={String(option)}>
                                {`≤ ${option}`}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                </Tabs>
            }
        >
            {isPending ? (
                <div className="flex h-full w-full items-center justify-center">
                    <LoadingState variant="spinner" label={<Trans>Loading stock levels…</Trans>} />
                </div>
            ) : isError ? (
                <div className="flex h-full w-full items-center justify-center">
                    <ErrorState
                        className="border-0"
                        title={<Trans>We couldn't load the stock levels</Trans>}
                        onRetry={() => refetch()}
                        retryLabel={t`Try again`}
                    />
                </div>
            ) : variants.length ? (
                <ul className="flex flex-col gap-1 tabular-nums">
                    {variants.map(({ saleable, ...variant }) => {
                        return (
                            <li key={variant.id}>
                                <Link
                                    to="/product-variants/$id"
                                    params={{ id: variant.id }}
                                    className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
                                >
                                    <div className="flex-1 truncate">
                                        <div className="truncate text-sm font-medium">{variant.name}</div>
                                        <div className="truncate text-xs text-muted-foreground">
                                            {variant.sku}
                                        </div>
                                    </div>
                                    <Badge variant={saleable <= 0 ? 'destructive' : 'warning'}>
                                        <Trans>{saleable} in stock</Trans>
                                    </Badge>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <div className="flex h-full w-full items-center justify-center">
                    <EmptyState
                        className="border-0"
                        illustration={null}
                        icon={<PackageCheck />}
                        title={<Trans>No low stock in this sample</Trans>}
                        description={
                            <Trans>
                                None of the {CANDIDATE_POOL_SIZE} sampled variants are at or below {threshold}.
                                Others may still be low.
                            </Trans>
                        }
                    />
                </div>
            )}
        </DashboardBaseWidget>
    );
}
