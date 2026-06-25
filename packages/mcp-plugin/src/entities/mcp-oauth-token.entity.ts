import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { McpActorType, McpOauthTokenType } from '../types';

import { McpOauthClient } from './mcp-oauth-client.entity';

/**
 * @description
 * An issued MCP OAuth access or refresh token. The `token` is stored as a hash, not
 * in the clear, so it can be looked up without keeping the raw secret.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
@Entity()
export class McpOauthToken extends VendureEntity {
    constructor(input?: DeepPartial<McpOauthToken>) {
        super(input);
    }

    @Index({ unique: true })
    @Column()
    token: string;

    @Index()
    @Column({ type: 'varchar' })
    tokenType: McpOauthTokenType;

    @Index()
    @ManyToOne(() => McpOauthClient, { onDelete: 'CASCADE' })
    oauthClient: McpOauthClient;

    @EntityId()
    oauthClientId: ID;

    @Index()
    @EntityId({ nullable: true })
    userId: ID | null;

    @Column({ type: 'varchar', nullable: true })
    userType: McpActorType | null;

    @Index()
    @Column()
    resource: string;

    @Index()
    @Column({ type: Date })
    expiresAt: Date;

    @Index()
    @Column({ type: Date, nullable: true })
    revokedAt: Date | null;
}
