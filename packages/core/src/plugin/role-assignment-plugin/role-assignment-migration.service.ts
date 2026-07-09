import { Injectable } from '@nestjs/common';
import { CUSTOMER_ROLE_CODE, SUPER_ADMIN_ROLE_CODE } from '@vendure/common/lib/shared-constants';
import { ID } from '@vendure/common/lib/shared-types';

import { Logger } from '../../config/logger/vendure-logger';
import { TransactionalConnection } from '../../connection/transactional-connection';
import { Role } from '../../entity/role/role.entity';
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
 * re-running it only creates whatever RoleAssignments are missing. It runs automatically on
 * server bootstrap while the `experimental.roleAssignments` flag is enabled.
 *
 * The SuperAdmin and Customer system roles are skipped entirely: migrating them faithfully
 * would fan out to (users x channels) rows which the target design replaces with check-time
 * semantics ("holds SuperAdmin / is authenticated" regardless of channel). How they are
 * represented is deferred to the permission-resolution pass.
 *
 * @internal
 */
@Injectable()
export class RoleAssignmentMigrationService {
    constructor(private connection: TransactionalConnection) {}

    async migrateLegacyRoles(): Promise<MigrateLegacyRolesResult> {
        const rawConnection = this.connection.rawConnection;
        const roles = await rawConnection.getRepository(Role).find({ relations: { channels: true } });

        const candidates = new Map<string, { userId: ID; roleId: ID; channelId: ID }>();
        const keyOf = (a: { userId: ID; roleId: ID; channelId: ID }) =>
            `${a.userId}|${a.roleId}|${a.channelId}`;

        for (const role of roles) {
            if (role.code === CUSTOMER_ROLE_CODE || role.code === SUPER_ADMIN_ROLE_CODE) {
                continue;
            }
            const userRows = await rawConnection
                .getRepository(User)
                .createQueryBuilder('user')
                .innerJoin('user.roles', 'role')
                .where('role.id = :roleId', { roleId: role.id })
                .andWhere('user.deletedAt IS NULL')
                .select('user.id', 'userId')
                .getRawMany<{ userId: ID }>();

            for (const { userId } of userRows) {
                for (const channel of role.channels) {
                    const candidate = { userId, roleId: role.id, channelId: channel.id };
                    candidates.set(keyOf(candidate), candidate);
                }
            }
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
