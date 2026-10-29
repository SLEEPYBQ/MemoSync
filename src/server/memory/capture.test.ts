import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from './index';
import { createCaptureService, validateCandidate } from './capture';

import { MEMORY_ATOM_SPEC } from './atom-spec';
import { LlmJsonError, type DeepSeekJsonRequest, type LlmJsonCaller } from './deepseek';
import { handleMemoryRequest } from './routes';

/** A scripted LlmJsonCaller: returns the next queued response per call, records every call. */
function stubCaller(responses: Array<Record<string, unknown>>): { call: LlmJsonCaller; calls: DeepSeekJsonRequest[] } {
  const calls: DeepSeekJsonRequest[] = [];
  const call: LlmJsonCaller = async (req) => {
    calls.push(req);
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`stubCaller: no response queued for call #${calls.length}`);
    return next;
  };
  return { call, calls };
}

function fakeLogger() {
  const events: unknown[] = [];
  return { logger: { event: (e: unknown) => void events.push(e) }, events };
}

let dir: string;
let memory: MemoryService;

describe('createCaptureService (routing gate, REDESIGN D4)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memv2-capture-'));
  });
  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('short-circuits when pass 1 yields zero candidates (routing pass never called)', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call, calls } = stubCaller([{ candidates: [] }]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.capture({
      sessionId: 's1',
      userText: 'thanks, that works',
      assistantText: 'Glad it worked!',
    });

    expect(outcome).toEqual({
      created: [],
      proposed: 0,
      surfaced: 0,
      dropped: 0,
      conflicts: 0,
      reinforced: 0,
      reinforcedIds: [],
      revisions: 0,
      pending: [],
    });
    expect(calls).toHaveLength(1); // routing must NOT have been called
  });

  it('happy path: new candidate surfaces; in-batch restatement is counted once, not carded twice', async () => {
    const { logger, events } = fakeLogger();
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir, logger });
    const { call, calls } = stubCaller([
      {
        candidates: [
          {
            content: 'Always use pnpm, never npm, in this repo',
            detail: 'The user explicitly asked to standardize on pnpm for installs and scripts in this repo. Using npm caused lockfile drift previously.',
            type: 'constraint',
            scope: 'project',
            topic: 'Tooling',
            abstractionLevel: 'contextual',
            sensitive: false,
          },
          {
            content: 'User prefers pnpm over npm',
            detail: 'Restated preference for pnpm, effectively the same fact as the first candidate.',
            type: 'preference',
            scope: 'project',
            topic: 'Tooling',
            abstractionLevel: 'contextual',
            sensitive: false,
          },
        ],
      },
      {
        decisions: [
          { index: 0, route: 'new', targetId: null, reason: 'new durable constraint worth persisting' },
          { index: 1, route: 'duplicate-in-batch', targetId: null, reason: 'restates candidate 0' },
        ],
      },
    ]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.capture({
      projectId: 'RenderX',
      sessionId: 's1',
      turn: 3,
      engine: 'claude',
      userText: 'Please always use pnpm, not npm, in this repo.',
      assistantText: 'Got it, I will use pnpm going forward.',
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.system).toContain(MEMORY_ATOM_SPEC);
    expect(outcome.proposed).toBe(2);
    expect(outcome.surfaced).toBe(1);
    expect(outcome.dropped).toBe(1);
    expect(outcome.created).toHaveLength(1);

    const created = outcome.created[0]!;
    expect(created.content).toBe('Always use pnpm, never npm, in this repo');
    expect(created.status).toBe('candidate');
    expect(created.scope).toBe('project');
    expect(created.projectId).toBe('RenderX');
    expect(created.type).toBe('constraint');
    expect(created.abstractionLevel).toBe('contextual');
    expect(created.sensitive).toBe(false);
    expect(created.provenanceSessionId).toBe('s1');
    expect(created.provenanceTurn).toBe(3);

    // Store actually persisted exactly one candidate.
    const stored = memory.store.list({ scope: 'project', projectId: 'RenderX', status: 'candidate' });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(created.id);

    // The create event on the store records actor 'agent' + session/turn provenance.
    const storeEvents = memory.store.getEvents(created.id);
    expect(storeEvents).toHaveLength(1);
    expect(storeEvents[0]!.kind).toBe('create');
    expect(storeEvents[0]!.actor).toBe('agent');
    expect(storeEvents[0]!.sessionId).toBe('s1');
    expect(storeEvents[0]!.turn).toBe(3);

    // Logger: one memory.propose per created item, then one memory.capture summary.
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'memory.propose',
      sessionId: 's1',
      engine: 'claude',
      id: created.id,
      memType: 'constraint',
      scope: 'project',
      via: undefined,
    });
    expect(events[1]).toEqual({
      type: 'memory.capture',
      sessionId: 's1',
      engine: 'claude',
      turn: 3,
      status: 'ok',
      channel: 'hook',
      proposed: 2,
      surfaced: 1,
      dropped: 1,
      sensitive: 0,
      reinforced: 0,
      revisions: 0,
      sameTurnDuplicates: 0,
    });
  });

  it('the gate has NO discard verdict: a missing decision defaults to "new" and the candidate surfaces', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call } = stubCaller([
      {
        candidates: [
          { content: 'SSH deploy key lives at ~/.ssh/id_ed25519_server', type: 'fact', scope: 'personal', abstractionLevel: 'concrete', sensitive: false },
        ],
      },
      { decisions: [] }, // gate lost the verdict — the observation must survive
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const outcome = await capture.capture({ sessionId: 's', userText: 'u', assistantText: 'a' });
    expect(outcome.created).toHaveLength(1);
    expect(outcome.dropped).toBe(0);
  });

  it('an unknown route value also degrades to "new" (never a silent drop)', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call } = stubCaller([
      { candidates: [{ content: 'Repo uses bun', type: 'fact', scope: 'project', abstractionLevel: 'contextual', sensitive: false }] },
      { decisions: [{ index: 0, route: 'too-trivial-discard', targetId: null }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const outcome = await capture.capture({ projectId: 'RenderX', sessionId: 's', userText: 'u', assistantText: 'a' });
    expect(outcome.created).toHaveLength(1);
  });

  it('reinforces-dismissed: reworded repeats of dismissed cards are suppressed, and the dismissed list is in the prompt', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const rejected = memory.store.create(
      { content: 'User dislikes celery', scope: 'personal', type: 'preference', status: 'candidate' },
      { actor: 'agent' },
    );
    memory.store.dismissCandidate(rejected.id, { actor: 'user' });

    const { call, calls } = stubCaller([
      {
        candidates: [
          { content: 'The user does not want celery in recipes', type: 'preference', scope: 'personal', abstractionLevel: 'general', sensitive: false },
        ],
      },
      { decisions: [{ index: 0, route: 'reinforces-dismissed', targetId: null, reason: 'reworded dismissed card' }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const outcome = await capture.capture({ sessionId: 's1', userText: 'no celery please', assistantText: 'Noted.' });

    expect(calls[1]!.user).toContain('Recently dismissed by the user');
    expect(calls[1]!.user).toContain('User dislikes celery');
    expect(outcome).toMatchObject({ surfaced: 0, dropped: 1 });
    expect(memory.store.list({ status: 'candidate' })).toEqual([]);
  });

  it('drops an exact dismissed candidate locally without sending its text back to the LLM', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const rejected = memory.store.create(
      { content: 'User dislikes celery', scope: 'personal', type: 'preference', status: 'candidate' },
      { actor: 'agent' },
    );
    memory.store.discardCandidate(rejected.id);

    const { call, calls } = stubCaller([
      {
        candidates: [
          {
            content: '  USER  DISLIKES CELERY ',
            type: 'preference',
            scope: 'personal',
            abstractionLevel: 'general',
            sensitive: false,
          },
        ],
      },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const outcome = await capture.capture({ sessionId: 's1', userText: 'no celery please', assistantText: 'Noted.' });

    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({ surfaced: 0, dropped: 1 });
    expect(memory.store.list({ status: 'candidate' })).toEqual([]);
  });

  it('omits the dismissed section when the user has never rejected a candidate', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call, calls } = stubCaller([
      {
        candidates: [
          { content: 'Repo uses bun', type: 'fact', scope: 'project', abstractionLevel: 'contextual', sensitive: false },
        ],
      },
      { decisions: [{ index: 0, route: 'new', targetId: null, reason: 'durable' }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    await capture.capture({ projectId: 'RenderX', sessionId: 's1', userText: 'u', assistantText: 'a' });

    expect(calls[1]!.user).not.toContain('Recently dismissed by the user');
  });

  it('clamps unknown enums, preserves an over-limit complete candidate, and downgrades project->session without a projectId', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const longContent = `${Array.from({ length: 101 }, (_, index) => `word${index + 1}`).join(' ')}.`;
    const { call } = stubCaller([
      {
        candidates: [
          {
            content: longContent,
            type: 'nonsense-type',
            scope: 'project', // no projectId on the input -> must downgrade to 'session'
            abstractionLevel: 'nonsense-level',
            sensitive: true,
          },
        ],
      },
      {
        decisions: [{ index: 0, route: 'new', targetId: null, reason: 'novel fact' }],
      },
    ]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.capture({
      sessionId: 's2',
      turn: 1,
      userText: 'my api key is sk-abc123',
      assistantText: 'Noted (but I will not store secrets in plain text).',
    });

    expect(outcome.created).toHaveLength(1);
    const created = outcome.created[0]!;
    // The 100-word target is an extraction contract. If a provider overruns
    // it, preserve the complete statement instead of manufacturing a broken
    // half-sentence with a character slice.
    expect(created.content).toBe(longContent);
    expect(created.type).toBe('fact'); // clamped
    expect(created.scope).toBe('session'); // downgraded (no projectId)
    expect(created.sessionId).toBe('s2');
    expect(created.projectId).toBeUndefined();
    expect(created.abstractionLevel).toBe('contextual'); // clamped
    expect(created.sensitive).toBe(true); // sensitive candidates are still created
  });

  it('drops malformed pass-1 entries (missing content / non-object) without discarding valid ones', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call } = stubCaller([
      {
        candidates: [
          { type: 'fact', scope: 'session' }, // missing content -> malformed
          null, // non-object -> malformed
          { content: 'Tests must run with --runInBand on this repo', type: 'constraint', scope: 'project' },
        ],
      },
      {
        decisions: [{ index: 0, route: 'new', targetId: null, reason: 'kept' }],
      },
    ]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.capture({
      projectId: 'RenderX',
      sessionId: 's3',
      userText: 'note: tests must run with --runInBand here',
      assistantText: 'Understood, will use --runInBand.',
    });

    // Only the one well-formed candidate reaches routing / gets counted as "proposed".
    expect(outcome.proposed).toBe(1);
    expect(outcome.surfaced).toBe(1);
    expect(outcome.dropped).toBe(2); // the two malformed entries
    expect(outcome.created).toHaveLength(1);
    expect(outcome.created[0]!.content).toBe('Tests must run with --runInBand on this repo');
  });

  it('does not reinforce (or bind a revision to) a memory whose content moved during the routing await (CAS)', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const stored = memory.store.create(
      { content: 'Use port 3000', scope: 'personal', type: 'constraint' },
      { actor: 'user' },
    );
    const responses: Array<Record<string, unknown>> = [
      {
        candidates: [
          { content: 'Use port 3000', type: 'constraint', scope: 'personal', abstractionLevel: 'contextual', sensitive: false },
          { content: 'Switch the dev server port', type: 'constraint', scope: 'personal', abstractionLevel: 'contextual', sensitive: false },
        ],
      },
      {
        decisions: [
          { index: 0, route: 'reinforces', targetId: stored.id },
          { index: 1, route: 'updates', targetId: stored.id },
        ],
      },
    ];
    let callCount = 0;
    const call = (async () => {
      const next = responses[callCount++];
      // The user rewrites the stored fact while routing is in flight — both
      // verdicts now refer to text that's gone.
      if (callCount === 2) memory.store.update(stored.id, { content: 'Use port 4000' }, { actor: 'user' });
      return next!;
    }) as LlmJsonCaller;
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.capture({ sessionId: 's-cas', userText: 'u', assistantText: 'a' });

    // No reinforcement lands on the user's newer text…
    expect(outcome.reinforced).toBe(0);
    expect(memory.store.getById(stored.id)!.reinforcedCount).toBe(0);
    // …the stale reinforce claim surfaces its observation instead of
    // discarding it, and the update surfaces as a PLAIN candidate — neither
    // binds a revision to the moved target.
    expect(outcome.created).toHaveLength(2);
    for (const created of outcome.created) expect(memory.store.revisionTargetOf(created.id)).toBeNull();
    expect(memory.store.hasOpenRevision(stored.id)).toBe(false);
  });

  it('every capture invocation ends in exactly ONE terminal memory.capture event — zeros and failures included', async () => {
    const { logger, events } = fakeLogger();
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir, logger });
    const captureEvents = () => (events as Array<{ type: string; status?: string; stage?: string }>).filter((e) => e.type === 'memory.capture');

    // Zero candidates from pass 1 → still a terminal ok event with zeros.
    const { call: zeroCall } = stubCaller([{ candidates: [] }]);
    await createCaptureService({ memory, callJson: zeroCall }).capture({ sessionId: 's', userText: 'u', assistantText: 'a' });
    expect(captureEvents()).toHaveLength(1);
    expect(captureEvents()[0]).toMatchObject({ status: 'ok', proposed: 0, surfaced: 0 });

    // An LLM failure → exactly one terminal failed event with the stage.
    const failingCall = (async () => {
      throw new Error('DeepSeek timed out');
    }) as LlmJsonCaller;
    await expect(
      createCaptureService({ memory, callJson: failingCall }).capture({ sessionId: 's', userText: 'u', assistantText: 'a' }),
    ).rejects.toThrow('DeepSeek timed out');
    expect(captureEvents()).toHaveLength(2);
    expect(captureEvents()[1]).toMatchObject({ status: 'failed', stage: 'capture_pass', errorClass: 'Error' });
  });

  it('a reinforce/conflict verdict against a target that moved mid-await surfaces the candidate with no relation (CAS)', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const dupTarget = memory.store.create({ content: 'Use port 3000', scope: 'personal', type: 'constraint' }, { actor: 'user' });
    const conflictTarget = memory.store.create({ content: 'Deploy on Fridays', scope: 'personal', type: 'fact' }, { actor: 'user' });
    const responses: Array<Record<string, unknown>> = [
      {
        candidates: [
          { content: 'Use port 3000', type: 'constraint', scope: 'personal', abstractionLevel: 'contextual', sensitive: false },
          { content: 'Never deploy on Fridays', type: 'fact', scope: 'personal', abstractionLevel: 'contextual', sensitive: false },
        ],
      },
      {
        decisions: [
          { index: 0, route: 'reinforces', targetId: dupTarget.id },
          { index: 1, route: 'conflicts', targetId: conflictTarget.id },
        ],
      },
    ];
    let callCount = 0;
    const call = (async () => {
      const next = responses[callCount++];
      if (callCount === 2) {
        // Both targets move while routing is in flight.
        memory.store.update(dupTarget.id, { content: 'Use port 4000' }, { actor: 'user' });
        memory.store.update(conflictTarget.id, { content: 'Deploys move to Mondays' }, { actor: 'user' });
      }
      return next!;
    }) as LlmJsonCaller;
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.capture({ sessionId: 's-cas2', userText: 'u', assistantText: 'a' });

    // The stale reinforce claim can't discard the observation — it surfaces…
    expect(outcome.created.map((c) => c.content)).toContain('Use port 3000');
    expect(outcome.reinforced).toBe(0);
    // …and the stale conflict claim creates NO conflicts_with relation.
    const conflicted = outcome.created.find((c) => c.content === 'Never deploy on Fridays')!;
    expect(conflicted.status).toBe('candidate');
    expect(memory.store.getById(conflicted.id)!.relations ?? []).toHaveLength(0);
    expect(outcome.conflicts).toBe(0);
  });

  it('keeps a gate-approved candidate when a reinforce verdict names a nonexistent id (bug #8 lineage)', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call } = stubCaller([
      {
        candidates: [
          { content: 'Use tabs, not spaces', type: 'preference', scope: 'personal', abstractionLevel: 'general', sensitive: false },
        ],
      },
      // Hallucinated target id — must NOT drop the candidate.
      { decisions: [{ index: 0, route: 'reinforces', targetId: 'M-999-nope' }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const outcome = await capture.capture({ sessionId: 's', userText: 'u', assistantText: 'a' });
    expect(outcome.created).toHaveLength(1);
  });

  it('honors conflicts when the superseded item is a pending candidate (bug #6 lineage)', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const stalePending = memory.store.create(
      { content: 'draft: deploy on Fridays', scope: 'personal', type: 'fact', status: 'candidate' },
      { actor: 'agent' },
    );
    const { call } = stubCaller([
      {
        candidates: [
          { content: 'Never deploy on Fridays', type: 'constraint', scope: 'personal', abstractionLevel: 'general', sensitive: false },
        ],
      },
      { decisions: [{ index: 0, route: 'conflicts', targetId: stalePending.id }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const outcome = await capture.capture({ sessionId: 's', userText: 'u', assistantText: 'a' });
    expect(outcome.conflicts).toBe(1);
    expect(memory.store.getConflicts(outcome.created[0]!.id).map((m) => m.id)).toContain(stalePending.id);
  });

  it('conflict (drift): a candidate that supersedes an existing memory is surfaced, linked, and logged', async () => {
    const { logger, events } = fakeLogger();
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir, logger });
    const stale = memory.store.create(
      { content: 'Run tests with `bun test`', scope: 'project', projectId: 'RenderX', type: 'constraint' },
      { actor: 'user' },
    );
    const { call } = stubCaller([
      {
        candidates: [
          {
            content: 'Run tests with `bun test --coverage` (plain `bun test` no longer passes CI)',
            detail: 'CI gate changed; coverage is now required.',
            type: 'constraint',
            scope: 'project',
            abstractionLevel: 'contextual',
            sensitive: false,
          },
        ],
      },
      { decisions: [{ index: 0, route: 'conflicts', targetId: stale.id, reason: 'supersedes' }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.capture({
      projectId: 'RenderX',
      sessionId: 's-drift',
      turn: 4,
      userText: 'CI now requires coverage',
      assistantText: 'Understood — I will run `bun test --coverage`.',
    });

    // The superseding candidate is surfaced (NOT dropped like a duplicate).
    expect(outcome.created).toHaveLength(1);
    expect(outcome.conflicts).toBe(1);
    const fresh = outcome.created[0]!;
    // A conflicts_with relation links the new item to the stale one.
    expect(memory.store.getConflicts(fresh.id).map((m) => m.id)).toContain(stale.id);
    // The stale memory is discoverable as needing attention (target of a conflict).
    expect(memory.store.listConflicted('RenderX').map((m) => m.id)).toContain(stale.id);
    // A memory.conflict event is logged for the study (drift signal).
    const conflictEvent = events.find((e) => (e as { type?: string }).type === 'memory.conflict') as
      | { staleId?: string; newId?: string; turn?: number }
      | undefined;
    expect(conflictEvent).toBeDefined();
    expect(conflictEvent!.staleId).toBe(stale.id);
    expect(conflictEvent!.newId).toBe(fresh.id);
    expect(conflictEvent!.turn).toBe(4);
  });

  it('reinforces an ACTIVE memory: no card, reinforced_count bumps (self-evolution M3)', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const existing = memory.store.create(
      { content: 'Use pnpm, never npm, in this repo', scope: 'project', projectId: 'RenderX', type: 'constraint' },
      { actor: 'user' },
    );
    const { call } = stubCaller([
      {
        candidates: [
          {
            content: 'The user wants pnpm instead of npm here',
            type: 'preference',
            scope: 'project',
            abstractionLevel: 'contextual',
            sensitive: false,
          },
        ],
      },
      { decisions: [{ index: 0, route: 'reinforces', targetId: existing.id, reason: 'restates the stored constraint' }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.capture({
      projectId: 'RenderX',
      sessionId: 's-dup',
      turn: 2,
      userText: 'remember: pnpm, not npm',
      assistantText: 'Yes — pnpm as always.',
    });

    expect(outcome.created).toHaveLength(0);
    expect(outcome.reinforced).toBe(1);
    expect(outcome.reinforcedIds).toEqual([existing.id]);
    const after = memory.store.getById(existing.id)!;
    expect(after.reinforcedCount).toBe(1);
    expect(memory.store.getEvents(existing.id).some((e) => e.kind === 'reinforce')).toBe(true);
  });

  it.each([false, true])('capture UPDATE accepts only its reviewed target through PATCH (changed=%s)', async (changed) => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const target = memory.store.create(
      { content: 'Dev server runs on port 3000', scope: 'project', projectId: 'RenderX', type: 'fact' },
      { actor: 'user' },
    );
    const { call } = stubCaller([
      { candidates: [{ content: 'Dev server now runs on port 3210', type: 'fact', scope: 'project', evidenceClass: 'user_stated' }] },
      { decisions: [{ index: 0, route: 'updates', targetId: target.id }] },
    ]);
    const outcome = await createCaptureService({ memory, callJson: call }).capture({
      projectId: 'RenderX', sessionId: 's-update', turn: 5, userText: 'We moved the dev server to 3210', assistantText: 'Noted.',
    });
    expect(outcome).toMatchObject({ surfaced: 1, revisions: 1, dropped: 0 });
    const proposal = outcome.created[0]!;
    expect(proposal).toMatchObject({
      status: 'candidate', scope: 'project', projectId: 'RenderX', provenanceSessionId: 's-update',
      provenanceTurn: 5, evidenceClass: 'user_stated',
    });
    if (changed) memory.store.update(target.id, { content: 'Use port 443 with mandatory TLS' }, { actor: 'user' });
    const state = () => [proposal.id, target.id].map((id) => ({ item: memory.store.getById(id), events: memory.store.getEvents(id) }));
    const before = state();
    const url = new URL(`http://localhost/api/memories/${proposal.id}`);
    const response = await handleMemoryRequest(new Request(url, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'active' }),
    }), url, memory);
    expect(response!.status).toBe(changed ? 409 : 200);
    if (changed) {
      expect(state()).toEqual(before);
    } else {
      expect(memory.store.getById(proposal.id)!.status).toBe('active');
      expect(memory.store.getById(target.id)!.status).toBe('archived');
    }
  });

  it('capture UPDATE preserves a distinct observation when a revision is already pending', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const target = memory.store.create(
      { content: 'Dev server runs on port 3000', scope: 'personal', type: 'fact' }, { actor: 'user' },
    );
    const { call } = stubCaller([
      { candidates: [{ content: 'Dev server now runs on port 4000', type: 'fact', scope: 'personal' }] },
      { decisions: [{ index: 0, route: 'updates', targetId: target.id }] },
      { candidates: [{ content: 'Dev server now runs on port 5000', type: 'fact', scope: 'personal' }] },
      { decisions: [{ index: 0, route: 'updates', targetId: target.id }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const first = await capture.capture({
      sessionId: 's-update', turn: 1, userText: 'We moved the dev server to 4000', assistantText: 'Noted.',
    });
    expect(first).toMatchObject({ surfaced: 1, revisions: 1, dropped: 0 });
    const draft = first.created[0]!;
    const draftEvents = memory.store.getEvents(draft.id);
    const outcome = await capture.capture({
      sessionId: 's-update', turn: 2, userText: 'We moved the dev server to 5000', assistantText: 'Noted.',
    });
    expect(outcome).toMatchObject({ surfaced: 1, revisions: 1, dropped: 0 });
    expect(outcome.created).toHaveLength(1);
    const latest = outcome.created[0]!;
    expect(latest).toMatchObject({ content: 'Dev server now runs on port 5000', status: 'candidate', provenanceTurn: 2 });
    expect(memory.store.list({ status: 'candidate' }).map(({ id }) => id).sort()).toEqual([draft.id, latest.id].sort());
    expect(memory.store.getById(draft.id)).toEqual(draft);
    expect(memory.store.getEvents(draft.id)).toEqual(draftEvents);
    expect(memory.store.revisionTargetOf(draft.id)?.id).toBe(target.id);
    expect(memory.store.getKv(`revision_targets:${draft.id}`)).not.toBeNull();
    expect(memory.store.revisionTargetOf(latest.id)?.id).toBe(target.id);
    expect(memory.store.getKv(`revision_targets:${latest.id}`)).not.toBeNull();
    expect(memory.store.getById(target.id)).toEqual(target);
  });

  for (const winnerIndex of [0, 1]) it(`competing capture updates accept only one replacement (winner ${winnerIndex})`, async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const target = memory.store.create(
      { content: 'Use port 3000', scope: 'personal', type: 'fact' }, { actor: 'user' },
    );
    const { call } = stubCaller([
      { candidates: [{ content: 'Use port 4000', type: 'fact', scope: 'personal' }] },
      { decisions: [{ index: 0, route: 'updates', targetId: target.id }] },
      { candidates: [{ content: 'Use port 5000', type: 'fact', scope: 'personal' }] },
      { decisions: [{ index: 0, route: 'updates', targetId: target.id }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const proposals = [];
    for (const turn of [1, 2]) {
      const result = await capture.capture({ sessionId: 's-update', turn, userText: `port changed ${turn}`, assistantText: 'Noted.' });
      proposals.push(result.created[0]!);
    }
    const accept = (id: string) => {
      const url = new URL(`http://localhost/api/memories/${id}`);
      return handleMemoryRequest(new Request(url, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'active' }),
      }), url, memory);
    };
    const winner = proposals[winnerIndex]!;
    const loser = proposals[1 - winnerIndex]!;
    expect((await accept(winner.id))!.status).toBe(200);
    const snapshot = () => memory.store.list().map((item) => ({ item, events: memory.store.getEvents(item.id) }));
    const before = snapshot();
    expect((await accept(loser.id))!.status).toBe(409);
    expect(snapshot()).toEqual(before);
    expect(memory.store.list({ status: 'active' }).map(({ id }) => id)).toEqual([winner.id]);
    expect(memory.store.getById(target.id)!.status).toBe('archived');
    expect(memory.store.getById(loser.id)!.status).toBe('candidate');
    expect(memory.store.getById(loser.id)!.content).toBe(loser.content);
  });

  it('updates verdict surfaces a REVISION candidate linked revises → target', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const outdated = memory.store.create(
      { content: 'Dev server runs on port 3000', scope: 'project', projectId: 'RenderX', type: 'fact' },
      { actor: 'user' },
    );
    const { call } = stubCaller([
      {
        candidates: [
          {
            content: 'Dev server runs on port 3210 (moved off 3000)',
            type: 'fact',
            scope: 'project',
            abstractionLevel: 'concrete',
            sensitive: false,
            evidenceClass: 'user_stated',
          },
        ],
      },
      { decisions: [{ index: 0, route: 'updates', targetId: outdated.id, reason: 'the port changed' }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.capture({
      projectId: 'RenderX',
      sessionId: 's-upd',
      turn: 5,
      userText: 'we moved the dev server to 3210',
      assistantText: 'Noted — 3210 it is.',
    });

    expect(outcome.created).toHaveLength(1);
    expect(outcome.revisions).toBe(1);
    const proposal = outcome.created[0]!;
    expect(proposal.status).toBe('candidate');
    expect(proposal.evidenceClass).toBe('user_stated');
    expect(memory.store.revisionTargetOf(proposal.id)?.id).toBe(outdated.id);
    expect(memory.store.hasOpenRevision(outdated.id)).toBe(true);
    // The untouched original stays active until the user accepts the revision.
    expect(memory.store.getById(outdated.id)!.status).toBe('active');
  });
});

describe('routeProposal (propose_memory channel, REDESIGN D3)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memv2-propose-'));
  });
  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes an agent proposal through the same gate and lands it as a review candidate', async () => {
    const { logger, events } = fakeLogger();
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir, logger });
    const { call, calls } = stubCaller([
      { decisions: [{ index: 0, route: 'new', targetId: null, reason: 'durable pointer' }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.routeProposal(
      {
        content: 'SSH deploy key lives at ~/.ssh/id_ed25519_server',
        detail: 'Needed whenever syncing to the prod server; the user searched a while to find it.',
        type: 'fact',
        scope: 'personal',
        evidenceClass: 'user_stated',
      },
      { sessionId: 's-tool', turn: 7, engine: 'claude' },
    );

    expect(calls).toHaveLength(1); // routing only — no extraction pass
    expect(outcome!.created).toHaveLength(1);
    expect(outcome!.created[0]!.status).toBe('candidate'); // never silently active
    expect(outcome!.created[0]!.evidenceClass).toBe('user_stated');
    const propose = events.find((e) => (e as { type?: string }).type === 'memory.propose') as { via?: string };
    expect(propose.via).toBe('propose_tool');
    const terminal = events.find((e) => (e as { type?: string }).type === 'memory.capture') as { channel?: string };
    expect(terminal.channel).toBe('agent');
  });

  it('skips a normalized exact repeat already captured in the same Claude review turn before routing', async () => {
    const { logger, events } = fakeLogger();
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir, logger });
    const { call, calls } = stubCaller([
      {
        candidates: [
          { content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' },
        ],
      },
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });

    const promptOutcome = await capture.captureFromPrompt({
      projectId: 'RenderX',
      sessionId: 's-tool',
      turn: 7,
      engine: 'claude',
      userText: 'Remember that this repo uses pnpm.',
    });
    const repeated = await capture.routeProposal(
      { content: '  USE   PNPM IN THIS REPO  ', type: 'constraint', scope: 'project' },
      { projectId: 'RenderX', sessionId: 's-tool', turn: 7, engine: 'claude' },
    );

    expect(calls).toHaveLength(2); // prompt extraction + first routing; the repeat never reaches Routing
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(1);
    expect(repeated).toMatchObject({
      created: [],
      dropped: 1,
      reinforced: 0,
      sameTurnDuplicates: [{ memoryId: promptOutcome.created[0]!.id, status: 'candidate' }],
    });
    const terminal = events
      .filter((event) => (event as { type?: string }).type === 'memory.capture')
      .at(-1) as { channel?: string; sameTurnDuplicates?: number };
    expect(terminal).toMatchObject({ channel: 'agent', sameTurnDuplicates: 1 });
  });

  it('routes the same normalized content separately when its scope differs in one Claude review turn', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call, calls } = stubCaller([
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const context = { projectId: 'RenderX', sessionId: 's-tool', turn: 7, engine: 'claude' };

    const project = await capture.routeProposal(
      { content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' },
      context,
    );
    const personal = await capture.routeProposal(
      { content: '  USE   PNPM IN THIS REPO  ', type: 'constraint', scope: 'personal' },
      context,
    );

    expect(calls).toHaveLength(2);
    expect(project!.created).toHaveLength(1);
    expect(personal!.created).toHaveLength(1);
    expect(personal!.sameTurnDuplicates).toBeUndefined();
    expect(memory.store.list({ status: 'candidate' }).map(({ scope }) => scope)).toEqual([
      'project',
      'personal',
    ]);
  });

  it('claims an exact observation before Routing so parallel Claude proposals cannot duplicate it', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const calls: DeepSeekJsonRequest[] = [];
    let releaseRouting!: () => void;
    const routingBlocked = new Promise<void>((resolve) => {
      releaseRouting = resolve;
    });
    const call: LlmJsonCaller = async (request) => {
      calls.push(request);
      await routingBlocked;
      return { decisions: [{ index: 0, route: 'new', targetId: null }] };
    };
    const capture = createCaptureService({ memory, callJson: call });
    const proposal = { content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' };
    const context = { projectId: 'RenderX', sessionId: 's-tool', turn: 8, engine: 'claude' };

    const firstPromise = capture.routeProposal(proposal, context);
    await Promise.resolve();
    const secondPromise = capture.routeProposal(proposal, context);
    await Promise.resolve();
    releaseRouting();
    const outcomes = await Promise.all([firstPromise, secondPromise]);

    expect(calls).toHaveLength(1);
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome?.created.length === 1)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome?.sameTurnDuplicates?.length === 1)).toHaveLength(1);
  });

  it('releases a failed Routing claim so the same observation can retry in the fallback path', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const calls: DeepSeekJsonRequest[] = [];
    const call: LlmJsonCaller = async (request) => {
      calls.push(request);
      if (calls.length === 1) throw new Error('fork routing failed');
      return { decisions: [{ index: 0, route: 'new', targetId: null }] };
    };
    const capture = createCaptureService({ memory, callJson: call });
    const proposal = { content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' };
    const context = { projectId: 'RenderX', sessionId: 's-tool', turn: 8, engine: 'claude' };

    await expect(capture.routeProposal(proposal, context)).rejects.toThrow('fork routing failed');
    const retried = await capture.routeProposal(proposal, context);

    expect(calls).toHaveLength(2);
    expect(retried!.created).toHaveLength(1);
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(1);
  });

  it('preserves legacy routing when the turn is missing or the engine is not Claude', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call, calls } = stubCaller([
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const proposal = { content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' };

    await capture.routeProposal(proposal, { projectId: 'RenderX', sessionId: 'missing-turn', engine: 'claude' });
    await capture.routeProposal(proposal, { projectId: 'RenderX', sessionId: 'missing-turn', engine: 'claude' });
    await capture.routeProposal(proposal, { projectId: 'RenderX', sessionId: 'codex', turn: 3, engine: 'codex' });
    await capture.routeProposal(proposal, { projectId: 'RenderX', sessionId: 'codex', turn: 3, engine: 'codex' });

    expect(calls).toHaveLength(4);
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(4);
  });

  it('does not deduplicate the same observation across turns or chats', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call, calls } = stubCaller([
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const proposal = { content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' };

    await capture.routeProposal(proposal, {
      projectId: 'RenderX', sessionId: 'chat-a', turn: 1, engine: 'claude',
    });
    await capture.routeProposal(proposal, {
      projectId: 'RenderX', sessionId: 'chat-a', turn: 2, engine: 'claude',
    });
    await capture.routeProposal(proposal, {
      projectId: 'RenderX', sessionId: 'chat-b', turn: 1, engine: 'claude',
    });

    expect(calls).toHaveLength(3);
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(3);
  });

  it('defaults evidenceClass to agent_proposed when the tool call omits it', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call } = stubCaller([{ decisions: [{ index: 0, route: 'new', targetId: null }] }]);
    const capture = createCaptureService({ memory, callJson: call });
    const outcome = await capture.routeProposal(
      { content: 'Prefers early returns over nested ifs', type: 'preference', scope: 'personal' },
      { sessionId: 's-tool' },
    );
    expect(outcome!.created[0]!.evidenceClass).toBe('agent_proposed');
  });

  it('suppresses a proposal whose content the user already dismissed (fingerprint, no LLM call)', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const rejected = memory.store.create(
      { content: 'User dislikes celery', scope: 'personal', type: 'preference', status: 'candidate' },
      { actor: 'agent' },
    );
    memory.store.discardCandidate(rejected.id);
    const { call, calls } = stubCaller([]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.routeProposal(
      { content: 'user dislikes celery', type: 'preference', scope: 'personal' },
      { sessionId: 's-tool' },
    );

    expect(calls).toHaveLength(0);
    expect(outcome).toMatchObject({ surfaced: 0, dropped: 1 });
  });

  it('returns null on a malformed payload (no content)', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call } = stubCaller([]);
    const capture = createCaptureService({ memory, callJson: call });
    expect(await capture.routeProposal({ detail: 'no content' }, { sessionId: 's' })).toBeNull();
  });

  it('a proposal that restates a stored ACTIVE memory reinforces it instead of carding', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const existing = memory.store.create(
      { content: 'Use pnpm, never npm, in this repo', scope: 'project', projectId: 'RenderX', type: 'constraint' },
      { actor: 'user' },
    );
    const { call } = stubCaller([
      { decisions: [{ index: 0, route: 'reinforces', targetId: existing.id }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const outcome = await capture.routeProposal(
      { content: 'pnpm is the package manager here', type: 'fact', scope: 'project' },
      { projectId: 'RenderX', sessionId: 's-tool' },
    );
    expect(outcome!.created).toHaveLength(0);
    expect(outcome!.reinforcedIds).toEqual([existing.id]);
    expect(memory.store.getById(existing.id)!.reinforcedCount).toBe(1);
  });

  it('routes a semantic rewrite but does not reinforce the same target twice in one Claude review turn', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const existing = memory.store.create(
      { content: 'Use pnpm, never npm, in this repo', scope: 'project', projectId: 'RenderX', type: 'constraint' },
      { actor: 'user' },
    );
    const { call, calls } = stubCaller([
      { decisions: [{ index: 0, route: 'reinforces', targetId: existing.id }] },
      { decisions: [{ index: 0, route: 'reinforces', targetId: existing.id }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const context = { projectId: 'RenderX', sessionId: 's-tool', turn: 9, engine: 'claude' };

    const first = await capture.routeProposal(
      { content: 'pnpm is the package manager here', type: 'fact', scope: 'project' },
      context,
    );
    const rewritten = await capture.routeProposal(
      { content: 'This repository standardizes package commands on pnpm', type: 'constraint', scope: 'project' },
      context,
    );

    expect(calls).toHaveLength(2); // semantic rewrites still use the Router for correctness
    expect(first!.reinforcedIds).toEqual([existing.id]);
    expect(rewritten).toMatchObject({
      reinforced: 0,
      reinforcedIds: [],
      sameTurnDuplicates: [{ memoryId: existing.id, status: 'active' }],
    });
    expect(memory.store.getById(existing.id)!.reinforcedCount).toBe(1);
  });

  it('does not report the same pending target twice in one Claude review turn', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const pending = memory.store.create(
      {
        content: 'Use pnpm in this repo',
        scope: 'project',
        projectId: 'RenderX',
        type: 'constraint',
        status: 'candidate',
      },
      { actor: 'agent' },
    );
    const { call, calls } = stubCaller([
      { decisions: [{ index: 0, route: 'reinforces', targetId: pending.id }] },
      { decisions: [{ index: 0, route: 'reinforces', targetId: pending.id }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const context = { projectId: 'RenderX', sessionId: 's-tool', turn: 10, engine: 'claude' };

    const first = await capture.routeProposal(
      { content: 'pnpm is the package manager here', type: 'fact', scope: 'project' },
      context,
    );
    const rewritten = await capture.routeProposal(
      { content: 'This repository standardizes package commands on pnpm', type: 'constraint', scope: 'project' },
      context,
    );

    expect(calls).toHaveLength(2);
    expect(first!.pending.map(({ id }) => id)).toEqual([pending.id]);
    expect(rewritten).toMatchObject({
      pending: [],
      sameTurnDuplicates: [{ memoryId: pending.id, status: 'candidate' }],
    });
  });
});

describe('candidate hygiene', () => {
  it('strips conversational [M-NN] citation markers from content and detail', () => {
    const v = validateCandidate({
      content: '测试服务器的管理密码存放在 1Password 的 Staging 条目里 [M-79]',
      detail: 'See [M-53] and [M-54] for context. The password entry is named Staging.',
    });
    expect(v!.content).toBe('测试服务器的管理密码存放在 1Password 的 Staging 条目里');
    expect(v!.detail).toBe('See and for context. The password entry is named Staging.');
  });
});

describe('captureFromPrompt (step-one prompt parse, redesign 2026-08-07)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memv2-promptparse-'));
  });
  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const createStudyPromptCapture = (callJson: LlmJsonCaller) => createCaptureService({
    memory,
    callJson,
    durablePromptCapture: true,
  });

  it('extracts an explicit remember-request as a candidate with user_stated evidence', async () => {
    const { logger, events } = fakeLogger();
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir, logger });
    const { call, calls } = stubCaller([
      {
        candidates: [
          { content: 'Staging admin password lives in the 2Password Staging entry', type: 'fact', scope: 'project' },
        ],
      },
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.captureFromPrompt({
      projectId: 'RenderX',
      sessionId: 's1',
      turn: 3,
      userText: '记住:测试服务器管理密码在 2Password 的 Staging 条目里',
    });

    expect(outcome.created).toHaveLength(1);
    expect(outcome.created[0]!.status).toBe('candidate');
    expect(outcome.created[0]!.evidenceClass).toBe('user_stated');
    // Fast pass: reasoning off + hard timeout ride the extraction call.
    expect(calls[0]!.disableThinking).toBe(true);
    expect(calls[0]!.timeoutMs).toBe(15_000);
    const captureEvents = events.filter((e) => (e as { type?: string }).type === 'memory.capture');
    expect((captureEvents[0] as { channel?: string }).channel).toBe('prompt');
  });

  it('reuses a durable prompt-capture result after restart without calling the provider or creating another Candidate', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    memory = new MemoryService({ dbPath, dataDir: dir });
    let providerCalls = 0;
    const call: LlmJsonCaller = async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          candidates: [
            { content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' },
          ],
        };
      }
      if (providerCalls === 2) {
        return { decisions: [{ index: 0, route: 'new', targetId: null }] };
      }
      throw new Error('the recovered prompt capture called the provider again');
    };
    const input = {
      projectId: 'RenderX',
      sessionId: 'opening-chat',
      turn: 1,
      engine: 'claude',
      userText: 'Remember that this repository uses pnpm.',
    };

    const first = await createStudyPromptCapture(call).captureFromPrompt(input);
    expect(first.created).toHaveLength(1);
    const firstId = first.created[0]!.id;

    // The caller has not yet persisted its memory_proposals_result. Reopening
    // the same SQLite file models a process death in that exact crash window.
    memory.close();
    memory = new MemoryService({ dbPath, dataDir: dir });
    const recovered = await createStudyPromptCapture(call).captureFromPrompt(input);

    expect(recovered).toEqual(first);
    expect(providerCalls).toBe(2);
    expect(memory.store.list({ status: 'candidate' }).map(({ id }) => id)).toEqual([firstId]);
  });

  it('keeps durable prompt-capture replay disabled unless the study server explicitly enables it', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    memory = new MemoryService({ dbPath, dataDir: dir });
    let providerCalls = 0;
    let firstCandidateId: string | undefined;
    const call: LlmJsonCaller = async () => {
      providerCalls += 1;
      if (providerCalls === 1 || providerCalls === 3) {
        return {
          candidates: [
            { content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' },
          ],
        };
      }
      if (providerCalls === 2) {
        return { decisions: [{ index: 0, route: 'new', targetId: null }] };
      }
      return { decisions: [{ index: 0, route: 'reinforces', targetId: firstCandidateId }] };
    };
    const input = {
      projectId: 'RenderX',
      sessionId: 'ordinary-chat',
      turn: 1,
      engine: 'claude',
      userText: 'Remember that this repository uses pnpm.',
    };

    const first = await createCaptureService({ memory, callJson: call }).captureFromPrompt(input);
    firstCandidateId = first.created[0]!.id;

    memory.close();
    memory = new MemoryService({ dbPath, dataDir: dir });
    await createCaptureService({ memory, callJson: call }).captureFromPrompt(input);

    expect(providerCalls).toBe(4);
  });

  it('reuses a durable prompt-capture reinforcement after restart without incrementing it twice', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    memory = new MemoryService({ dbPath, dataDir: dir });
    const existing = memory.store.create(
      {
        content: 'Use pnpm in this repo',
        scope: 'project',
        projectId: 'RenderX',
        type: 'constraint',
      },
      { actor: 'system' },
    );
    let providerCalls = 0;
    const call: LlmJsonCaller = async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          candidates: [
            { content: 'This repository uses pnpm', type: 'constraint', scope: 'project' },
          ],
        };
      }
      if (providerCalls === 2) {
        return { decisions: [{ index: 0, route: 'reinforces', targetId: existing.id }] };
      }
      throw new Error('the recovered reinforcement called the provider again');
    };
    const input = {
      projectId: 'RenderX',
      sessionId: 'opening-chat',
      turn: 1,
      engine: 'claude',
      userText: 'Remember that this repository uses pnpm.',
    };

    const first = await createStudyPromptCapture(call).captureFromPrompt(input);
    expect(first.reinforced).toBe(1);
    expect(memory.store.getById(existing.id)!.reinforcedCount).toBe(1);

    memory.close();
    memory = new MemoryService({ dbPath, dataDir: dir });
    const recovered = await createStudyPromptCapture(call).captureFromPrompt(input);

    expect(recovered).toEqual(first);
    expect(providerCalls).toBe(2);
    expect(memory.store.getById(existing.id)!.reinforcedCount).toBe(1);
  });

  it('reuses a durable prompt-capture update after restart without creating a second revision Candidate', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    memory = new MemoryService({ dbPath, dataDir: dir });
    const existing = memory.store.create(
      {
        content: 'Use npm in this repo',
        scope: 'project',
        projectId: 'RenderX',
        type: 'constraint',
      },
      { actor: 'system' },
    );
    let providerCalls = 0;
    const call: LlmJsonCaller = async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          candidates: [
            { content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' },
          ],
        };
      }
      if (providerCalls === 2) {
        return { decisions: [{ index: 0, route: 'updates', targetId: existing.id }] };
      }
      throw new Error('the recovered update called the provider again');
    };
    const input = {
      projectId: 'RenderX',
      sessionId: 'opening-chat',
      turn: 1,
      engine: 'claude',
      userText: 'Remember that this repository now uses pnpm instead of npm.',
    };

    const first = await createStudyPromptCapture(call).captureFromPrompt(input);
    expect(first.revisions).toBe(1);
    expect(first.created).toHaveLength(1);
    const revisionId = first.created[0]!.id;
    expect(memory.store.getRelations(revisionId)).toContainEqual(
      expect.objectContaining({ targetId: existing.id, type: 'revises' }),
    );

    memory.close();
    memory = new MemoryService({ dbPath, dataDir: dir });
    const recovered = await createStudyPromptCapture(call).captureFromPrompt(input);

    expect(recovered).toEqual(first);
    expect(providerCalls).toBe(2);
    expect(memory.store.list({ status: 'candidate' }).map(({ id }) => id)).toEqual([revisionId]);
    expect(memory.store.getRelations(revisionId).filter(({ type }) => type === 'revises')).toHaveLength(1);
  });

  it('reuses a durable empty prompt-capture result after restart without parsing the prompt twice', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    memory = new MemoryService({ dbPath, dataDir: dir });
    let providerCalls = 0;
    const call: LlmJsonCaller = async () => {
      providerCalls += 1;
      if (providerCalls === 1) return { candidates: [] };
      throw new Error('the recovered empty capture called the provider again');
    };
    const input = {
      projectId: 'RenderX',
      sessionId: 'opening-chat',
      turn: 1,
      engine: 'claude',
      userText: 'Build the dashboard.',
    };

    const first = await createStudyPromptCapture(call).captureFromPrompt(input);
    expect(first.created).toHaveLength(0);

    memory.close();
    memory = new MemoryService({ dbPath, dataDir: dir });
    const recovered = await createStudyPromptCapture(call).captureFromPrompt(input);

    expect(recovered).toEqual(first);
    expect(providerCalls).toBe(1);
    expect(memory.store.list()).toHaveLength(0);
  });

  it('rolls back prompt-capture mutations when its durable result cannot commit, then permits one clean retry', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    memory.db.exec(`
      CREATE TRIGGER fail_prompt_capture_receipt
      BEFORE INSERT ON memory_kv
      WHEN NEW.key LIKE 'prompt_capture_result:v1:%'
      BEGIN
        SELECT RAISE(ABORT, 'receipt unavailable');
      END;
    `);
    let providerCalls = 0;
    const call: LlmJsonCaller = async () => {
      providerCalls += 1;
      if (providerCalls === 1 || providerCalls === 3) {
        return {
          candidates: [
            { content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' },
          ],
        };
      }
      return { decisions: [{ index: 0, route: 'new', targetId: null }] };
    };
    const capture = createStudyPromptCapture(call);
    const input = {
      projectId: 'RenderX',
      sessionId: 'opening-chat',
      turn: 1,
      engine: 'claude',
      userText: 'Remember that this repository uses pnpm.',
    };

    const failed = await capture.captureFromPrompt(input);
    expect(failed.created).toHaveLength(0);
    expect(memory.store.list()).toHaveLength(0);

    memory.db.exec('DROP TRIGGER fail_prompt_capture_receipt');
    const retried = await capture.captureFromPrompt(input);

    expect(retried.created).toHaveLength(1);
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(1);
    expect(providerCalls).toBe(4);
  });

  it('empty message and zero-candidate parses short-circuit without calling the router', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call, calls } = stubCaller([{ candidates: [] }]);
    const capture = createCaptureService({ memory, callJson: call });

    const blank = await capture.captureFromPrompt({ sessionId: 's1', userText: '   ' });
    expect(blank.created).toHaveLength(0);
    expect(calls).toHaveLength(0);

    const none = await capture.captureFromPrompt({ sessionId: 's1', userText: 'fix the login bug please' });
    expect(none.created).toHaveLength(0);
    expect(calls).toHaveLength(1); // extraction ran, router did not
  });

  it('degrades to an empty outcome when the sidecar fails (send path must not block)', async () => {
    const { logger, events } = fakeLogger();
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir, logger });
    const failing: LlmJsonCaller = async () => {
      throw new LlmJsonError('DeepSeek request timed out', 'timeout');
    };
    const capture = createCaptureService({ memory, callJson: failing });

    const outcome = await capture.captureFromPrompt({ sessionId: 's1', userText: '记住 X' });
    expect(outcome.created).toHaveLength(0);
    const failed = events.find((e) => (e as { status?: string }).status === 'failed');
    expect((failed as { channel?: string }).channel).toBe('prompt');
    expect((failed as { errorCategory?: string }).errorCategory).toBe('timeout');
  });

  it('does not route or persist a prompt candidate after its preparation signal is cancelled', async () => {
    const { logger, events } = fakeLogger();
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir, logger });
    let releaseParse!: () => void;
    const parseBlocked = new Promise<void>((resolve) => { releaseParse = resolve; });
    let parseStarted!: () => void;
    const parseDidStart = new Promise<void>((resolve) => { parseStarted = resolve; });
    const calls: DeepSeekJsonRequest[] = [];
    const call: LlmJsonCaller = async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        parseStarted();
        await parseBlocked;
        return {
          candidates: [{ content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' }],
        };
      }
      return { decisions: [{ index: 0, route: 'new', targetId: null }] };
    };
    const capture = createCaptureService({ memory, callJson: call });
    const controller = new AbortController();
    const input = {
      projectId: 'RenderX',
      sessionId: 's1',
      turn: 4,
      userText: 'Remember that this repository uses pnpm.',
      signal: controller.signal,
    };

    const run = capture.captureFromPrompt(input);
    await parseDidStart;
    controller.abort();
    releaseParse();
    const outcome = await run;

    expect(outcome.created).toHaveLength(0);
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBe(controller.signal);
    expect(events.some((event) =>
      (event as { type?: string }).type === 'memory.capture'
      && (event as { status?: string }).status === 'failed',
    )).toBe(false);
  });

  it('does not reinforce an existing memory when cancellation lands during prompt Routing', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const existing = memory.store.create(
      { content: 'Use pnpm in this repo', scope: 'project', projectId: 'RenderX', type: 'constraint' },
      { actor: 'system' },
    );
    let releaseRouting!: () => void;
    const routingBlocked = new Promise<void>((resolve) => { releaseRouting = resolve; });
    let routingStarted!: () => void;
    const routingDidStart = new Promise<void>((resolve) => { routingStarted = resolve; });
    const calls: DeepSeekJsonRequest[] = [];
    const call: LlmJsonCaller = async (request) => {
      calls.push(request);
      if (calls.length === 1 || calls.length === 3) {
        return {
          candidates: [{ content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' }],
        };
      }
      if (calls.length === 2) {
        routingStarted();
        await routingBlocked;
      }
      return { decisions: [{ index: 0, route: 'reinforces', targetId: existing.id }] };
    };
    const capture = createCaptureService({ memory, callJson: call });
    const controller = new AbortController();
    const input = {
      projectId: 'RenderX',
      sessionId: 's1',
      turn: 5,
      userText: 'Remember that this repository uses pnpm.',
      signal: controller.signal,
    };

    const run = capture.captureFromPrompt(input);
    await routingDidStart;
    controller.abort();
    releaseRouting();
    const outcome = await run;

    expect(outcome.reinforced).toBe(0);
    expect(memory.store.getById(existing.id)!.reinforcedCount).toBe(0);
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.signal).toBe(controller.signal);

    const retry = await capture.captureFromPrompt({
      projectId: 'RenderX',
      sessionId: 's1',
      turn: 5,
      userText: 'Remember that this repository uses pnpm.',
    });
    expect(retry.reinforced).toBe(1);
    expect(memory.store.getById(existing.id)!.reinforcedCount).toBe(1);
    expect(calls).toHaveLength(4);
  });
});

describe('captureFromExtraction (fork channel, 2026-08-08 option A)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memv2-forkcap-'));
  });
  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes fork-extracted candidates through the same gate (validation + fingerprint + routing)', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    // Routing pass is the ONLY LLM call on this channel (extraction happened on the fork).
    const { call, calls } = stubCaller([{ decisions: [{ index: 0, route: 'new', targetId: null }] }]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.captureFromExtraction!(
      {
        candidates: [
          { content: 'Vite dev server must run behind the preview proxy', type: 'constraint', scope: 'project' },
          { content: '', type: 'fact' }, // malformed → dropped
        ],
      },
      { projectId: 'RenderX', sessionId: 's1', turn: 2, userText: 'u', assistantText: 'a' },
    );

    expect(outcome.created).toHaveLength(1);
    expect(outcome.created[0]!.status).toBe('candidate');
    expect(outcome.dropped).toBe(1);
    expect(calls).toHaveLength(1); // routing only — no extraction call
  });

  it('drops an exact prompt-channel repeat but still routes a different post-turn lesson', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const { call, calls } = stubCaller([
      {
        candidates: [
          { content: 'Use pnpm in this repo', type: 'constraint', scope: 'project' },
        ],
      },
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
      { decisions: [{ index: 0, route: 'new', targetId: null }] },
    ]);
    const capture = createCaptureService({ memory, callJson: call });
    const turn = {
      projectId: 'RenderX',
      sessionId: 's1',
      turn: 4,
      engine: 'claude',
    };

    const prompt = await capture.captureFromPrompt({
      ...turn,
      userText: 'Remember that this repository uses pnpm.',
    });
    const postTurn = await capture.captureFromExtraction!(
      {
        candidates: [
          { content: ' USE PNPM IN THIS REPO ', type: 'constraint', scope: 'project' },
          { content: 'Vite preview requires the --host flag', type: 'lesson', scope: 'project' },
        ],
      },
      { ...turn, userText: 'u', assistantText: 'a' },
    );

    expect(calls).toHaveLength(3); // extraction + first Routing + one Routing for the genuinely new lesson
    expect(prompt.created).toHaveLength(1);
    expect(postTurn.created).toHaveLength(1);
    expect(postTurn.sameTurnDuplicates).toEqual([
      { memoryId: prompt.created[0]!.id, status: 'candidate' },
    ]);
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(2);
  });

  it('dismissed fingerprints still suppress fork-extracted repeats', async () => {
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
    const dismissed = memory.store.create(
      { content: 'Use tabs not spaces', scope: 'personal', type: 'preference', status: 'candidate' },
      { actor: 'agent' },
    );
    memory.store.dismissCandidate(dismissed.id, { actor: 'user' });
    const { call, calls } = stubCaller([]);
    const capture = createCaptureService({ memory, callJson: call });

    const outcome = await capture.captureFromExtraction!(
      { candidates: [{ content: 'Use tabs not spaces', type: 'preference', scope: 'personal' }] },
      { sessionId: 's1', userText: 'u', assistantText: 'a' },
    );
    expect(outcome.created).toHaveLength(0);
    expect(outcome.dropped).toBe(1);
    expect(calls).toHaveLength(0); // fingerprint hit — the router never ran
  });
});
