import { CustomerChannelAssignmentStrategy } from './customer-channel-assignment-strategy';

/**
 * @description
 * The default {@link CustomerChannelAssignmentStrategy}: it says yes to everything. A Customer is
 * auto-joined to whichever Channel they authenticate against and may access any Channel.
 *
 * @docsCategory auth
 * @docsPage CustomerChannelAssignmentStrategy
 * @since 3.7.0
 */
export class DefaultCustomerChannelAssignmentStrategy implements CustomerChannelAssignmentStrategy {
    canAssignCustomerToChannel(): boolean {
        return true;
    }

    canCustomerAccessChannel(): boolean {
        return true;
    }
}
