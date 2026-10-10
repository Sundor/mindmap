// zod schemas for architecture.yaml.
//
// Each schema validates one level of the file; nested lists are typed as `unknown[]` and validated
// element by element by the parser. That way one malformed entry produces its own diagnostics
// without hiding the rest of the file (IDs, edges and rows are still checked everywhere).
// Unknown keys are not rejected here: the parser reports them as warnings (see `knownKeys`).
// An optional key left empty in YAML (`edges:` or `description:` with nothing after it) parses
// as null and is treated as absent, since that is common while editing.

import { z } from './zod';
import { EDGE_KINDS, FLOW_KINDS } from './model';

/** Optional field where an empty YAML value (null) means the same as leaving the key out. */
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => value ?? undefined, schema.optional());
}

/** Text that must say something: surrounding whitespace is dropped, and some must remain. */
const requiredText = z.string().trim().min(1);
const optionalText = optional(z.string());
const nestedList = optional(z.array(z.unknown()));

/** Top level of the file. */
export const FileSchema = z.object({
  version: z.literal(1),
  rows: nestedList,
  domains: z.array(z.unknown()),
  edges: nestedList,
  flows: nestedList,
  presets: nestedList,
});

export const RowSchema = z.object({
  id: z.string(),
  name: requiredText,
  description: optionalText,
});

const nodeFields = {
  id: z.string(),
  name: requiredText,
  description: optionalText,
  row: optionalText,
  owner: optionalText,
  status: optionalText,
  tech: optionalText,
  links: nestedList,
  /** Numbers by name; a value that is not a finite number is an error (checked by the parser). */
  metrics: optional(z.record(z.string(), z.unknown())),
  /** Values by name; what a value may be is checked by the parser. */
  labels: optional(z.record(z.string(), z.unknown())),
};

/** One entry of a node's `links`. */
export const LinkSchema = z.object({
  label: optionalText,
  url: requiredText,
});

export const FlowSchema = z.object({
  id: z.string(),
  name: requiredText,
  kind: optional(z.enum(FLOW_KINDS)),
  description: optionalText,
  edges: nestedList,
  nodes: nestedList,
});

/**
 * One entry of `presets`. What a colour may be is checked by the parser: a wrong one is a
 * warning, not an error.
 */
export const PresetSchema = z.object({
  name: requiredText,
  label: requiredText,
  description: optionalText,
  values: optional(z.record(z.string(), z.unknown())),
});

export const DomainSchema = z.object({ ...nodeFields, components: nestedList });
export const ComponentSchema = z.object({ ...nodeFields, subcomponents: nestedList });
export const SubcomponentSchema = z.object(nodeFields);

export const EdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(EDGE_KINDS),
  label: optionalText,
  protocol: optionalText,
  description: optionalText,
});

export type FileHeader = z.infer<typeof FileSchema>;
export type RowEntry = z.infer<typeof RowSchema>;
export type DomainEntry = z.infer<typeof DomainSchema>;
export type ComponentEntry = z.infer<typeof ComponentSchema>;
export type SubcomponentEntry = z.infer<typeof SubcomponentSchema>;
export type EdgeEntry = z.infer<typeof EdgeSchema>;
export type LinkEntry = z.infer<typeof LinkSchema>;
export type FlowEntry = z.infer<typeof FlowSchema>;
export type PresetEntry = z.infer<typeof PresetSchema>;

/** Keys a schema accepts; anything else in the YAML mapping is reported as an unknown key. */
export function knownKeys(schema: { shape: Record<string, unknown> }): readonly string[] {
  return Object.keys(schema.shape);
}
