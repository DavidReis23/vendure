import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { McpOauthToken } from './mcp-oauth-token.entity';

/**
 * @description
 * Represents an active MCP OAuth session, linking an issued access token to the
 * dedicated Vendure session minted for that grant. `vendureSessionId` references the
 * Vendure session so it can be invalidated when the MCP token is revoked or rotated.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
@Entity()
export class McpSession extends VendureEntity {
    constructor(input?: DeepPartial<McpSession>) {
        super(input);
    }

    @Index({ unique: true })
    @ManyToOne(() => McpOauthToken, { onDelete: 'CASCADE' })
    oauthToken: McpOauthToken;

    @EntityId()
    oauthTokenId: ID;

    /** ID of the dedicated Vendure session minted for this grant. */
    @Index()
    @EntityId()
    vendureSessionId: ID;

    @Index()
    @EntityId({ nullable: true })
    channelId: ID | null;

    @Index()
    @Column({ type: Date })
    lastActivityAt: Date;

    @Index()
    @Column({ type: Date })
    expiresAt: Date;
}
