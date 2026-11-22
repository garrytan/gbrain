/**
 * Names that are not a GitHub account's address: the first path segments github.com serves its own pages at
 * (orgs, enterprises, settings, watching, customer-stories, ...), names GitHub answers with no page at all, and
 * `ghost`, the placeholder account GitHub gives deleted users' content. A github.com URL under one of these, or a
 * bare value equal to one, names no person or company, so the duplicate finder reads it as no key.
 *
 * Candidates come from the community list github.com/Mottie/github-reserved-names (commit 1a017f43); each was
 * kept only if github.com did not serve it as a user or organisation profile on 2026-11-18. A name GitHub still
 * serves as a profile (`inbox`) is a real login and stays out. To refresh, fetch github.com/<name> for each
 * candidate and keep the ones whose page is not a profile.
 */
export const GITHUB_RESERVED_NAMES: ReadonlySet<string> = new Set([
  '300', '302', '400', '401', '402', '403', '404', '405', '406', '407', '408', '409', '410', '411', '412', '413',
  '414', '415', '416', '417', '418', '419', '420', '421', '422', '423', '424', '425', '426', '427', '428', '429',
  '430', '431', '500', '501', '502', '503', '504', '505', '506', '507', '508', '509', '510', '511', '693', '694',
  '695', '900', 'about', 'account', 'admin', 'advisories', 'anonymous', 'any', 'api', 'apps', 'attributes', 'auth',
  'billing', 'blob', 'blog', 'bounty', 'branches', 'business', 'businesses', 'c', 'cache', 'careers', 'case-studies',
  'categories', 'central', 'certification', 'changelog', 'chat', 'cla', 'cloud', 'codereview', 'codespaces',
  'collection', 'collections', 'comments', 'commit', 'commits', 'companies', 'compare', 'contact', 'contributing',
  'cookbook', 'copilot', 'coupons', 'customer', 'customer-stories', 'customers', 'dashboard', 'dashboard-feed',
  'dashboards', 'design', 'develop', 'developer', 'diff', 'discover', 'discussions', 'downloads', 'downtime',
  'editor', 'editors', 'edu', 'education', 'enterprise', 'enterprises', 'events', 'explore', 'featured', 'features',
  'feed', 'files', 'fixtures', 'forked', 'garage', 'ghost', 'gist', 'gists', 'git-guides', 'github-copilot', 'graphs',
  'groups', 'guide', 'guides', 'help', 'help-wanted', 'home', 'hooks', 'hosting', 'hovercards', 'identity', 'images',
  'individual', 'info', 'integration', 'interfaces', 'introduction', 'invalid-email-address', 'investors', 'issues',
  'jobs', 'join', 'journal', 'journals', 'lab', 'labs', 'languages', 'launch', 'layouts', 'learn', 'legal', 'library',
  'linux', 'listings', 'lists', 'login', 'logos', 'logout', 'mac', 'maintenance', 'malware', 'man', 'marketplace',
  'mcp', 'mention', 'mentioned', 'mentioning', 'mentions', 'migrating', 'milestones', 'mine', 'mirrors', 'mobile',
  'navigation', 'network', 'new', 'news', 'newsletter', 'newsroom', 'none', 'nonprofit', 'nonprofits', 'notices',
  'notifications', 'oauth', 'offer', 'open-source', 'organisations', 'organizations', 'orgs', 'pages', 'partners',
  'payments', 'personal', 'plans', 'plugins', 'popular', 'popularity', 'posts', 'press', 'preview', 'pricing',
  'professional', 'projects', 'pulls', 'raw', 'readme', 'recommendations', 'redeem', 'releases', 'render', 'reply',
  'repos', 'repositories', 'resources', 'restore', 'revert', 'save-net-neutrality', 'saved', 'scraping', 'search',
  'security', 'services', 'sessions', 'settings', 'shareholders', 'showcases', 'signin', 'signup', 'site',
  'site-policy', 'sitemap', 'social-impact', 'socials', 'spam', 'sponsors', 'ssh', 'staff', 'starred', 'stars',
  'static', 'status', 'statuses', 'storage', 'store', 'stories', 'styleguide', 'subscriptions', 'suggest',
  'suggestion', 'suggestions', 'support', 'suspended', 'talks', 'teach', 'teacher', 'teachers', 'teaching', 'team',
  'teams', 'ten', 'terms', 'timeline', 'topic', 'topics', 'tos', 'tour', 'train', 'training', 'translations', 'tree',
  'trending', 'undefined', 'updates', 'user-attachments', 'username', 'users', 'visualization', 'w', 'watching',
  'why-github', 'wiki', 'wikis', 'windows', 'works-with', 'www0', 'www1', 'www2', 'www3', 'www4', 'www5', 'www6',
  'www7', 'www8', 'www9'
]);
