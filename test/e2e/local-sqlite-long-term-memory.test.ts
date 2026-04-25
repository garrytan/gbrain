import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  createSqliteCliHarness,
  type SqliteCliHarness,
} from './sqlite-cli-helpers.ts';

let harness: SqliteCliHarness | null = null;

afterEach(() => {
  harness?.teardown();
  harness = null;
});

function initLocalBrain() {
  harness = createSqliteCliHarness('long-term');
  const init = harness.runJson<{ engine: string; path: string }>(['init', '--local', '--json']);
  expect(init).toMatchObject({ engine: 'sqlite', path: harness.dbPath });
  expect(existsSync(harness.dbPath)).toBe(true);
  const config = JSON.parse(readFileSync(join(harness.configDir, 'config.json'), 'utf-8'));
  expect(config).toMatchObject({
    engine: 'sqlite',
    database_path: harness.dbPath,
    offline: true,
  });
  return harness;
}

describe('local SQLite long-term memory lifecycle', () => {
  test('profile, episode, task, candidate, handoff, validity, and forgetting state survive through CLI operation calls', () => {
    const auditSince = new Date(Date.now() - 60_000).toISOString();
    const h = initLocalBrain();

    h.call('write_profile_memory_entry', {
      id: 'profile-caffeine-old',
      requested_scope: 'personal',
      profile_type: 'preference',
      subject: 'caffeine',
      content: 'User previously preferred espresso after lunch.',
      source_ref: 'User, direct message, 2026-02-01 10:00 KST',
      last_confirmed_at: '2026-02-01T01:00:00Z',
    });
    h.call('write_profile_memory_entry', {
      id: 'profile-caffeine-new',
      requested_scope: 'personal',
      profile_type: 'preference',
      subject: 'caffeine',
      content: 'User now prefers decaf after lunch.',
      source_ref: 'User, direct message, 2026-04-20 10:00 KST',
      last_confirmed_at: '2026-04-20T01:00:00Z',
    });
    h.call('upsert_profile_memory_entry', {
      id: 'profile-caffeine-old',
      profile_type: 'preference',
      subject: 'caffeine',
      content: 'User previously preferred espresso after lunch.',
      source_ref: 'User, direct message, 2026-02-01 10:00 KST',
      last_confirmed_at: '2026-02-01T01:00:00Z',
      superseded_by: 'profile-caffeine-new',
    });

    const profileRoute = h.call<any>('get_personal_profile_lookup_route', {
      requested_scope: 'personal',
      subject: 'caffeine',
      profile_type: 'preference',
      query: 'What should the agent remember about caffeine?',
    });
    expect(profileRoute.selection_reason).toBe('direct_subject_match');
    expect(profileRoute.route.profile_memory_id).toBe('profile-caffeine-new');
    expect(profileRoute.route.content).toContain('decaf');

    const oldProfile = h.call<any>('get_profile_memory_entry', { id: 'profile-caffeine-old' });
    expect(oldProfile.superseded_by).toBe('profile-caffeine-new');

    h.call('write_profile_memory_entry', {
      id: 'profile-delete-me',
      requested_scope: 'personal',
      profile_type: 'routine',
      subject: 'temporary retention probe',
      content: 'This profile memory exists only to verify SQLite forgetting.',
      source_ref: 'User, direct message, 2026-04-20 10:05 KST',
    });
    const deleteMeProfile = h.call<any>('get_profile_memory_entry', { id: 'profile-delete-me' });
    expect(deleteMeProfile.content).toContain('verify SQLite forgetting');
    expect(h.call<{ status: string; id: string }>('delete_profile_memory_entry', {
      id: 'profile-delete-me',
    })).toMatchObject({ status: 'deleted', id: 'profile-delete-me' });
    expect(h.call<any | null>('get_profile_memory_entry', { id: 'profile-delete-me' })).toBeNull();
    const profilesAfterDelete = h.call<any[]>('list_profile_memory_entries', {
      subject: 'temporary retention probe',
    });
    expect(profilesAfterDelete.map(entry => entry.id)).not.toContain('profile-delete-me');

    h.call('record_personal_episode', {
      id: 'episode-caffeine-change',
      title: 'Caffeine preference changed',
      start_time: '2026-04-20T01:00:00Z',
      source_kind: 'chat',
      summary: 'User corrected the long-term caffeine preference to decaf.',
      source_ref: 'User, direct message, 2026-04-20 10:00 KST',
      candidate_id: 'candidate-caffeine-new',
    });
    const episodeRoute = h.call<any>('get_personal_episode_lookup_route', {
      requested_scope: 'personal',
      title: 'Caffeine preference changed',
      source_kind: 'chat',
      query: 'Why did the preference change?',
    });
    expect(episodeRoute.route.summary).toContain('corrected');
    expect(episodeRoute.route.candidate_ids).toContain('candidate-caffeine-new');

    h.call('record_personal_episode', {
      id: 'episode-delete-me',
      title: 'Temporary retention episode',
      start_time: '2026-04-20T02:00:00Z',
      source_kind: 'chat',
      summary: 'This episode exists only to verify SQLite forgetting.',
      source_ref: 'User, direct message, 2026-04-20 11:00 KST',
    });
    const deleteMeEpisode = h.call<any>('get_personal_episode_entry', { id: 'episode-delete-me' });
    expect(deleteMeEpisode.summary).toContain('verify SQLite forgetting');
    expect(h.call<{ status: string; id: string }>('delete_personal_episode_entry', {
      id: 'episode-delete-me',
    })).toMatchObject({ status: 'deleted', id: 'episode-delete-me' });
    expect(h.call<any | null>('get_personal_episode_entry', { id: 'episode-delete-me' })).toBeNull();
    const episodesAfterDelete = h.call<any[]>('list_personal_episode_entries', {
      title: 'Temporary retention episode',
    });
    expect(episodesAfterDelete.map(entry => entry.id)).not.toContain('episode-delete-me');

    const task = h.runJson<any>([
      'task-start',
      '--title',
      'Long-term SQLite memory review',
      '--goal',
      'Verify durable memory state',
      '--scope',
      'personal',
    ]);
    expect(task.id).toBeTruthy();
    h.runJson(['task-attempt', '--task-id', task.id, '--summary', 'Reviewed profile and episode memories', '--outcome', 'succeeded']);
    h.runJson(['task-decision', '--task-id', task.id, '--summary', 'Prefer SQLite local profile', '--rationale', 'Single-user local operation has no Postgres dependency']);
    h.runJson(['task-working-set', task.id, '--active-paths', 'test/e2e/local-sqlite-long-term-memory.test.ts', '--next-steps', 'keep sqlite e2e green']);
    const trace = h.runJson<any>([
      'task-trace',
      task.id,
      '--outcome',
      'long-term memory lifecycle inspected',
      '--route',
      'profile_memory,personal_episode,memory_inbox',
      '--source-refs',
      'profile:profile-caffeine-new,episode:episode-caffeine-change',
      '--verification',
      'sqlite-cli-e2e',
      '--write-outcome',
      'operational_write',
      '--selected-intent',
      'task_resume',
      '--scope-gate-policy',
      'allow',
    ]);
    expect(trace.id).toBeTruthy();
    const taskState = h.call<any>('get_task_working_set', { task_id: task.id });
    expect(taskState.thread.title).toBe('Long-term SQLite memory review');
    expect(taskState.working_set.active_paths).toContain('test/e2e/local-sqlite-long-term-memory.test.ts');
    expect(taskState.working_set.next_steps).toContain('keep sqlite e2e green');
    const attempts = h.call<any[]>('list_task_attempts', { task_id: task.id, limit: 5 });
    expect(attempts.some(attempt => attempt.summary.includes('Reviewed profile and episode memories'))).toBe(true);
    const decisions = h.call<any[]>('list_task_decisions', { task_id: task.id, limit: 5 });
    expect(decisions.some(decision => decision.summary === 'Prefer SQLite local profile')).toBe(true);
    const resume = h.call<any>('resume_task', { task_id: task.id });
    expect(resume.active_paths).toContain('test/e2e/local-sqlite-long-term-memory.test.ts');
    expect(resume.active_decisions).toContain('Prefer SQLite local profile');
    expect(resume.latest_trace_route).toEqual(['profile_memory', 'personal_episode', 'memory_inbox']);

    h.call('create_memory_candidate_entry', {
      id: 'candidate-delete-me',
      candidate_type: 'fact',
      proposed_content: 'Temporary candidate exists only to verify SQLite forgetting.',
      source_ref: 'User, direct message, 2026-04-20 11:05 KST',
      sensitivity: 'personal',
      target_object_type: 'profile_memory',
      target_object_id: 'profile-delete-me',
    });
    const deleteMeCandidate = h.call<any>('get_memory_candidate_entry', { id: 'candidate-delete-me' });
    expect(deleteMeCandidate.proposed_content).toContain('verify SQLite forgetting');
    expect(deleteMeCandidate.source_refs).toContain('User, direct message, 2026-04-20 11:05 KST');
    expect(h.call<{ status: string; id: string }>('delete_memory_candidate_entry', {
      id: 'candidate-delete-me',
    })).toMatchObject({ status: 'deleted', id: 'candidate-delete-me' });
    expect(h.call<any | null>('get_memory_candidate_entry', { id: 'candidate-delete-me' })).toBeNull();
    const candidatesAfterDelete = h.call<any[]>('list_memory_candidate_entries', {
      status: 'captured',
      limit: 50,
    });
    expect(candidatesAfterDelete.map(candidate => candidate.id)).not.toContain('candidate-delete-me');

    h.call('create_memory_candidate_entry', {
      id: 'candidate-old-procedure',
      candidate_type: 'profile_update',
      proposed_content: 'Old local profile memory update: use espresso reminder.',
      source_ref: 'User, direct message, 2026-01-01 09:00 KST',
      confidence_score: 0.9,
      importance_score: 0.8,
      recurrence_score: 0.2,
      sensitivity: 'personal',
      target_object_type: 'profile_memory',
      target_object_id: 'profile-caffeine',
      interaction_id: trace.id,
    });
    h.call('advance_memory_candidate_status', {
      id: 'candidate-old-procedure',
      next_status: 'candidate',
      interaction_id: trace.id,
    });
    h.call('advance_memory_candidate_status', {
      id: 'candidate-old-procedure',
      next_status: 'staged_for_review',
      review_reason: 'Ready for governed promotion.',
      interaction_id: trace.id,
    });
    const preflight = h.call<any>('preflight_promote_memory_candidate', { id: 'candidate-old-procedure' });
    expect(preflight.decision).toBe('allow');
    h.call('promote_memory_candidate_entry', {
      id: 'candidate-old-procedure',
      reviewed_at: '2026-01-01T00:00:00Z',
      review_reason: 'Initially accepted.',
      interaction_id: trace.id,
    });
    h.call('record_canonical_handoff', {
      candidate_id: 'candidate-old-procedure',
      reviewed_at: '2026-01-01T00:00:00Z',
      review_reason: 'Handed off to profile memory.',
      interaction_id: trace.id,
    });
    const staleValidity = h.call<any>('assess_historical_validity', {
      candidate_id: 'candidate-old-procedure',
    });
    expect(staleValidity.decision).toBe('defer');
    expect(staleValidity.stale_claim).toBe(true);
    expect(staleValidity.reasons).toContain('candidate_review_window_expired');

    const dream = h.call<any>('run_dream_cycle_maintenance', {
      now: '2026-04-25T00:00:00Z',
      limit: 10,
    });
    expect(dream.write_candidates).toBe(true);
    expect(dream.suggestions.some((entry: any) => entry.suggestion_type === 'stale_claim_challenge')).toBe(true);
    const dreamCandidates = h.call<any[]>('list_memory_candidate_entries', {
      status: 'candidate',
      candidate_type: 'open_question',
      limit: 20,
    });
    expect(dreamCandidates.some(candidate => candidate.generated_by === 'dream_cycle')).toBe(true);

    h.call('create_memory_candidate_entry', {
      id: 'candidate-new-procedure',
      candidate_type: 'profile_update',
      proposed_content: 'Current local profile memory update: use decaf reminder.',
      source_ref: 'User, direct message, 2026-04-20 10:00 KST',
      confidence_score: 0.95,
      importance_score: 0.9,
      recurrence_score: 0.3,
      sensitivity: 'personal',
      target_object_type: 'profile_memory',
      target_object_id: 'profile-caffeine',
      status: 'staged_for_review',
      interaction_id: trace.id,
    });
    h.call('promote_memory_candidate_entry', {
      id: 'candidate-new-procedure',
      reviewed_at: '2026-04-20T00:00:00Z',
      review_reason: 'Newer correction accepted.',
      interaction_id: trace.id,
    });
    h.call('record_canonical_handoff', {
      candidate_id: 'candidate-new-procedure',
      reviewed_at: '2026-04-20T00:00:00Z',
      review_reason: 'Handed off to corrected profile memory.',
      interaction_id: trace.id,
    });
    const supersession = h.call<any>('supersede_memory_candidate_entry', {
      superseded_candidate_id: 'candidate-old-procedure',
      replacement_candidate_id: 'candidate-new-procedure',
      review_reason: 'Newer correction replaces stale procedure.',
      interaction_id: trace.id,
    });
    expect(supersession.supersession_entry.superseded_candidate_id).toBe('candidate-old-procedure');

    const oldCandidate = h.call<any>('get_memory_candidate_entry', { id: 'candidate-old-procedure' });
    expect(oldCandidate.status).toBe('superseded');
    const superseded = h.call<any[]>('list_memory_candidate_entries', { status: 'superseded' });
    expect(superseded.map(candidate => candidate.id)).toContain('candidate-old-procedure');
    const promoted = h.call<any[]>('list_memory_candidate_entries', { status: 'promoted' });
    expect(promoted.map(candidate => candidate.id)).toContain('candidate-new-procedure');
    expect(promoted.map(candidate => candidate.id)).not.toContain('candidate-old-procedure');
    const invalidAfterSupersede = h.call<any>('assess_historical_validity', {
      candidate_id: 'candidate-old-procedure',
    });
    expect(invalidAfterSupersede.decision).toBe('deny');
    expect(invalidAfterSupersede.reasons).toContain('candidate_superseded');

    h.call('create_memory_candidate_entry', {
      id: 'candidate-rejected-rumor',
      candidate_type: 'fact',
      proposed_content: 'Unverified rumor that should not become canonical.',
      source_ref: 'Ambiguous note, 2026-04-21',
      sensitivity: 'personal',
      target_object_type: 'profile_memory',
      target_object_id: 'profile-caffeine',
    });
    h.call('advance_memory_candidate_status', { id: 'candidate-rejected-rumor', next_status: 'candidate' });
    h.call('advance_memory_candidate_status', { id: 'candidate-rejected-rumor', next_status: 'staged_for_review' });
    h.call('reject_memory_candidate_entry', {
      id: 'candidate-rejected-rumor',
      review_reason: 'Insufficient provenance for long-term memory.',
      interaction_id: trace.id,
    });
    const rejected = h.call<any>('get_memory_candidate_entry', { id: 'candidate-rejected-rumor' });
    expect(rejected.status).toBe('rejected');
    expect(rejected.review_reason).toContain('Insufficient provenance');
    expect(rejected.source_refs).toContain('Ambiguous note, 2026-04-21');
    const rejectedCandidates = h.call<any[]>('list_memory_candidate_entries', {
      status: 'rejected',
      limit: 20,
    });
    expect(rejectedCandidates.map(candidate => candidate.id)).toContain('candidate-rejected-rumor');

    const events = h.call<any[]>('list_memory_candidate_status_events', {
      interaction_id: trace.id,
      limit: 50,
    });
    expect(events.some(event => event.candidate_id === 'candidate-old-procedure' && event.event_kind === 'superseded')).toBe(true);
    expect(events.some(event => event.candidate_id === 'candidate-rejected-rumor' && event.event_kind === 'rejected')).toBe(true);

    const audit = h.call<any>('audit_brain_loop', {
      since: auditSince,
      until: new Date(Date.now() + 60_000).toISOString(),
      task_id: task.id,
      json: true,
    });
    expect(audit.candidate_status_events.created_count).toBe(2);
    expect(audit.candidate_status_events.advanced_count).toBe(2);
    expect(audit.candidate_status_events.promoted_count).toBe(2);
    expect(audit.candidate_status_events.rejected_count).toBe(1);
    expect(audit.candidate_status_events.superseded_count).toBe(1);
    expect(audit.candidate_status_events.linked_event_count).toBe(8);
    expect(audit.candidate_status_events.unlinked_event_count).toBe(0);
    expect(audit.candidate_status_events.traces_with_candidate_events).toBe(1);
    expect(audit.linked_writes.handoff_count).toBe(2);
    expect(audit.linked_writes.supersession_count).toBe(1);
    expect(audit.linked_writes.contradiction_count).toBe(0);
    expect(audit.linked_writes.traces_with_any_linked_write).toBe(1);
    expect(audit.linked_writes.traces_without_linked_write).toBe(0);
  }, 60_000);
});
