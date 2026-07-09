import { DeepPartial } from '@vendure/common/lib/shared-types';
import { Entity, Index, ManyToOne, Unique } from 'typeorm';

import { VendureEntity } from '../../entity/base/base.entity';
import { Channel } from '../../entity/channel/channel.entity';
import { Role } from '../../entity/role/role.entity';
import { User } from '../../entity/user/user.entity';

/**
 * A RoleAssignment is a bridge entity which associates a User with a Role on a specific
 * Channel. It decouples Role definitions from Channel assignments, allowing the same Role
 * to be shared across multiple Users on different Channels, rather than requiring the Role
 * itself to be duplicated per Channel.
 *
 * This entity is only registered when the `experimental.roleAssignments.enabled` config
 * flag is set, via the internal `RoleAssignmentPlugin`.
 */
@Entity()
@Unique('IDX_ROLE_ASSIGNMENT_USER_ROLE_CHANNEL', ['user', 'role', 'channel'])
export class RoleAssignment extends VendureEntity {
    constructor(input?: DeepPartial<RoleAssignment>) {
        super(input);
    }

    @Index()
    @ManyToOne(type => User, { onDelete: 'CASCADE' })
    user: User;

    @Index()
    @ManyToOne(type => Role, { onDelete: 'CASCADE' })
    role: Role;

    @Index()
    @ManyToOne(type => Channel, { onDelete: 'CASCADE' })
    channel: Channel;
}
