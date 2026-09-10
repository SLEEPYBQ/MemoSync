type Schema = Record<string, unknown>;
const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const list = (items: Schema): Schema => ({ type: 'array', items });
const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const enumeration = (...values: string[]): Schema => ({ type: 'string', enum: values });
const ids = list(text);
const candidate = object({
  proposalId: text, content: text, detail: nullableText, topic: nullableText,
  type: enumeration('constraint', 'preference', 'lesson', 'fact'), scope: enumeration('personal', 'project', 'session'),
  abstractionLevel: enumeration('concrete', 'contextual', 'general'), sensitive: { type: 'boolean' },
  evidenceClass: enumeration('user_stated', 'user_corrected', 'inferred', 'agent_proposed'),
  route: enumeration('new', 'updates', 'reinforces', 'conflicts', 'reinforces-dismissed', 'duplicate-in-batch'),
  targetId: nullableText, targetVersion: { type: ['integer', 'null'] },
});
const transfer = object({
  proposalId: text, sourceId: text, sourceVersion: { type: 'integer' },
  encoding: object({ rule: text, portable: { type: 'boolean' }, applicability: nullableText, stripped: ids, note: text }),
  decoding: object({
    content: text, detail: nullableText, abstractionLevel: enumeration('concrete', 'contextual', 'general'),
    suggestedScope: enumeration('personal', 'project', 'session'), bound: ids, note: text,
    landing: object({ route: enumeration('new', 'reinforces', 'conflicts'), targetId: nullableText, targetVersion: { type: ['integer', 'null'] } }),
  }),
});
const pair = object({ memoryId: text, otherMemoryId: text, reason: text });
const stale = object({ memoryId: text, reason: text });
const collections: Record<'candidate' | 'transfer' | 'changes', Record<string, Schema>> = {
  candidate: { candidates: list(candidate) }, transfer: { suggestions: list(transfer) },
  changes: { conflicts: list(pair), redundancy: list(pair), staleness: list(stale) },
};

/** Strict schemas work with both CLI runtimes; the domain parsers still validate IDs and versions. */
export function memoryStageSchema(stage: 'candidate' | 'transfer' | 'changes' | 'working-memory' | 'audit'): Schema {
  if (stage === 'working-memory') return object({ selected: list(object({ id: text, why: text, expectedUse: text })), reply: text });
  if (stage === 'audit') return object({ labels: list(object({
    id: text, label: enumeration('operational', 'injected_without_effect', 'not_applicable', 'violated'), note: text,
    quote: nullableText, toolId: nullableText, cause: { type: ['string', 'null'], enum: ['not_followed', 'memory_conflict', null] },
    missing: nullableText, impact: { type: ['string', 'null'], enum: ['negative', 'none', null] },
  })), summary: text });
  return object(collections[stage]);
}

export function memoryStageDeltaSchema(stage: 'transfer' | 'changes'): Schema {
  return object({ upsert: object(collections[stage]), remove: object(Object.fromEntries(Object.keys(collections[stage]).map(key => [key, ids]))) });
}
