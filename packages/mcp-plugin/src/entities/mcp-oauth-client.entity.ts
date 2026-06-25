import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * @description
 * Metadata for an MCP client registered via OAuth Dynamic Client Registration.
 *
 * @docsCategory core plugins/McpPlugin
 * @since 3.8.0
 */
@Entity()
export class McpOauthClient extends VendureEntity {
    constructor(input?: DeepPartial<McpOauthClient>) {
        super(input);
    }

    @Index({ unique: true })
    @Column()
    clientId: string;

    @Column()
    clientName: string;

    @Column({ type: 'varchar', nullable: true })
    clientUri: string | null;

    @Column({ type: 'varchar', nullable: true })
    logoUri: string | null;

    @Column({ type: 'simple-json' })
    redirectUris: string[];

    @Column({ type: 'simple-json' })
    grantTypes: string[];

    @Column({ default: 'none' })
    tokenEndpointAuthMethod: string;

    @Column({ type: Date, nullable: true })
    lastUsedAt: Date | null;
}
