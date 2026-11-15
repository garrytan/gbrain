/**
 * Synthetic credential corpus for the transcript lane (GST-2768 PR 1).
 *
 * Every value here is fake: obviously synthetic text (SYNTHETIC, Synth...,
 * acme-example.test hosts) padded to the shape a detector reads. Values are
 * assembled at runtime from parts so no committed line carries a key-shaped
 * literal (gitleaks, CEO-10). The texts mimic what lands in a pasted agent
 * session: env dumps, curl commands with headers, JSON config blobs, .netrc
 * lines, database URLs, bearer and basic auth, JWTs, PEM blocks, cloud keys,
 * chat tokens, cookie headers, and a label whose value arrives on the next
 * line or in the next message.
 *
 * `kind` is the rule expected to claim the entry's secrets in the transcript
 * lane; `secrets` are the exact values that must not survive redaction. A
 * `messages` array longer than one is a label in one message and its value in
 * the next.
 */
const j = (...parts: string[]): string => parts.join('');
/** A SYNTHETIC head padded with 0 to exactly n characters (alphanumeric). */
const synth = (n: number, head = 'SYNTHETICfake'): string => head.padEnd(n, '0').slice(0, n);
const HEX64 = '0123456789abcdef'.repeat(4);

export interface CredentialCorpusEntry {
  id: string;
  /** The rule that claims the secrets in the transcript lane. */
  kind: string;
  /** Where the text typically comes from in a pasted session. */
  shape: string;
  /** One message, or a label in one message and its value in the next. */
  messages: string[];
  secrets: string[];
}

const v = {
  anthropic: j('sk-', 'ant-', 'api03-', synth(28)),
  openai: j('sk-', 'proj-', synth(32)),
  voyage: j('pa', '-', synth(28)),
  githubPat: j('github', '_pat_', synth(30)),
  githubToken: j('gh', 'p_', synth(36)),
  gitlab: j('gl', 'pat-', synth(24)),
  slackBot: j('xox', 'b-', '000000000000-', synth(24)),
  slackUser: j('xox', 'p-', '000000000000-', synth(24, 'SYNTHETICuser')),
  aws: j('AK', 'IA', 'SYNTHETIC0000001'),
  google: j('AI', 'za', synth(35)),
  stripe: j('sk', '_live_', synth(28)),
  stripeHook: j('wh', 'sec_', synth(28)),
  sendgrid: j('SG', '.', synth(22), '.', synth(43, 'SYNTHETICpart')),
  twilio: j('A', 'C', HEX64.slice(0, 32)),
  supabase: j('sb', '_secret_', synth(28)),
  supabaseMgmt: j('sb', 'p_', HEX64.slice(0, 40)),
  npm: j('np', 'm_', synth(36)),
  huggingface: j('h', 'f_', synth(34)),
  digitalocean: j('do', 'p_v1_', HEX64),
  openrouter: j('sk-', 'or-', 'v1-', HEX64),
  groq: j('gs', 'k_', synth(52)),
  xai: j('xa', 'i-', synth(80)),
  perplexity: j('pp', 'lx-', synth(48)),
  replicate: j('r', '8_', synth(37)),
  gbrain: j('gbrain', '_at_', HEX64),
  jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiJzeW50aGV0aWMifQ', '.', 'SYNTHETICsignature0000'),
  bearer: j('SYNTHETIC', 'opaqueBearer0000fake'),
  dbPass: j('Synth', 'PgPass01'),
  urlPass: j('Synth', 'UrlPass9'),
  basic: Buffer.from(j('alice-example', ':', 'Synth', 'BasicPass01')).toString('base64'),
  pemBody: [
    Buffer.from('SYNTHETIC-PRIVATE-KEY-BODY-LINE-ONE-NOT-A-REAL-KEY-000000').toString('base64'),
    Buffer.from('SYNTHETIC-PRIVATE-KEY-BODY-LINE-TWO-NOT-A-REAL-KEY-000000').toString('base64'),
  ],
  entropy: j('Synth3tic', 'FakeValue0Not4Real9xQzW'),
  jsonPassword: j('Synth', '-pw-77'),
  netrcPassword: j('Synth', '3ticNetrc!'),
  pairPassword: j('Synth', '-pw-3!'),
  cliPassword: j('Synth', '-cli-pw7'),
  cookieSid: j('SYNTH', 'sid0001fake'),
  cookieDevtools: j('SYNTH', 'session0001fake'),
  cookieSet: j('SYNTH', 'setcookie0002'),
  cookieCurlB: j('SYNTH', 'curlb0003'),
  cookieJson: j('SYNTH', 'json0004value'),
  splitKey: j('Synth3tic', 'ApiKeyValue0042'),
  splitPassword: j('Synth', '-pw-split-9'),
  splitLineToken: j('Synth3tic', 'Tok3nValue0099'),
  splitPair: j('Synth', '-pair-5!'),
};

const fence = '-'.repeat(5);
const pemLabel = ['PRIVATE', 'KEY'].join(' ');

export const SYNTHETIC_CREDENTIAL_CORPUS: readonly CredentialCorpusEntry[] = [
  {
    id: 'env-dump-ai-keys', kind: 'anthropic', shape: 'env dump',
    messages: [[
      '$ env | grep KEY',
      `ANTHROPIC_API_KEY=${v.anthropic}`,
      `OPENAI_API_KEY=${v.openai}`,
      `VOYAGE_API_KEY=${v.voyage}`,
    ].join('\n')],
    secrets: [v.anthropic, v.openai, v.voyage],
  },
  { id: 'env-openai', kind: 'openai', shape: 'env dump', messages: [`export OPENAI_API_KEY="${v.openai}"`], secrets: [v.openai] },
  { id: 'env-voyage', kind: 'voyage', shape: 'env dump', messages: [`VOYAGE_API_KEY=${v.voyage}`], secrets: [v.voyage] },
  {
    id: 'env-dump-provider-keys', kind: 'openrouter', shape: 'env dump',
    messages: [[
      `OPENROUTER_API_KEY=${v.openrouter}`,
      `GROQ_API_KEY=${v.groq}`,
      `XAI_API_KEY=${v.xai}`,
      `PERPLEXITY_API_KEY=${v.perplexity}`,
      `REPLICATE_API_TOKEN=${v.replicate}`,
    ].join('\n')],
    secrets: [v.openrouter, v.groq, v.xai, v.perplexity, v.replicate],
  },
  { id: 'env-groq', kind: 'groq', shape: 'env dump', messages: [`GROQ_API_KEY=${v.groq}`], secrets: [v.groq] },
  { id: 'env-xai', kind: 'xai', shape: 'env dump', messages: [`XAI_API_KEY=${v.xai}`], secrets: [v.xai] },
  { id: 'env-perplexity', kind: 'perplexity', shape: 'env dump', messages: [`PERPLEXITY_API_KEY=${v.perplexity}`], secrets: [v.perplexity] },
  { id: 'env-replicate', kind: 'replicate', shape: 'env dump', messages: [`REPLICATE_API_TOKEN=${v.replicate}`], secrets: [v.replicate] },
  { id: 'github-pat', kind: 'github_pat', shape: 'tool output', messages: [`gh auth status shows token ${v.githubPat}`], secrets: [v.githubPat] },
  { id: 'env-github-token', kind: 'github_token', shape: 'env dump', messages: [`GITHUB_TOKEN=${v.githubToken} gh pr list`], secrets: [v.githubToken] },
  { id: 'env-gitlab', kind: 'gitlab_pat', shape: 'env dump', messages: [`GITLAB_TOKEN=${v.gitlab}`], secrets: [v.gitlab] },
  {
    id: 'chat-tokens', kind: 'slack', shape: 'JSON config blob',
    messages: [`{"slack": {"bot_token": "${v.slackBot}", "user_token": "${v.slackUser}"}}`],
    secrets: [v.slackBot, v.slackUser],
  },
  {
    id: 'cloud-aws', kind: 'aws_access_key', shape: 'aws credentials file',
    messages: [['[default]', `aws_access_key_id = ${v.aws}`, `aws_secret_access_key = ${v.entropy}`].join('\n')],
    secrets: [v.aws, v.entropy],
  },
  { id: 'cloud-google', kind: 'google_api_key', shape: 'curl command', messages: [`curl "https://maps.acme-example.test/api?key=${v.google}"`], secrets: [v.google] },
  {
    id: 'stripe-keys', kind: 'stripe', shape: 'env dump',
    messages: [[`STRIPE_SECRET_KEY=${v.stripe}`, `STRIPE_WEBHOOK_SECRET=${v.stripeHook}`].join('\n')],
    secrets: [v.stripe, v.stripeHook],
  },
  { id: 'sendgrid', kind: 'sendgrid', shape: 'JSON config blob', messages: [`{"mail": {"provider": "sendgrid", "key": "${v.sendgrid}"}}`], secrets: [v.sendgrid] },
  { id: 'twilio', kind: 'twilio', shape: 'tool output', messages: [`twilio account ${v.twilio} configured`], secrets: [v.twilio] },
  {
    id: 'supabase', kind: 'supabase_key', shape: 'env dump',
    messages: [[`SUPABASE_SECRET=${v.supabase}`, `SUPABASE_ACCESS=${v.supabaseMgmt}`].join('\n')],
    secrets: [v.supabase, v.supabaseMgmt],
  },
  { id: 'npmrc', kind: 'npm_token', shape: '.npmrc line', messages: [`//registry.npmjs.org/:_authToken=${v.npm}`], secrets: [v.npm] },
  { id: 'huggingface', kind: 'huggingface', shape: 'shell command', messages: [`huggingface-cli login --token ${v.huggingface}`], secrets: [v.huggingface] },
  { id: 'digitalocean', kind: 'digitalocean', shape: 'env dump', messages: [`DIGITALOCEAN_ACCESS_TOKEN=${v.digitalocean}`], secrets: [v.digitalocean] },
  { id: 'gbrain-token', kind: 'gbrain_token', shape: 'MCP config', messages: [`{"mcpServers": {"gbrain": {"headers": {"X-Token": "${v.gbrain}"}}}}`], secrets: [v.gbrain] },
  { id: 'jwt', kind: 'jwt', shape: 'tool output', messages: [`decoded session: ${v.jwt} (expires in 1h)`], secrets: [v.jwt] },
  {
    id: 'curl-bearer', kind: 'bearer', shape: 'curl command with headers',
    messages: [`curl -s -H "Authorization: Bearer ${v.bearer}" -H 'Accept: application/json' https://api.acme-example.test/v1/me`],
    secrets: [v.bearer],
  },
  { id: 'database-url', kind: 'db_url_credentials', shape: 'database URL', messages: [`DATABASE_URL=postgres://app_user:${v.dbPass}@db.acme-example.test:5432/app`], secrets: [v.dbPass] },
  { id: 'git-url-credentials', kind: 'url_credentials', shape: 'tool output', messages: [`git clone https://alice-example:${v.urlPass}@git.acme-example.test/source-a.git`], secrets: [v.urlPass] },
  { id: 'curl-basic', kind: 'basic_auth', shape: 'curl command with headers', messages: [`curl -H "Authorization: Basic ${v.basic}" https://api.acme-example.test/health`], secrets: [v.basic] },
  {
    id: 'pem-block', kind: 'private_key_pem', shape: 'PEM block',
    messages: [['cat ~/.ssh/deploy_key', `${fence}BEGIN ${pemLabel}${fence}`, ...v.pemBody, `${fence}END ${pemLabel}${fence}`].join('\n')],
    secrets: v.pemBody,
  },
  { id: 'entropy-assignment', kind: 'high_entropy_assignment', shape: 'env dump', messages: [`AWS_SECRET_ACCESS_KEY=${v.entropy}`], secrets: [v.entropy] },
  { id: 'json-password', kind: 'labeled_credential', shape: 'JSON config blob', messages: [`{"db": {"user": "app_user", "password": "${v.jsonPassword}"}}`], secrets: [v.jsonPassword] },
  { id: 'netrc-line', kind: 'labeled_credential', shape: '.netrc line', messages: [`machine api.acme-example.test login alice-example password ${v.netrcPassword}`], secrets: [v.netrcPassword] },
  { id: 'login-pair', kind: 'labeled_credential', shape: 'chat prose', messages: [`login alice-example / ${v.pairPassword}`], secrets: [v.pairPassword] },
  { id: 'cli-password', kind: 'labeled_credential', shape: 'shell command', messages: [`mysql -u app_user --password ${v.cliPassword} app`], secrets: [v.cliPassword] },
  // Cookie headers (transcript-lane cookie_header rule).
  {
    id: 'cookie-curl-header', kind: 'cookie_header', shape: 'curl command with headers',
    messages: [`curl -H 'Cookie: sid=${v.cookieSid}; theme=dark' https://app.acme-example.test/account`],
    secrets: [v.cookieSid],
  },
  {
    id: 'cookie-devtools', kind: 'cookie_header', shape: 'browser devtools copy',
    messages: [['GET /account HTTP/1.1', 'Host: app.acme-example.test', `cookie: _ga=GA1.2.100.200; sessionid=${v.cookieDevtools}`, 'accept: text/html'].join('\n')],
    secrets: [v.cookieDevtools],
  },
  {
    id: 'set-cookie', kind: 'cookie_header', shape: 'HTTP response headers',
    messages: [['HTTP/1.1 302 Found', `Set-Cookie: sessionid=${v.cookieSet}; Path=/; HttpOnly; Secure; SameSite=Lax`, 'Location: /home'].join('\n')],
    secrets: [v.cookieSet],
  },
  { id: 'cookie-curl-b', kind: 'cookie_header', shape: 'curl command', messages: [`curl -b 'sid=${v.cookieCurlB}' https://app.acme-example.test/`], secrets: [v.cookieCurlB] },
  { id: 'cookie-fetch-json', kind: 'cookie_header', shape: 'devtools copy as fetch', messages: [`fetch("https://app.acme-example.test/", {"headers": {"cookie": "sid=${v.cookieJson}"}});`], secrets: [v.cookieJson] },
  // A label whose value arrives on the next line or in the next message.
  { id: 'split-key-messages', kind: 'labeled_credential', shape: 'label and value in two messages', messages: ['here is my API key:', v.splitKey], secrets: [v.splitKey] },
  { id: 'split-password-messages', kind: 'labeled_credential', shape: 'label and value in two messages', messages: ['password:', v.splitPassword], secrets: [v.splitPassword] },
  { id: 'split-pair-messages', kind: 'labeled_credential', shape: 'label and value in two messages', messages: ['login: alice-example /', v.splitPair], secrets: [v.splitPair] },
  { id: 'split-token-lines', kind: 'labeled_credential', shape: 'label and value on two lines', messages: [`ok, the access token:\n${v.splitLineToken}`], secrets: [v.splitLineToken] },
];

/** Prose that mentions cookies and must come through the cookie rule unchanged. */
export const COOKIE_PROSE_NEGATIVES: readonly string[] = [
  'I cleared my cookies: nothing changed.',
  'Cookie: chocolate chip, oatmeal raisin.',
  'The Set-Cookie header sets Path=/ and HttpOnly by default.',
  'cookie banners: accept=all is the default on most sites',
  'Check the Cookie: header in devtools if login fails.',
  'Cookie: <your session cookie here>',
  'Cookie: sid=...; theme=...',
  'Cookie: sid=$SID; theme=dark',
];
