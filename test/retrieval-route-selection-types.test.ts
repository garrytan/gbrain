import type { RetrievalRouteSelection } from '../src/core/types.ts';

const invalidPrecisionPayload = { task_id: 'not-a-precision-route' };

// @ts-expect-error precision_lookup selections must carry a precision lookup payload.
const invalidPrecisionSelection: RetrievalRouteSelection = {
  route_kind: 'precision_lookup',
  retrieval_route: [],
  summary_lines: [],
  payload: invalidPrecisionPayload,
};

void invalidPrecisionSelection;
