import { ID } from '@vendure/common/lib/shared-types';

import { RequestContext } from '../../api/common/request-context';
import { InjectableStrategy } from '../../common/types/injectable-strategy';
import { Customer } from '../../entity/customer/customer.entity';

/**
 * @description
 * Controls whether an authenticated {@link Customer} is auto-joined to, and allowed to access, a
 * Channel.
 *
 * By default Vendure adds any authenticated Customer to whichever Channel their request's token
 * points at. That is fine for a single storefront, but wrong for multi-channel setups that need
 * *exclusive* channels — where a Customer of one Channel must not leak into another, or where a
 * B2B Channel should sit behind approval. Use this strategy to gate the AuthGuard's silent
 * auto-join (`canAssignCustomerToChannel`) and channel access itself (`canCustomerAccessChannel`).
 *
 * The {@link DefaultCustomerChannelAssignmentStrategy} returns `true` from both.
 * Only the AuthGuard consults this strategy — the Shop API account-creation
 * flows (registration, verification, external auth, guest checkout) are not gated.
 *
 * This gates membership and operations that require authentication; it does not hide a Channel's
 * public catalog. Anonymous storefront queries — products, collections, search, pricing — still
 * read whichever Channel the request token points at, so a denied Customer can browse a gated
 * Channel even though they cannot transact on it. To filter what a Channel exposes at the row
 * level, reach for {@link EntityAccessControlStrategy} instead.
 *
 * @example
 * ```ts
 * class ExclusiveChannelStrategy implements CustomerChannelAssignmentStrategy {
 *     private connection: TransactionalConnection;
 *
 *     init(injector: Injector) {
 *         this.connection = injector.get(TransactionalConnection);
 *     }
 *
 *     // Never silently auto-join; membership is granted explicitly by an admin.
 *     canAssignCustomerToChannel() {
 *         return false;
 *     }
 *
 *     // Only existing members (or an approved org membership) may access the Channel.
 *     async canCustomerAccessChannel(ctx: RequestContext, customer: Customer, channelId: ID) {
 *         return this.isApprovedForChannel(customer, channelId);
 *     }
 * }
 * ```
 *
 * :::info
 *
 * This is configured via the `authOptions.customerChannelAssignmentStrategy` property of your
 * VendureConfig.
 *
 * :::
 *
 * @docsCategory auth
 * @docsPage CustomerChannelAssignmentStrategy
 * @docsWeight 0
 * @since 3.7.0
 */
export interface CustomerChannelAssignmentStrategy extends InjectableStrategy {
    /**
     * @description
     * Should the AuthGuard silently add this Customer to the active Channel? Called when an
     * authenticated non-member touches the Channel, after `canCustomerAccessChannel` has already
     * allowed access. Return `false` to grant access for the current session without creating a
     * lasting membership — the grant holds until the session's active channel changes, not just for
     * the one request.
     *
     * Only the AuthGuard auto-join path calls this — not registration, verification, external auth or
     * guest checkout — and never for the default Channel.
     */
    canAssignCustomerToChannel(
        ctx: RequestContext,
        customer: Customer,
        channelId: ID,
    ): boolean | Promise<boolean>;

    /**
     * @description
     * May this Customer access the given Channel? Return `false` and the AuthGuard rejects the
     * request with a ForbiddenError. Checked when a non-member first activates the Channel — a new
     * session, or switching the active channel — and never for the default Channel.
     *
     * This gates *joining*, not every request: once a Customer is a member it is no longer
     * consulted, so to revoke access you remove their Channel membership rather than returning
     * `false` here. Public operations such as logout are never blocked.
     *
     * It also does not gate account creation — registration, verification, external auth and guest
     * checkout still join the Channel they run on.
     */
    canCustomerAccessChannel(
        ctx: RequestContext,
        customer: Customer,
        channelId: ID,
    ): boolean | Promise<boolean>;
}
