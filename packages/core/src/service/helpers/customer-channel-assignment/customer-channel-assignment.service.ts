import { Injectable } from '@nestjs/common';
import { DEFAULT_CHANNEL_CODE } from '@vendure/common/lib/shared-constants';
import { ID } from '@vendure/common/lib/shared-types';

import { RequestContext } from '../../../api/common/request-context';
import { ConfigService } from '../../../config/config.service';
import { Customer } from '../../../entity/customer/customer.entity';
import { ChannelService } from '../../services/channel.service';
import { CustomerService } from '../../services/customer.service';

export type ChannelMembershipOutcome = 'denied' | 'allowed';

/**
 * @description
 * Decides what happens when a signed-in Customer lands on the Channel their request points at, so the
 * {@link AuthGuard} doesn't have to carry that logic itself. Someone who already belongs is waved
 * straight through; otherwise the configured {@link CustomerChannelAssignmentStrategy} says whether
 * they may see the Channel and whether to quietly add them to it. The default Channel and disableAuth
 * dev mode skip the strategy and keep the original always-join behaviour.
 *
 * The name says "assignment" to line up with the strategy, but the job is wider than assigning: it
 * also turns Customers away and recognises the ones who already belong.
 */
@Injectable()
export class CustomerChannelAssignmentService {
    constructor(
        private configService: ConfigService,
        private customerService: CustomerService,
        private channelService: ChannelService,
    ) {}

    async resolve(ctx: RequestContext): Promise<ChannelMembershipOutcome> {
        const userId = ctx.activeUserId;
        if (!userId) {
            return 'allowed';
        }
        const { disableAuth, customerChannelAssignmentStrategy } = this.configService.authOptions;

        if (disableAuth || ctx.channel.code === DEFAULT_CHANNEL_CODE) {
            const customer = await this.customerService.findOneByUserId(ctx, userId, false);
            if (customer) await this.assignToActiveChannel(ctx, customer.id);

            return 'allowed';
        } else {
            const member = await this.customerService.findOneByUserId(ctx, userId, true);
            if (member) {
                return 'allowed';
            }
            const customer = await this.customerService.findOneByUserId(ctx, userId, false);
            if (!customer) {
                return 'allowed';
            }
            const canAccess = await customerChannelAssignmentStrategy.canCustomerAccessChannel(
                ctx,
                customer,
                ctx.channelId,
            );
            if (!canAccess) {
                return 'denied';
            }
            const canAssign = await customerChannelAssignmentStrategy.canAssignCustomerToChannel(
                ctx,
                customer,
                ctx.channelId,
            );
            if (canAssign) {
                await this.assignToActiveChannel(ctx, customer.id);
            }
            return 'allowed';
        }
    }

    private async assignToActiveChannel(ctx: RequestContext, customerId: ID): Promise<void> {
        try {
            await this.channelService.assignToChannels(ctx, Customer, customerId, [ctx.channelId]);
        } catch (e: any) {
            // Two requests for the same Customer can reach this at once and both try to add the same
            // Channel. If the database rejects ours as a duplicate, the other one already did the
            // work, so let it pass. Any other failure is real and should surface.
            // See https://github.com/vendurehq/vendure/issues/834
            const isDuplicateError = e.code === 'ER_DUP_ENTRY' || e.code === '23505';
            if (!isDuplicateError) {
                throw e;
            }
        }
    }
}
