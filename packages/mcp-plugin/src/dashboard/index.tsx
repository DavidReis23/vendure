import { defineDashboardExtension } from '@vendure/dashboard';

import { mcpAuthorizeRoute } from './mcp-authorize-route';
import { mcpOverviewRoute } from './mcp-overview-route';

defineDashboardExtension({
    routes: [mcpOverviewRoute, mcpAuthorizeRoute],
});
