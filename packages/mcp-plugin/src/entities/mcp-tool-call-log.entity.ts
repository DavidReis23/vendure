import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { McpActorType, McpToolCallStatus } from '../types';

import { McpOauthClient } from './mcp-oauth-client.entity';
import { McpSession } from './mcp-session.entity';

/**
 * @description
 * Audit record of a single MCP tool call. Input and output are stored as JSON;
 * PII redaction is applied at write time. Rows are retained even if the associated
 * session or OAuth client is later deleted.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
@Entity()
export class McpToolCallLog extends VendureEntity {
    constructor(input?: DeepPartial<McpToolCallLog>) {
        super(input);
    }

    @Index()
    @ManyToOne(() => McpSession, { nullable: true, onDelete: 'SET NULL' })
    session: McpSession | null;

    @EntityId({ nullable: true })
    sessionId: ID | null;

    @Column({ type: 'varchar', nullable: true })
    actor: string | null;

    @Column({ type: 'varchar' })
    actorType: McpActorType;

    @Index()
    @EntityId({ nullable: true })
    channelId: ID | null;

    @Index()
    @Column()
    toolName: string;

    @Column({ type: 'varchar', nullable: true })
    pluginSource: string | null;

    @Column({ type: 'simple-json', nullable: true })
    input: unknown | null;

    @Column({ type: 'simple-json', nullable: true })
    output: unknown | null;

    @Column({ type: 'int', nullable: true })
    durationMs: number | null;

    @Index()
    @Column({ type: 'varchar' })
    status: McpToolCallStatus;

    @Index()
    @ManyToOne(() => McpOauthClient, { nullable: true, onDelete: 'SET NULL' })
    oauthClient: McpOauthClient | null;

    @EntityId({ nullable: true })
    oauthClientId: ID | null;
}
