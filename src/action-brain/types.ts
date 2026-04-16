export type ActionType = 'commitment' | 'follow_up' | 'decision' | 'question' | 'delegation';

export type ActionStatus = 'open' | 'waiting_on' | 'in_progress' | 'stale' | 'resolved' | 'dropped';

export type ActionHistoryEventType = 'created' | 'status_change' | 'reminded' | 'escalated' | 'resolved' | 'dropped';

export interface ActionItem {
  id: number;
  title: string;
  type: ActionType;
  status: ActionStatus;
  owner: string;
  waiting_on: string | null;
  due_at: Date | null;
  stale_after_hours: number;
  priority_score: number;
  confidence: number;
  source_message_id: string;
  source_thread: string;
  source_contact: string;
  linked_entity_slugs: string[];
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

export interface ActionHistory {
  id: number;
  item_id: number;
  event_type: ActionHistoryEventType;
  timestamp: Date;
  actor: string;
  metadata: Record<string, unknown>;
}
