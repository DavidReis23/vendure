import { Injectable } from '@nestjs/common';
import { ID } from '@vendure/common/lib/shared-types';

import { Logger } from '../../config/logger/vendure-logger';
import { TransactionalConnection } from '../../connection/transactional-connection';
import { User } from '../../entity/user/user.entity';

import { loggerCtx } from './constants';
import { RoleAssignment } from './role-assignment.entity';

export interface MigrateLegacyRolesResult {
    /** The number of RoleAssignment rows which were newly created by this run */
    created: number;
}

/**
 * Migrates the legacy `User -> Role -> Channel` relations into explicit {@link RoleAssignment}
 * rows: for each (user, role) pair in `user_roles_role`, the role's channels are joined in
 * from `role_channels_channel`, yielding one RoleAssignment per (user, role, channel).
 *
 * All users are treated alike — there is no differentiation between customer and
 * administrator users. This mirrors the legacy permission resolution exactly: a customer
 * user holds the Customer role, which is assigned to every channel, so they receive an
 * assignment on every channel, just as `getUserChannelsPermissions()` grants them
 * `Authenticated` on every channel today. Note that this means the row count scales with
 * `users x channels-per-role`, and that once permission resolution switches to this table,
 * operations which today extend the legacy relations (channel creation auto-assigning the
 * SuperAdmin/Customer roles, customer registration) must create the corresponding
 * RoleAssignment rows to stay consistent.
 *
 * The migration is purely additive and idempotent: existing legacy relations are left
 * untouched (they remain the source of truth for permission resolution until the resolver
 * strategy is implemented, and keeping them makes disabling the experimental flag
 * non-destructive), and re-running it only creates whatever RoleAssignments are missing.
 * It runs on server bootstrap while the `experimental.roleAssignments` flag is enabled,
 * but only when the `role_assignment` table is still empty (see {@link RoleAssignmentPlugin});
 * it can be invoked manually to pick up relations created since.
 *
 * @internal
 */
@Injectable()
export class RoleAssignmentMigrationService {
    constructor(private connection: TransactionalConnection) {}

    async migrateLegacyRoles(): Promise<MigrateLegacyRolesResult> {
        const rawConnection = this.connection.rawConnection;

        // String-normalized so that raw query results and entity values compare equal
        // regardless of how the driver returns id columns (e.g. string vs number).
        const keyOf = (a: { userId: ID; roleId: ID; channelId: ID }) =>
            `${String(a.userId)}|${String(a.roleId)}|${String(a.channelId)}`;

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

        const candidates = new Map<string, { userId: ID; roleId: ID; channelId: ID }>();
        for (const row of rows) {
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
        // A single transaction so that a mid-run failure cannot leave the table partially
        // populated, which would prevent the empty-table bootstrap check from re-running
        // the migration on the next start.
        await rawConnection.transaction(async manager => {
            for (let i = 0; i < toInsert.length; i += chunkSize) {
                await manager
                    .createQueryBuilder()
                    .insert()
                    .into(RoleAssignment)
                    .values(toInsert.slice(i, i + chunkSize))
                    .orIgnore()
                    .execute();
            }
        });

        if (toInsert.length > 0) {
            Logger.info(
                `Created ${toInsert.length} RoleAssignment(s) from legacy user-role relations`,
                loggerCtx,
            );
        }
        return { created: toInsert.length };
    }
}
