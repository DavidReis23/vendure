import { PluginCommonModule } from '../plugin-common.module';
import { VendurePlugin } from '../vendure-plugin';

import { RoleAssignment } from './role-assignment.entity';

/**
 * This plugin is registered internally by Vendure when the `experimental.roleAssignments.enabled`
 * config flag is set to `true` (see `VendureConfig.experimental`). It is never meant to be added
 * manually to the `plugins` array.
 *
 * This is currently a skeleton which only registers the `RoleAssignment` entity — a bridge
 * between User, Role and Channel intended to eventually decouple Role definitions from Channel
 * assignments. The permission-resolution logic, service layer and API are not yet implemented.
 *
 * @internal
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [RoleAssignment],
    compatibility: '>0.0.0',
})
export class RoleAssignmentPlugin {}
