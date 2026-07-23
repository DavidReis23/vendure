import { Trans, useLingui } from '@lingui/react/macro';
import {
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
    CopyableText,
    DashboardRouteDefinition,
} from '@vendure/dashboard';
import { AlertTriangleIcon, ExternalLinkIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

/**
 * Shape returned by the `/mcp/oauth/authorization-request` REST endpoint. Mirrors
 * `AuthorizationRequestInfo` from the OAuth service.
 */
interface AuthRequestInfo {
    client_id: string;
    client_name: string;
    client_uri?: string;
    logo_uri?: string;
    redirect_uri: string;
    resource: string;
    toolset: string;
}

function ConsentCard({ session }: { session: string }) {
    const { t } = useLingui();
    const [info, setInfo] = useState<AuthRequestInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch(`/mcp/oauth/authorization-request?session=${encodeURIComponent(session)}`, {
            credentials: 'include',
        })
            .then(async res => {
                if (!res.ok) {
                    throw new Error(`Request failed (${res.status})`);
                }
                return res.json();
            })
            .then((data: AuthRequestInfo) => {
                if (!cancelled) {
                    setInfo(data);
                    setLoading(false);
                }
            })
            .catch((e: unknown) => {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : String(e));
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [session]);

    const submit = async (approved: boolean) => {
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch('/mcp/oauth/admin-consent', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ session, approved }),
            });
            if (!res.ok) {
                throw new Error(`Request failed (${res.status})`);
            }
            const data: { redirectUrl: string } = await res.json();
            window.location.href = data.redirectUrl;
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    };

    if (loading) {
        return (
            <Card className="w-full max-w-lg">
                <CardContent className="py-8 text-center text-muted-foreground">
                    <Trans>Loading authorization request…</Trans>
                </CardContent>
            </Card>
        );
    }

    if (error || !info) {
        return (
            <Card className="w-full max-w-lg">
                <CardHeader>
                    <CardTitle>
                        <Trans>Authorization request could not be loaded</Trans>
                    </CardTitle>
                    <CardDescription>{error ?? t`The authorization session is invalid or expired.`}</CardDescription>
                </CardHeader>
            </Card>
        );
    }

    return (
        <Card className="w-full max-w-lg">
            <CardHeader>
                <div className="flex items-center gap-3">
                    {info.logo_uri ? (
                        <img
                            src={info.logo_uri}
                            alt={info.client_name}
                            className="h-10 w-10 rounded-md object-contain"
                        />
                    ) : null}
                    <div>
                        <CardTitle>{info.client_name}</CardTitle>
                        {info.client_uri ? (
                            <a
                                href={info.client_uri}
                                target="_blank"
                                rel="noreferrer"
                                className="text-sm text-muted-foreground inline-flex items-center gap-1 hover:underline"
                            >
                                {info.client_uri}
                                <ExternalLinkIcon className="h-3 w-3" />
                            </a>
                        ) : null}
                    </div>
                </div>
                <CardDescription className="pt-2">
                    <Trans>
                        This application is requesting permission to access your Vendure MCP server on your
                        behalf.
                    </Trans>
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">
                        <Trans>Requested access</Trans>
                    </div>
                    <Badge variant="secondary">{info.toolset}</Badge>
                </div>
                <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                    <div className="flex items-center gap-2 text-xs font-medium">
                        <AlertTriangleIcon className="h-4 w-4 text-amber-600" />
                        <Trans>After approving, you will be redirected to</Trans>
                    </div>
                    <CopyableText value={info.redirect_uri}>
                        <code className="font-mono text-sm break-all">{info.redirect_uri}</code>
                    </CopyableText>
                    <p className="text-xs text-muted-foreground">
                        <Trans>Only approve if you recognise and trust this destination.</Trans>
                    </p>
                </div>
            </CardContent>
            <CardFooter className="justify-end gap-2">
                <Button variant="outline" disabled={submitting} onClick={() => void submit(false)}>
                    <Trans>Deny</Trans>
                </Button>
                <Button disabled={submitting} onClick={() => void submit(true)}>
                    <Trans>Approve</Trans>
                </Button>
            </CardFooter>
        </Card>
    );
}

export const mcpAuthorizeRoute: DashboardRouteDefinition = {
    path: '/mcp/authorize',
    loader: () => ({ breadcrumb: 'Authorize MCP Client' }),
    validateSearch: search => z.object({ session: z.string() }).parse(search),
    component: route => {
        const { session } = route.useSearch();
        return (
            <div className="flex justify-center p-8">
                <ConsentCard session={session} />
            </div>
        );
    },
};
