export type ActionType = 'commitment' | 'follow_up' | 'decision' | 'question' | 'delegation';

export type ActionStatus = 'open' | 'waiting_on' | 'in_progress' | 'stale' | 'resolved' | 'dropped';

export type ActionDraftStatus = 'pending' | 'approved' | 'rejected' | 'sent' | 'send_failed' | 'superseded';

export type ActionDraftChannel = 'whatsapp' | 'telegram';

export type ActionHistoryEventType =
  | 'created'
  | 'status_change'
  | 'reminded'
  | 'escalated'
  | 'resolved'
  | 'dropped'
  | 'draft_created'
  | 'draft_approved'
  | 'draft_edited'
  | 'draft_rejected'
  | 'draft_sent'
  | 'draft_send_failed';

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

export interface ActionDraft {
  id: number;
  action_item_id: number;
  version: number;
  status: ActionDraftStatus;
  channel: ActionDraftChannel;
  recipient: string;
  draft_text: string;
  model: string;
  context_hash: string;
  context_snapshot: Record<string, unknown>;
  generated_at: Date;
  approved_at: Date | null;
  sent_at: Date | null;
  send_error: string | null;
}
