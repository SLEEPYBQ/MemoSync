// Compile engine-neutral MemoryToolSpecs into pi-coding-agent custom tools
// (ToolDefinition[]). Pi sessions register these at session creation; when the
// model calls one, execute() funnels through the caller-supplied invoker, which
// the coordinator backs with dispatchMemoryTool under engine "pi".
import { z } from 'zod';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { TSchema } from 'typebox';
import type { MemoryToolSpec } from './tools';

export interface PiMemoryToolInvokeResult {
  text: string;
  isError?: boolean;
}

export type PiMemoryToolInvoker = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
) => Promise<PiMemoryToolInvokeResult>;

function piSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(piSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const result = Object.fromEntries(
    Object.entries(schema as Record<string, unknown>).map(([key, value]) => [key, piSchema(value)]),
  );
  const variants = result.anyOf;
  if (Array.isArray(variants) && variants.length > 0 && variants.every(variant =>
    variant && typeof variant === 'object' && Object.keys(variant).length === 1
    && ['string', 'number', 'integer', 'boolean', 'null'].includes(variant.type),
  )) {
    // Pi coerces anyOf values into the first matching branch, which can turn
    // numbers into strings. A type array accepts the same values while keeping
    // their types.
    result.type = [...new Set(variants.map(variant => variant.type))];
    delete result.anyOf;
  }
  return result;
}

/** Declarations to pass as `customTools` when creating a Pi agent session. */
export function toPiToolDefinitions(
  specs: MemoryToolSpec[],
  invoke: PiMemoryToolInvoker,
): ToolDefinition[] {
  return specs.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    promptSnippet: spec.description,
    parameters: piSchema(z.toJSONSchema(z.object(spec.schema))) as TSchema,
    async execute(_callId, input, signal) {
      const result = await invoke(spec.name, input as Record<string, unknown>, signal);
      if (result.isError) throw new Error(result.text);
      return { content: [{ type: 'text' as const, text: result.text }], details: {} };
    },
  }));
}
