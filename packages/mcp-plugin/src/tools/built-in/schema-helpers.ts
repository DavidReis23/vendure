import type { McpJsonSchema } from '@vendure/mcp-sdk';

export type JsonSchemaProperty = Record<string, unknown>;

const optionalProperty = Symbol('optionalProperty');

interface OptionalProperty {
    [optionalProperty]: true;
    schema: JsonSchemaProperty;
}

type ObjectProperty = JsonSchemaProperty | OptionalProperty;

export function objectSchema(
    properties: Record<string, ObjectProperty>,
    description?: string,
): McpJsonSchema {
    const expandedProperties: Record<string, JsonSchemaProperty> = {};
    const required: string[] = [];

    for (const [name, property] of Object.entries(properties)) {
        if (isOptionalProperty(property)) {
            expandedProperties[name] = property.schema;
        } else {
            expandedProperties[name] = property;
            required.push(name);
        }
    }

    return {
        type: 'object',
        ...(description ? { description } : {}),
        properties: expandedProperties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
    };
}

export function optional(schema: JsonSchemaProperty): OptionalProperty {
    return { [optionalProperty]: true, schema };
}

export function stringProp(description?: string): JsonSchemaProperty {
    return { type: 'string', ...(description ? { description } : {}) };
}

export function numberProp(description?: string): JsonSchemaProperty {
    return { type: 'number', ...(description ? { description } : {}) };
}

export function booleanProp(description?: string): JsonSchemaProperty {
    return { type: 'boolean', ...(description ? { description } : {}) };
}

export function idProp(description?: string): JsonSchemaProperty {
    return {
        anyOf: [{ type: 'string' }, { type: 'number' }],
        ...(description ? { description } : {}),
    };
}

export function arrayProp(items: JsonSchemaProperty, description?: string): JsonSchemaProperty {
    return {
        type: 'array',
        ...(description ? { description } : {}),
        items,
    };
}

export function idArrayProp(description?: string): JsonSchemaProperty {
    return arrayProp(idProp('Vendure ID.'), description);
}

export function jsonObjectProp(description?: string): JsonSchemaProperty {
    return {
        type: 'object',
        ...(description ? { description } : {}),
        additionalProperties: true,
    };
}

function isOptionalProperty(property: ObjectProperty): property is OptionalProperty {
    return optionalProperty in property;
}
