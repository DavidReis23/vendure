import { ServerConfigContext } from '@/vdb/providers/server-config.js';
import React from 'react';

export const useServerConfig = () => React.useContext(ServerConfigContext);

/**
 * @description
 * Returns whether the server config has been loaded yet. Useful for
 * distinguishing "loading" from "no value configured" so callers can render
 * a skeleton instead of nothing while the initial server config request is
 * in flight.
 *
 * @docsCategory hooks
 * @since 3.6.4
 */
export const useIsServerConfigLoaded = (): boolean => useServerConfig() != null;

/**
 * @description
 * Returns whether the given experimental feature (a key of the `experimental`
 * section of the VendureConfig, e.g. `'roleAssignments'`) is enabled on the
 * server. Returns `false` while the server config is still loading.
 *
 * @docsCategory hooks
 * @since 3.8.0
 */
export const useExperimentalFeature = (feature: string): boolean =>
    useServerConfig()?.experimentalFeatures.includes(feature) ?? false;
