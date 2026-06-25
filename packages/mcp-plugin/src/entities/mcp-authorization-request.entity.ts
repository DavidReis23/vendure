import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { McpToolset } from '../types';

import { McpOauthClient } from './mcp-oauth-client.entity';

/**
 * @description
 * A pending OAuth authorization request, saved before the user consents. Holds the
 * PKCE challenge and redirect parameters, plus a short-lived `requestToken` (stored
 * as a hash) that links the consent page back to this request.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
@Entity()
export class McpAuthorizationRequest extends VendureEntity {
    constructor(input?: DeepPartial<McpAuthorizationRequest>) {
        super(input);
    }

    @Index({ unique: true })
    @Column()
    requestToken: string;

    @Index()
    @ManyToOne(() => McpOauthClient, { onDelete: 'CASCADE' })
    oauthClient: McpOauthClient;

    @EntityId()
    oauthClientId: ID;

    @Column()
    redirectUri: string;

    @Column({ type: 'varchar', nullable: true })
    state: string | null;

    @Column()
    codeChallenge: string;

    @Column({ default: 'S256' })
    codeChallengeMethod: string;

    @Column({ type: 'varchar' })
    toolset: McpToolset;

    @Index()
    @Column()
    resource: string;

    @Index()
    @Column({ type: Date })
    expiresAt: Date;

    @Index()
    @Column({ type: Date, nullable: true })
    consumedAt: Date | null;
}
