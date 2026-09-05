/**
 * Condition-neutral definition of the Content unit used by capture,
 * Static measurement extraction, focus history, and the questionnaire.
 * Keep this text byte-identical wherever an LLM is asked to create atoms.
 */
export const MEMORY_ATOM_SPEC_VERSION = 'memory-atom-v1';

export const MEMORY_ATOM_SPEC = `Atomic memory rules:
- Each memory unit expresses exactly one independently judgeable proposition: one fact, preference, constraint, or lesson.
- Split independent propositions into separate units. Keep a condition, exception, reason, or consequence with its governing proposition when separating it would change the meaning.
- Make content standalone and semantically complete. Resolve pronouns only from supplied evidence; never invent missing context.
- Preserve the actor, object, action, negation, modality, values, units, temporal qualifiers, and applicability conditions needed to judge correctness.
- Keep Scope separate from Content. Do not encode storage lifetime or reach merely as prose in content.
- Detail may add evidence, examples, or explanation, but it must not contain a qualifier required for the content to be correct.`;
