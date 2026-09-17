/** Evaluation-only HTTP measurements. Never persists credentials, evidence or response bodies. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export interface RerankRequestContext {
  profile_id: string;
  sample: number;
  model: string;
  batch: number;
  document_offset: number | null;
  document_count: number;
  document_chars: number;
  estimated_input_tokens: number | null;
  quota_wait_ms: number;
}

export interface RerankRequestRecord extends RerankRequestContext {
  request_id: number;
  request_sha256: string;
  payload_bytes: number;
  started_at: string;
  start_offset_ms: number;
  duration_ms: number;
  headers_ms: number | null;
  in_flight_on_start: number;
  http_status: number | null;
  response_complete: boolean;
  resolved_model: string | null;
  input_tokens: number | null;
  cost_usd: number | null;
  result_count: number | null;
  failure: 'transport_error' | 'invalid_json' | 'http_error' | null;
}

/** Stable start-order IDs even when concurrent responses complete out of order. */
export function createRerankRequestRecorder(
  pricePerMTok: (model: string) => number | null,
  onRecord: (record: RerankRequestRecord) => void,
) {
  const records: RerankRequestRecord[] = [];
  const operationStarts = new Map<string, number>();
  let nextId = 1, inFlight = 0;
  return {
    records,
    async run(context: RerankRequestContext, body: string, send: () => Promise<Response>): Promise<Response> {
      const start = performance.now();
      const key = JSON.stringify([context.profile_id, context.sample, context.model]);
      if (!operationStarts.has(key)) operationStarts.set(key, start);
      const record: RerankRequestRecord = {
        profile_id: context.profile_id, sample: context.sample, model: context.model, batch: context.batch,
        document_offset: context.document_offset, document_count: context.document_count,
        document_chars: context.document_chars, estimated_input_tokens: context.estimated_input_tokens, quota_wait_ms: context.quota_wait_ms,
        request_id: nextId++, request_sha256: createHash('sha256').update(body).digest('hex'),
        payload_bytes: Buffer.byteLength(body), started_at: new Date().toISOString(),
        start_offset_ms: start - operationStarts.get(key)!, duration_ms: 0, headers_ms: null,
        in_flight_on_start: ++inFlight, http_status: null, response_complete: false,
        resolved_model: null, input_tokens: null, cost_usd: null, result_count: null, failure: null,
      };
      records.push(record);
      try {
        const response = await send();
        record.headers_ms = performance.now() - start;
        record.http_status = response.status;
        if (!response.ok) record.failure = 'http_error';
        try {
          const json = await response.clone().json() as any;
          record.response_complete = true;
          const tokens = json?.usage?.input_tokens ?? json?.usage?.total_tokens;
          if (Number.isSafeInteger(tokens) && tokens >= 0) {
            record.input_tokens = tokens;
            const price = pricePerMTok(context.model);
            if (price !== null) record.cost_usd = tokens * price / 1_000_000;
          }
          if (typeof json?.model === 'string' && /^[a-zA-Z0-9._:-]{1,80}$/.test(json.model)) {
            record.resolved_model = json.model;
          }
          record.result_count = Array.isArray(json?.results) ? json.results.length
            : Array.isArray(json?.data) ? json.data.length
            : json?.answers && typeof json.answers === 'object' && !Array.isArray(json.answers)
              ? Object.keys(json.answers).length : null;
        } catch { record.failure = 'invalid_json'; }
        return response;
      } catch (err) {
        record.failure = 'transport_error';
        throw err;
      } finally {
        record.duration_ms = performance.now() - start;
        inFlight--;
        // The sink receives only the explicit metadata allowlist above.
        onRecord({ ...record });
      }
    },
  };
}
