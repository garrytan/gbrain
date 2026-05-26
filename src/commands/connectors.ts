import {
  CONNECTOR_DEFINITIONS,
  getConnectorDefinition,
} from '../core/connectors/connector-registry.ts';

export async function runConnectors(args: string[]): Promise<void> {
  const command = args[0] ?? 'list';
  if (command === '--help' || command === '-h' || command === 'help') {
    printConnectorsHelp();
    return;
  }

  if (command === 'list') {
    console.log(JSON.stringify({
      connectors: CONNECTOR_DEFINITIONS.map((connector) => ({
        id: connector.id,
        class: connector.class,
        source_kind: connector.source_kind,
        display_name: connector.display_name,
        default_scopes: connector.default_scopes,
      })),
    }, null, 2));
    return;
  }

  if (command === 'show') {
    const connectorId = args[1];
    if (!connectorId) {
      throw new Error('Usage: mbrain connectors show <connector-id>');
    }
    console.log(JSON.stringify(getConnectorDefinition(connectorId), null, 2));
    return;
  }

  throw new Error(`Unknown connectors command: ${command}`);
}

function printConnectorsHelp(): void {
  console.log(`mbrain connectors -- inspect personal data connector definitions

USAGE
  mbrain connectors list
  mbrain connectors show <connector-id>
`);
}
