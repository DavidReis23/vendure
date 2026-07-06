import { RequestContext } from '../../api/common/request-context';
import { InjectableStrategy } from '../../common/types/injectable-strategy';
import { Order } from '../../entity/order/order.entity';

/**
 * @description
 * This strategy determines whether an active Order's prices, promotions, taxes and shipping
 * eligibility should be re-calculated when the Order is read (e.g. via the `activeOrder` query).
 * Recalculation is only ever attempted for Orders in the `AddingItems` state.
 *
 * The default {@link NoOrderRecalculationStrategy} never triggers a recalculation, preserving the
 * historical behaviour whereby an active Order's prices are only updated on write mutations. Use
 * {@link TtlOrderRecalculationStrategy} (or a custom implementation) to keep long-lived carts in
 * sync with changing product prices, promotions and shipping rules.
 *
 * :::info
 *
 * This is configured via the `orderOptions.orderRecalculationStrategy` property of your VendureConfig.
 *
 * :::
 *
 * @docsCategory orders
 * @since 3.8.0
 */
export interface OrderRecalculationStrategy extends InjectableStrategy {
    /**
     * @description
     * Return `true` to trigger a full recalculation of the Order before it is returned from the
     * active-order read path.
     */
    shouldRecalculate(ctx: RequestContext, order: Order): boolean | Promise<boolean>;
}
