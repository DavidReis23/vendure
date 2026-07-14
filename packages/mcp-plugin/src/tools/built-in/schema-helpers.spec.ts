import { describe, expect, it } from 'vitest';

describe('built-in schema helpers', () => {
    it('closes fixed object schemas and only requires non-optional properties', async () => {
        const { idProp, numberProp, objectSchema, optional, stringProp } = await import('./schema-helpers');

        expect(
            objectSchema({
                id: idProp('Entity ID.'),
                query: optional(stringProp()),
                limit: optional(numberProp()),
            }),
        ).toEqual({
            type: 'object',
            properties: {
                id: {
                    anyOf: [{ type: 'string' }, { type: 'number' }],
                    description: 'Entity ID.',
                },
                query: { type: 'string' },
                limit: { type: 'number' },
            },
            required: ['id'],
            additionalProperties: false,
        });
    });

    it('allows additional properties only for an explicit JSON bag', async () => {
        const { jsonObjectProp, objectSchema } = await import('./schema-helpers');

        expect(
            objectSchema({
                customFields: jsonObjectProp('Custom field values.'),
            }),
        ).toEqual({
            type: 'object',
            properties: {
                customFields: {
                    type: 'object',
                    description: 'Custom field values.',
                    additionalProperties: true,
                },
            },
            required: ['customFields'],
            additionalProperties: false,
        });
    });
});
