import { Injectable } from '@nestjs/common';
import { ID } from '@vendure/common/lib/shared-types';

import { Logger } from '../../config/logger/vendure-logger';
import { TransactionalConnection } from '../../connection/transactional-connection';
import { Customer } from '../../entity/customer/customer.entity';
import { User } from '../../entity/user/user.entity';

import { loggerCtx } from './constants';
import { RoleAssignment } from './role-assignment.entity';

export interface MigrateLegacyRolesResult {
    /** The number of RoleAssignment rows which were newly created by this run */
    created: number;
}

/**
 * Migrates the legacy `User -> Role -> Channel` relations into explicit {@link RoleAssignment}
 * rows: for each (user, role) pair, a RoleAssignment is created for each of the role's channels.
 *
 * The migration is purely additive and idempotent: existing legacy relations are left untouched
 * (they remain the source of truth for permission resolution until the resolver strategy is
 * implemented, and keeping them makes disabling the experimental flag non-destructive), and
 * re-running it only creates whatever RoleAssignments are missing. It runs on server
 * bootstrap while the `experimental.roleAssignments` flag is enabled, but only when the
 * `role_assignment` table is still empty (see {@link RoleAssignmentPlugin}); it can be
 * invoked manually to pick up relations created since.
 *
 * The candidate rows are produced by a single join across the legacy tables: for every
 * (user, role) pair in `user_roles_role`, the role's channels are joined in from
 * `role_channels_channel`, yielding one (user, role, channel) row each. An additional
 * membership check is then applied: users which have channel memberships of their own
 * (customer users, via `customer_channels_channel`) only receive assignments for channels
 * they actually belong to. Without this check every customer would be assigned to every
 * channel, because the Customer role itself is auto-assigned to all channels. Administrator
 * users have no channel membership of their own, so their assignments follow the role's
 * channels directly.
 *
 * @internal
 */
@Injectable()
export class RoleAssignmentMigrationService {
    constructor(private connection: TransactionalConnection) {}

    async migrateLegacyRoles(): Promise<MigrateLegacyRolesResult> {
        const rawConnection = this.connection.rawConnection;

        const keyOf = (a: { userId: ID; roleId: ID; channelId: ID }) =>
            `${a.userId}|${a.roleId}|${a.channelId}`;

        // user_roles_role -> role_channels_channel: one row per (user, role, channel)
        const rows = await rawConnection
            .getRepository(User)
            .createQueryBuilder('user')
            .innerJoin('user.roles', 'role')
            .innerJoin('role.channels', 'channel')
            .where('user.deletedAt IS NULL')
            .select('user.id', 'userId')
            .addSelect('role.id', 'roleId')
            .addSelect('channel.id', 'channelId')
            .getRawMany<{ userId: ID; roleId: ID; channelId: ID }>();

        // Channel memberships of users which are themselves channel-aware (customer users).
        // Users without an entry here (administrator users) have no channel membership of
        // their own and are not filtered.
        const customerChannelRows = await rawConnection
            .getRepository(Customer)
            .createQueryBuilder('customer')
            .innerJoin('customer.channels', 'channel')
            .innerJoin('customer.user', 'user')
            .where('customer.deletedAt IS NULL')
            .select('user.id', 'userId')
            .addSelect('channel.id', 'channelId')
            .getRawMany<{ userId: ID; channelId: ID }>();
        const userChannelMemberships = new Map<string, Set<string>>();
        for (const { userId, channelId } of customerChannelRows) {
            const memberships = userChannelMemberships.get(String(userId)) ?? new Set<string>();
            memberships.add(String(channelId));
            userChannelMemberships.set(String(userId), memberships);
        }

        const candidates = new Map<string, { userId: ID; roleId: ID; channelId: ID }>();
        for (const row of rows) {
            const memberships = userChannelMemberships.get(String(row.userId));
            if (memberships && !memberships.has(String(row.channelId))) {
                continue;
            }
            candidates.set(keyOf(row), row);
        }

        const existing = await rawConnection.getRepository(RoleAssignment).find({
            select: { userId: true, roleId: true, channelId: true },
        });
        for (const assignment of existing) {
            candidates.delete(keyOf(assignment));
        }

        const toInsert = Array.from(candidates.values());
        const chunkSize = 500;
        for (let i = 0; i < toInsert.length; i += chunkSize) {
            await rawConnection
                .createQueryBuilder()
                .insert()
                .into(RoleAssignment)
                .values(toInsert.slice(i, i + chunkSize))
                .orIgnore()
                .execute();
        }
        if (toInsert.length > 0) {
            Logger.info(
                `Created ${toInsert.length} RoleAssignment(s) from legacy user-role relations`,
                loggerCtx,
            );
        }
        return { created: toInsert.length };
    }
}
