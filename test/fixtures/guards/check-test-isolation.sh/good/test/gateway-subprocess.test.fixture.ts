// isolation-lint: R5-subprocess-only — the call below runs in a spawned child's script string.
const script = `
  configureGateway({ env: {} });
`;
void script;
