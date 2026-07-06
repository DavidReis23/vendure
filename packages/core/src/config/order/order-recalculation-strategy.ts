import { RequestContext } from '../../api/common/request-context';
import { InjectableStrategy } from '../../common/types/injectable-strategy';
import { Order } from '../../entity/order/order.entity';

/**
 * @description
 * This strategy determines whether an active Order's prices, promotions and taxes should be
 * re-calculated when the Order is read (e.g. via the `activeOrder` query). Recalculation is only
 * ever attempted for Orders in the `AddingItems` state.
 *
 * **Note:** read-time recalculation refreshes item/order prices, promotions and taxes only.
 * Shipping method eligibility, rates and shipping promotions are NOT re-evaluated on read — they
 * are re-evaluated when the order transitions to `ArrangingPayment` (checkout).
 *
 * The default {@link NoOrderRecalculationStrategy} never triggers a recalculation, preserving the
 * historical behaviour whereby an active Order's prices are only updated on write mutations. Use
 * {@link TtlOrderRecalculationStrategy} (or a custom implementation) to keep long-lived carts in
 * sync with changing product prices and promotions.
 *
 * :::info
 *
 * This is configured via the `orderOptions.orderRecalculationStrategy` property of your VendureConfig.
 *
 * :::
 *
 * @docsCategory orders
 * @docsPage OrderRecalculationStrategy
 * @since 3.8.0
 */
export interface OrderRecalculationStrategy extends InjectableStrategy {
    /**
     * @description
     * Return `true` to trigger a recalculation of the Order's prices, promotions and taxes before
     * it is returned from the active-order read path.
     *
     * **Note:** Implementations should rely only on fields that are always present on the Order
     * (e.g. `pricingUpdatedAt`, `state`, `active`). Deep relations (lines, promotions, etc.) may
     * not be loaded on the Order passed to this method.
     */
    shouldRecalculate(ctx: RequestContext, order: Order): boolean | Promise<boolean>;
}
