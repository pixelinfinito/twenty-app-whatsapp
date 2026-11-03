import type { InputJsonSchema } from 'twenty-sdk/logic-function';
import { ToolError } from './tool-errors';

export const validateToolInput = (schema: InputJsonSchema, value: unknown, path = 'input'): void => {
  const alternatives = (schema as InputJsonSchema & { anyOf?: InputJsonSchema[] }).anyOf;
  if (alternatives) {
    for (const child of alternatives) {
      try { validateToolInput(child, value, path); return; } catch (error) { if (!(error instanceof ToolError)) throw error; }
    }
    throw new ToolError('INVALID_INPUT', `${path}: invalid value`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new ToolError('INVALID_INPUT', `${path}: invalid value`);
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolError('INVALID_INPUT', `${path}: expected object`);
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object) || object[key] === undefined) throw new ToolError('INVALID_INPUT', `${path}.${key}: required`);
    }
    for (const [key, item] of Object.entries(object)) {
      const child = schema.properties?.[key];
      if (child) validateToolInput(child, item, `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new ToolError('INVALID_INPUT', `${path}.${key}: unknown field`);
      else if (typeof schema.additionalProperties === 'object') validateToolInput(schema.additionalProperties, item, `${path}.${key}`);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) throw new ToolError('INVALID_INPUT', `${path}: expected array`);
    if (value.length > 200) throw new ToolError('INVALID_INPUT', `${path}: at most 200 items`);
    if (schema.items) value.forEach((item, index) => validateToolInput(schema.items!, item, `${path}[${index}]`));
  } else if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value)) ||
      (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) {
      throw new ToolError('INVALID_INPUT', `${path}: invalid number`);
    }
  } else if (type && type !== 'null' && typeof value !== type) {
    throw new ToolError('INVALID_INPUT', `${path}: expected ${type}`);
  } else if (type === 'null' && value !== null) throw new ToolError('INVALID_INPUT', `${path}: expected null`);
};

export const string: InputJsonSchema = { type: 'string' };
export const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as InputJsonSchema;
export const boolean: InputJsonSchema = { type: 'boolean' };
export const json: InputJsonSchema = { type: 'object', additionalProperties: true };
export const strings: InputJsonSchema = { type: 'array', items: string };
export const page = { first: { type: 'integer', minimum: 1, maximum: 50 } as InputJsonSchema, after: string };
export const mutation = {
  requestId: { type: 'string', description: 'UUID v4. Reuse for retries of exactly this request; never replace after an uncertain outcome.' } as InputJsonSchema,
  phase: { type: 'string', enum: ['preview', 'execute'], description: 'Bulk/destructive actions default to preview. Obtain explicit user approval before execute.' } as InputJsonSchema,
  confirmationToken: { type: 'string', description: 'Token from the approved preview; expires in ten minutes.' } as InputJsonSchema,
};
export const object = (properties: Record<string, InputJsonSchema>, required: string[] = []): InputJsonSchema =>
  ({ type: 'object', additionalProperties: false, properties, required });
