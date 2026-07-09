import { CurrencyCode, LanguageCode, Permission } from '@vendure/common/lib/generated-types';
import {
    CUSTOMER_ROLE_CODE,
    DEFAULT_CHANNEL_CODE,
    SUPER_ADMIN_ROLE_CODE,
    SUPER_ADMIN_USER_IDENTIFIER,
} from '@vendure/common/lib/shared-constants';
import {
    RoleAssignmentMigrationService,
    RoleAssignmentPlugin,
    TransactionalConnection,
    mergeConfig,
} from '@vendure/core';
import { preBootstrapConfig } from '@vendure/core/dist/bootstrap';
import { createErrorResultGuard, createTestEnvironment, ErrorResultGuard } from '@vendure/testing';
import path from 'path';
import { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';

import {
    createAdministratorDocument,
    createChannelDocument,
    createRoleDocument,
} from './graphql/shared-definitions';

/**
 * These tests exercise the `experimental.roleAssignments` flag, which is currently only a
 * skeleton: enabling it causes Vendure to internally register the `RoleAssignmentPlugin`,
 * which in turn adds the `RoleAssignment` entity (and its `role_assignment` table) to the
 * schema. No further behavior (permission resolution, API, etc.) is implemented yet.
 *
 * The "flag off" assertions are checked via `preBootstrapConfig()` directly (rather than by
 * booting a second live server) because the e2e sqlite cache is keyed only by spec filename —
 * two differently-shaped live databases cannot safely share that cache within a single file.
 * `preBootstrapConfig()` is the exact function responsible for the conditional registration,
 * so asserting against its output is a direct, reliable check of "schema untouched".
 */
describe('experimental.roleAssignments flag disabled (default)', () => {
    it('does not register the RoleAssignmentPlugin or the RoleAssignment entity', async () => {
        const config = await preBootstrapConfig({ plugins: [] });

        expect(config.plugins).not.toContain(RoleAssignmentPlugin);
        expect(
            (config.dbConnectionOptions.entities as any[]).some(e => e.name === 'RoleAssignment'),
        ).toBe(false);
    });
});

describe('experimental.roleAssignments flag enabled', () => {
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            experimental: {
                roleAssignments: { enabled: true },
            },
        }),
    );
    let queryRunner: QueryRunner;

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
            customerCount: 1,
        });
        queryRunner = server.app.get(TransactionalConnection).rawConnection.createQueryRunner();
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        if (queryRunner?.isReleased === false) {
            await queryRunner.release();
        }
        await server.destroy();
    });

    it('server boots successfully with the plugin registered', async () => {
        await adminClient.asSuperAdmin();
    });

    it('creates the role_assignment table with the expected columns', async () => {
        expect(await queryRunner.hasTable('role_assignment')).toBe(true);

        const table = await getRoleAssignmentTable(queryRunner);
        const columnNames = table.columns.map(c => c.name).sort();
        expect(columnNames).toEqual(
            ['channelId', 'createdAt', 'id', 'roleId', 'updatedAt', 'userId'].sort(),
        );
    });

    it('has non-nullable foreign key columns', async () => {
        const table = await getRoleAssignmentTable(queryRunner);
        for (const name of ['userId', 'roleId', 'channelId']) {
            expect(table.findColumnByName(name)?.isNullable).toBe(false);
        }
    });

    it('has a unique constraint on (userId, roleId, channelId)', async () => {
        const table = await getRoleAssignmentTable(queryRunner);
        const uniqueColumnSets = table.uniques.map(u => [...u.columnNames].sort());
        expect(uniqueColumnSets).toContainEqual(['channelId', 'roleId', 'userId']);
    });

    it('has CASCADE foreign keys to user, role and channel', async () => {
        const table = await getRoleAssignmentTable(queryRunner);
        expect(table.foreignKeys).toHaveLength(3);
        for (const fk of table.foreignKeys) {
            expect(fk.onDelete).toBe('CASCADE');
        }
    });

    describe('legacy role migration', () => {
        const channelGuard: ErrorResultGuard<{ id: string }> = createErrorResultGuard(input => !!input.id);

        it('backfills all roles per channel on boot', async () => {
            // The seed data contains the superadmin (SuperAdmin role) and one customer
            // (Customer role), both assigned to the only existing channel, so exactly
            // two assignments are expected.
            const assignments = await getAssignments(queryRunner);
            expect(assignments).toHaveLength(2);
            expect(assignments).toContainEqual({
                identifier: SUPER_ADMIN_USER_IDENTIFIER,
                roleCode: SUPER_ADMIN_ROLE_CODE,
                channelCode: DEFAULT_CHANNEL_CODE,
            });
            expect(
                assignments.filter(a => a.roleCode === CUSTOMER_ROLE_CODE).map(a => a.channelCode),
            ).toEqual([DEFAULT_CHANNEL_CODE]);
        });

        it('re-running the migration backfills newly created legacy relations', async () => {
            const { createChannel } = await adminClient.query(createChannelDocument, {
                input: {
                    code: 'second-channel',
                    token: 'second-channel-token',
                    defaultLanguageCode: LanguageCode.en,
                    currencyCode: CurrencyCode.GBP,
                    pricesIncludeTax: true,
                    defaultShippingZoneId: 'T_1',
                    defaultTaxZoneId: 'T_1',
                },
            });
            channelGuard.assertSuccess(createChannel);
            const { createRole } = await adminClient.query(createRoleDocument, {
                input: {
                    code: 'catalog-manager',
                    description: 'Catalog manager',
                    permissions: [Permission.ReadCatalog],
                    channelIds: [createChannel.id],
                },
            });
            await adminClient.query(createAdministratorDocument, {
                input: {
                    firstName: 'Bob',
                    lastName: 'Bobson',
                    emailAddress: 'bob@test.com',
                    password: 'test',
                    roleIds: [createRole.id],
                },
            });

            const result = await server.app
                .get(RoleAssignmentMigrationService)
                .migrateLegacyRoles();

            // Two new assignments: bob on the new channel, plus the superadmin on the new
            // channel (the SuperAdmin role is auto-assigned to newly created channels, and
            // admin users have no channel membership of their own to restrict them).
            expect(result.created).toBe(2);
            const assignments = await getAssignments(queryRunner);
            expect(assignments).toContainEqual({
                identifier: 'bob@test.com',
                roleCode: 'catalog-manager',
                channelCode: 'second-channel',
            });
            expect(assignments.filter(a => a.roleCode === SUPER_ADMIN_ROLE_CODE)).toEqual([
                {
                    identifier: SUPER_ADMIN_USER_IDENTIFIER,
                    roleCode: SUPER_ADMIN_ROLE_CODE,
                    channelCode: DEFAULT_CHANNEL_CODE,
                },
                {
                    identifier: SUPER_ADMIN_USER_IDENTIFIER,
                    roleCode: SUPER_ADMIN_ROLE_CODE,
                    channelCode: 'second-channel',
                },
            ]);
            // The Customer role is also on the new channel, but the customer user only
            // belongs to the default channel, so the membership check must prevent an
            // assignment on the new channel.
            expect(
                assignments.filter(a => a.roleCode === CUSTOMER_ROLE_CODE).map(a => a.channelCode),
            ).toEqual([DEFAULT_CHANNEL_CODE]);
            expect(assignments).toHaveLength(4);
        });

        it('is idempotent', async () => {
            const result = await server.app
                .get(RoleAssignmentMigrationService)
                .migrateLegacyRoles();

            expect(result.created).toBe(0);
            expect(await getAssignments(queryRunner)).toHaveLength(4);
        });
    });
});

async function getRoleAssignmentTable(queryRunner: QueryRunner) {
    const table = await queryRunner.getTable('role_assignment');
    if (!table) {
        throw new Error('Expected the role_assignment table to exist');
    }
    return table;
}

async function getAssignments(
    queryRunner: QueryRunner,
): Promise<Array<{ identifier: string; roleCode: string; channelCode: string }>> {
    // Raw sqlite query — fine here since e2e tests always run against sql.js
    return queryRunner.query(
        `SELECT u.identifier AS identifier, r.code AS roleCode, c.code AS channelCode
         FROM role_assignment ra
         JOIN "user" u ON u.id = ra.userId
         JOIN role r ON r.id = ra.roleId
         JOIN channel c ON c.id = ra.channelId
         ORDER BY ra.id`,
    );
}
