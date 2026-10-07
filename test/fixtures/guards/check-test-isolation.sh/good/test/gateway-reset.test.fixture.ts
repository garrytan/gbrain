import { afterAll, beforeAll } from 'bun:test';
import { configureGateway, resetGateway } from '../../../../../../src/core/ai/gateway.ts';

// configureGateway() is paired with resetGateway(); a comment mention is ignored.
beforeAll(() => configureGateway({ embedding_model: 'litellm:example', env: {} }));
afterAll(() => resetGateway());
