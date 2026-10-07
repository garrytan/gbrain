import { beforeAll } from 'bun:test';
import { configureGateway } from '../../../../../../src/core/ai/gateway.ts';

// R5: the process-global gateway is configured and never reset.
beforeAll(() => configureGateway({ embedding_model: 'litellm:example', env: {} }));
