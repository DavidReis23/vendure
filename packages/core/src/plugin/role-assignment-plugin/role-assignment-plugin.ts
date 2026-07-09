import { OnApplicationBootstrap } from '@nestjs/common';

import { Logger } from '../../config/logger/vendure-logger';
import { TransactionalConnection } from '../../connection/transactional-connection';
import { ProcessContext } from '../../process-context/process-context';
import { PluginCommonModule } from '../plugin-common.module';
import { VendurePlugin } from '../vendure-plugin';

import { loggerCtx } from './constants';
import { RoleAssignmentMigrationService } from './role-assignment-migration.service';
import { RoleAssignment } from './role-assignment.entity';

/**
 * This plugin is registered internally by Vendure when the `experimental.roleAssignments.enabled`
 * config flag is set to `true` (see `VendureConfig.experimental`). It is never meant to be added
 * manually to the `plugins` array.
 *
 * This is currently a skeleton which registers the `RoleAssignment` entity — a bridge between
 * User, Role and Channel intended to eventually decouple Role definitions from Channel
 * assignments. On server bootstrap, if the `role_assignment` table is empty, it backfills
 * RoleAssignment rows from the legacy User -> Role -> Channel relations (see
 * {@link RoleAssignmentMigrationService}); once the table contains rows the migration is not
 * run again. The permission-resolution logic, service layer and API are not yet implemented.
 *
 * @internal
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [RoleAssignment],
    providers: [RoleAssignmentMigrationService],
    compatibility: '>0.0.0',
})
export class RoleAssignmentPlugin implements OnApplicationBootstrap {
    constructor(
        private connection: TransactionalConnection,
        private processContext: ProcessContext,
        private migrationService: RoleAssignmentMigrationService,
    ) {}

    async onApplicationBootstrap() {
        if (!this.processContext.isServer) {
            return;
        }
        const tableName = this.connection.rawConnection.getMetadata(RoleAssignment).tableName;
        const queryRunner = this.connection.rawConnection.createQueryRunner();
        let tableExists: boolean;
        try {
            tableExists = await queryRunner.hasTable(tableName);
        } finally {
            await queryRunner.release();
        }
        if (!tableExists) {
            Logger.error(
                `The experimental.roleAssignments flag is enabled but the "${tableName}" table does not exist. ` +
                    'Generate and run a database migration to create it.',
                loggerCtx,
            );
            return;
        }
        const existing = await this.connection.rawConnection
            .getRepository(RoleAssignment)
            .find({ take: 1, select: { id: true } });
        if (existing.length > 0) {
            return;
        }
        await this.migrationService.migrateLegacyRoles();
    }
}
