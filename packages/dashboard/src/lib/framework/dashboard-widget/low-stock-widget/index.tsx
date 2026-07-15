import { EmptyState, ErrorState, LoadingState } from '@/vdb/components/ui/state-views.js';
import { Badge } from '@/vdb/components/ui/badge.js';
import { api } from '@/vdb/graphql/api.js';
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PackageCheck } from 'lucide-react';
import { DashboardBaseWidget } from '../base-widget.js';
import { lowStockVariantsQuery } from './low-stock-widget.graphql.js';

const WIDGET_ID = 'low-stock-widget';
// Variants with saleable stock (stockOnHand - stockAllocated) at or below this value
// are considered low on stock. Independent of the selected date range.
const LOW_STOCK_THRESHOLD = 10;
const MAX_ITEMS = 10;

export function LowStockWidget() {
    const { t } = useLingui();

    const { data, isPending, isError, refetch } = useQuery({
        queryKey: ['low-stock-widget'],
        queryFn: () =>
            api.query(lowStockVariantsQuery, {
                options: {
                    take: MAX_ITEMS,
                    filter: {
                        stockOnHand: { lte: LOW_STOCK_THRESHOLD },
                    },
                    sort: { stockOnHand: 'ASC' },
                },
            }),
    });

    const variants = data?.productVariants.items ?? [];

    return (
        <DashboardBaseWidget
            id={WIDGET_ID}
            title={t`Low Stock`}
            description={t`Variants at or below the stock threshold`}
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
                    {variants.map(variant => {
                        const saleable = variant.stockOnHand - variant.stockAllocated;
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
                        title={<Trans>Stock levels look healthy</Trans>}
                        description={<Trans>No variants are at or below the stock threshold.</Trans>}
                    />
                </div>
            )}
        </DashboardBaseWidget>
    );
}
