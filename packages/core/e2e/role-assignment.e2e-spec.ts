import { RoleAssignmentPlugin, TransactionalConnection, mergeConfig } from '@vendure/core';
import { preBootstrapConfig } from '@vendure/core/dist/bootstrap';
import { createTestEnvironment } from '@vendure/testing';
import path from 'path';
import { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';

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
});

async function getRoleAssignmentTable(queryRunner: QueryRunner) {
    const table = await queryRunner.getTable('role_assignment');
    if (!table) {
        throw new Error('Expected the role_assignment table to exist');
    }
    return table;
}
