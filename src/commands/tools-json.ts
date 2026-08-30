import { operations } from '../core/operations.ts';
import { operationAvailableOnTransport } from '../mcp/dispatch.ts';

export function printToolsJson() {
  const tools = operations
    .filter((op) => operationAvailableOnTransport(op, 'local-cli'))
    .map(op => ({
      name: op.name,
      description: op.description,
      parameters: Object.fromEntries(
        Object.entries(op.params).map(([k, v]) => [
          k,
          `${v.type}${v.required ? '' : '?'}`,
        ]),
      ),
    }));

  console.log(JSON.stringify(tools, null, 2));
}
