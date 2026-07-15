import { useIsFetching } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface UseInsightsRefreshOptions {
    /**
     * Auto-refresh is paused while this is `false` (e.g. while the layout is being edited).
     */
    enabled?: boolean;
    /**
     * How often, in milliseconds, the auto-refresh bumps the token. Defaults to 60s.
     */
    intervalMs?: number;
}

export interface InsightsRefresh {
    /** Increments on every manual or automatic refresh; widgets fold it into their query keys. */
    refreshToken: number;
    /** Triggers an immediate refresh of every widget. */
    refresh: () => void;
    /** True while a manually-triggered refresh is still settling. */
    isRefreshing: boolean;
}

/**
 * Page-level refresh signal for the Insights page. Owns a `refreshToken` counter that every
 * widget includes in its React Query key, so a single bump refetches the whole page's data.
 *
 * The token is bumped both by {@link InsightsRefresh.refresh} (the action-bar button) and on an
 * interval while `enabled`. Polling is paused when the tab is hidden and while disabled (edit
 * mode), keeping to the dashboard convention that background refetching is explicit rather than
 * implicit (`refetchOnWindowFocus` is globally off).
 */
export function useInsightsRefresh({
    enabled = true,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
}: UseInsightsRefreshOptions = {}): InsightsRefresh {
    const [refreshToken, setRefreshToken] = useState(0);
    const [manualRefreshPending, setManualRefreshPending] = useState(false);
    const isFetching = useIsFetching();

    const refresh = useCallback(() => {
        setRefreshToken(token => token + 1);
        setManualRefreshPending(true);
    }, []);

    // Clear the manual spinner once in-flight fetches have settled. The short delay after
    // `isFetching` reaches 0 bridges the tick between bumping the token and the widget queries
    // actually starting to refetch, so the spinner does not flicker off immediately.
    useEffect(() => {
        if (!manualRefreshPending || isFetching > 0) {
            return;
        }
        const timer = setTimeout(() => setManualRefreshPending(false), 150);
        return () => clearTimeout(timer);
    }, [manualRefreshPending, isFetching]);

    // Auto-refresh on an interval, but only while the page is enabled and the tab is visible.
    useEffect(() => {
        if (!enabled) {
            return;
        }
        let intervalId: ReturnType<typeof setInterval> | undefined;
        const start = () => {
            if (intervalId === undefined) {
                intervalId = setInterval(() => setRefreshToken(token => token + 1), intervalMs);
            }
        };
        const stop = () => {
            if (intervalId !== undefined) {
                clearInterval(intervalId);
                intervalId = undefined;
            }
        };
        const sync = () => (document.visibilityState === 'visible' ? start() : stop());
        sync();
        document.addEventListener('visibilitychange', sync);
        return () => {
            stop();
            document.removeEventListener('visibilitychange', sync);
        };
    }, [enabled, intervalMs]);

    return { refreshToken, refresh, isRefreshing: manualRefreshPending };
}
