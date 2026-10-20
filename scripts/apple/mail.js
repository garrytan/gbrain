// gbrain Apple connector: read-only Mail helper (JXA against Mail.app's public scripting dictionary).
//
// Usage (run by src/core/apple/readers/mail.ts, never from user input):
//   osascript -l JavaScript mail.js --probe
//   osascript -l JavaScript mail.js --accounts
//   osascript -l JavaScript mail.js --since <ISO8601> --mailboxes INBOX,Sent --routing '[{"id":"<account id>","server_name":"<host>","account_type":"imap"},...]'
//                                   [--max 500] [--budget-ms 45000] [--timeout-ms 120000]
//                                   [--after-date <ISO8601> --after-id <id>] [--exclude '["<id>",...]']
//   osascript -l JavaScript mail.js --targets '[{"id":"<id>","date":"<ISO8601>"},...]' --mailboxes INBOX,Sent --routing '[...]' [--budget-ms ..] [--timeout-ms ..]
//
// Account routing (Google-hosted accounts are read by the Google connector, never here). `--accounts` prints ONLY public
// account metadata: {"items":[],"accounts":[{"id","server_name","account_type","enabled"}...]} (id, `server name`,
// `account type`, `enabled`; a property that cannot be read is null). It never reads an account's password, user name,
// email addresses, full name or display name, and never guesses a provider from an address. gbrain decides which accounts
// are eligible and passes exactly those, with the metadata it decided on, as `--routing`. Every read REQUIRES `--routing`:
// the helper re-reads each listed account's metadata and refuses (mail_routing_changed) when an account is gone, disabled
// or has another server/type, then reads ONLY the mailboxes OF THOSE ACCOUNTS. It never touches Mail's unified INBOX /
// Sent mailboxes, which would mix every account in. INBOX and Sent are role labels: each routed account must have exactly
// one top-level mailbox that fits (INBOX: "INBOX"; Sent: Sent, Sent Messages, Sent Items or Sent Mail, case-insensitive),
// else selection_not_found / selection_ambiguous (no guessing from a localized name). Any other name is matched exactly
// in each routed account and must exist in at least one.
//
// Protocol: prints exactly ONE JSON document on stdout.
//   success: {"items":[AppleMailMessage...], "truncated":bool, "budget_exhausted":bool, "unavailable":[threadId...],
//             "unavailable_messages":[{"id","date","thread_id"}...], "deferred":[threadId...], "target_missing":[id...], "incomplete":bool}  exit 0
//     truncated   more messages matched than were returned (the --max cap, or the --budget-ms body budget ran
//                 out, budget_exhausted:true): the OLDEST ones are returned (resume from the newest returned).
//     unavailable threads with a message that could not be read: the caller must not treat them as deleted.
//     incomplete  a message could not even be attributed to a thread: the caller must not delete anything.
//     unavailable_messages  the subset of unreadable messages PROVEN unreadable one by one (a single-message read that
//                 failed, a definite null/non-string body, or a per-message error): stable id, received date, thread.
//                 Only these may be counted toward a hold; a batch neighbour that merely was not retried in time is not.
//     deferred    threads with an unresolved message that is NOT proven (batch failed and the retry did not fit, or the
//                 message vanished mid-read): the caller pins its cursor and counts nothing.
//     --exclude   stable message ids to skip entirely (held messages): never listed, read or reported.
//     --targets   re-read exactly these messages (stable id + received date) wherever they are, instead of a window
//                 listing; target_missing names the requested ids the mailbox no longer has.
//   failure: {"error":{"code":"...","message":"..."}}  exit non-zero
//
// Mail.app is NEVER launched: `Application('Mail').running()` is checked first (probe and sync), and a
// closed Mail is reported as mail_not_running_or_unconfigured. Properties are fetched in bulk
// (one Apple event per property over the filtered message set), not per message. Bodies are the
// exception: Mail.app can take ~20 s to produce `content` for one HTML newsletter (observed on a
// live Mac, cached or not), so bodies are fetched in small bulk batches under a wall-clock budget
// (--budget-ms, default 45 s, counted from process start). When the budget runs out the messages read so far (the oldest, in
// (date,id) order) are returned with truncated:true and budget_exhausted:true; the caller resumes
// from the last one on its next run, so a slow mailbox drains over several runs instead of timing out.
//
// Time accounting. --budget-ms is a SOFT limit: no further body batch starts after it. --timeout-ms is the
// caller's HARD helper timeout (the process is killed at it); a batch only starts when its projected end
// (now + messages x max(BODY_COST_FLOOR_MS, slowest per-message cost seen so far)) fits inside
// timeout - reserve, so a slow pre-phase (accounts(), listing, metadata) shrinks or skips the body phase
// instead of overrunning the kill. When nothing fits, the helper returns what it has, truncated + budget_exhausted.
// KNOWN LIMIT, not a guarantee: JXA runs each Apple event synchronously and cannot be interrupted, so the
// clock is only consulted BETWEEN events. One event (accounts(), a `whose` listing, one `content` read) that
// itself outlasts the remaining time cannot be stopped from inside the script; the caller's hard kill
// (helper_timeout) remains the only backstop for that, and the pre-phase is not budgeted at all.
//
// Failure handling. A batch whose bulk body read throws is retried one message at a time, only while the
// budget allows, so one unreadable message no longer hides its healthy neighbours. Anything left unresolved
// (still throwing, not retried for lack of time, vanished between the metadata and body reads, body missing
// or not a string, ids/bodies arrays that do not line up) is reported as `unavailable` (its thread) or, when
// its thread is unknown, `incomplete`; the caller then keeps its cursor and removes nothing. A short, null
// or non-string body is NEVER turned into an empty body.
// Read-only: only property reads and `whose` filters are used. Nothing is sent, moved,
// flagged, marked read, or deleted. Attachments are never touched (no `mailAttachments`
// access, no save). Bodies come from `content` (plain text) and are capped at BODY_CAP chars.
// Mail.app has no thread id in its public dictionary, so threadId is derived from the
// first RFC `References` id, else `In-Reply-To`, else the message's own Message-ID, else
// the normalized subject.
ObjC.import('Foundation');
ObjC.import('stdlib');

var BODY_CAP = 20000;
var DEFAULT_MAX = 500;
var DEFAULT_BUDGET_MS = 45000;
// Messages per body batch: one slow HTML body is ~20 s, so even a batch of all-slow messages started at
// the budget's edge (45 s + 3 × 20 s) finishes inside the caller's 120 s helper timeout.
var BODY_BATCH = 3;
var DEFAULT_TIMEOUT_MS = 120000;
// Assumed worst per-message `content` cost until a slower one is observed (live Mac: ~20 s per HTML newsletter).
var BODY_COST_FLOOR_MS = 20000;
// Left for output and exit; scaled down for very small --timeout-ms.
var SAFETY_RESERVE_MS = 10000;

function emit(doc, code) {
  var s = JSON.stringify(doc) + '\n';
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding));
  $.exit(code);
}

function fail(code, message, exitCode) {
  emit({ error: { code: code, message: String(message) } }, exitCode === undefined ? 1 : exitCode);
}

function classify(e) {
  var m = String((e && (e.message || e)) || e);
  if (/-1743|not authori[sz]ed/i.test(m)) {
    return ['automation_denied', 'Automation access to Mail is not granted (' + m + ').'];
  }
  if (/-600|isn.t running|application can.t be found|-10814/i.test(m)) {
    return ['mail_not_running_or_unconfigured', 'Mail.app is not available or not running (' + m + ').'];
  }
  return ['helper_failed', m];
}

function parseArgs(argv) {
  var out = { probe: false, accounts: false, routing: null, since: null, mailboxes: [], max: DEFAULT_MAX, afterDate: null, afterId: null, budgetMs: DEFAULT_BUDGET_MS, timeoutMs: DEFAULT_TIMEOUT_MS, exclude: null, targets: null };
  for (var i = 0; i < argv.length; i++) {
    var a = String(argv[i]);
    if (a === '--') continue;
    if (a === '--probe') { out.probe = true; continue; }
    if (a === '--accounts') { out.accounts = true; continue; }
    if (a === '--since' || a === '--routing' || a === '--mailboxes' || a === '--max' || a === '--after-date' || a === '--after-id' || a === '--budget-ms' || a === '--timeout-ms' || a === '--exclude' || a === '--targets') {
      if (i + 1 >= argv.length) fail('helper_failed', 'missing value for ' + a, 2);
      var v = String(argv[++i]);
      if (a === '--since') out.since = v;
      else if (a === '--after-date') out.afterDate = v;
      else if (a === '--after-id') out.afterId = v;
      else if (a === '--routing') {
        try { out.routing = JSON.parse(v); } catch (e) { fail('helper_failed', '--routing must be JSON', 2); }
        if (!out.routing || !Array.isArray(out.routing.eligible) || !Array.isArray(out.routing.account_ids) || !Array.isArray(out.routing.observed)) fail('helper_failed', '--routing must contain eligible, observed and account_ids arrays', 2);
      }
      else if (a === '--exclude') out.exclude = parseJsonArray(a, v, function (x) { return typeof x === 'string' && x.length > 0; });
      else if (a === '--targets') {
        out.targets = parseJsonArray(a, v, function (x) { return x && typeof x.id === 'string' && x.id.length > 0 && typeof x.date === 'string' && !isNaN(new Date(x.date).getTime()); });
      }
      else if (a === '--max') {
        var n = parseInt(v, 10);
        if (!(n >= 1)) fail('helper_failed', '--max must be a positive integer', 2);
        out.max = n;
      }
      else if (a === '--budget-ms') {
        var b = parseInt(v, 10);
        if (!(b >= 1)) fail('helper_failed', '--budget-ms must be a positive integer', 2);
        out.budgetMs = b;
      }
      else if (a === '--timeout-ms') {
        var t = parseInt(v, 10);
        if (!(t >= 1)) fail('helper_failed', '--timeout-ms must be a positive integer', 2);
        out.timeoutMs = t;
      }
      else out.mailboxes = v.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
      continue;
    }
    fail('helper_failed', 'unknown argument: ' + a, 2);
  }
  return out;
}

function parseJsonArray(flag, text, valid) {
  var parsed;
  try { parsed = JSON.parse(text); } catch (e) { fail('helper_failed', flag + ' must be a JSON array', 2); }
  if (!Array.isArray(parsed)) fail('helper_failed', flag + ' must be a JSON array', 2);
  for (var i = 0; i < parsed.length; i++) if (!valid(parsed[i])) fail('helper_failed', flag + ' has an invalid entry', 2);
  return parsed;
}

function normSubject(s) {
  return String(s || '').replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function headerValue(headers, name) {
  // Unfold continuation lines, then find the first matching header.
  var unfolded = String(headers || '').replace(/\r?\n[ \t]+/g, ' ');
  var re = new RegExp('^' + name + ':[ \\t]*(.*)$', 'im');
  var m = re.exec(unfolded);
  return m ? m[1].trim() : '';
}

function firstMsgId(s) {
  var m = /<[^>\s]+>/.exec(s || '');
  return m ? m[0] : '';
}

// Addresses of a To/Cc header (already unfolded), without per-recipient Apple events.
function addrsOfHeader(headers, name) {
  var v = headerValue(headers, name);
  var found = v.match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+/g);
  return found ? found : [];
}

// Header-only automation verdicts for open-loop tracking (no body is read for them).
//   automated: RFC 3834 Auto-Submitted other than "no", or a text/calendar message.
//   bulk:      List-Unsubscribe, List-Id, Precedence bulk/list/junk, or a no-reply Reply-To.
function automationFlags(headers) {
  var auto = headerValue(headers, 'Auto-Submitted').toLowerCase();
  var ctype = headerValue(headers, 'Content-Type').toLowerCase();
  var precedence = headerValue(headers, 'Precedence').toLowerCase();
  var replyTo = headerValue(headers, 'Reply-To').toLowerCase();
  return {
    automated: (auto !== '' && auto !== 'no') || ctype.indexOf('text/calendar') >= 0,
    bulk: headerValue(headers, 'List-Unsubscribe') !== '' || headerValue(headers, 'List-Id') !== '' ||
      precedence === 'bulk' || precedence === 'list' || precedence === 'junk' ||
      /no-?reply|do-?not-?reply/.test(replyTo)
  };
}

// Public metadata of one account: id, `server name`, `account type`, `enabled` and nothing else. Each read is isolated, so
// one that fails is null (the caller then cannot classify the account and fails closed). The account's password, user
// name, email addresses, full name and display name are NEVER read.
function accountMeta(acct) {
  function text(f) { try { var v = f(); return typeof v === 'string' ? v : null; } catch (e) { return null; } }
  var type = null;
  try { var t = acct.accountType(); type = (t === undefined || t === null) ? null : String(t); } catch (e) { type = null; }
  var enabled = null;
  try { var en = acct.enabled(); enabled = typeof en === 'boolean' ? en : null; } catch (e) { enabled = null; }
  return {
    id: text(function () { return acct.id(); }),
    server_name: text(function () { return acct.serverName(); }),
    account_type: type,
    enabled: enabled
  };
}

// The accounts gbrain decided on (--routing), each re-verified against Mail NOW: still present exactly once, still
// enabled, same server name and type. Anything else means the routing decision is stale: nothing is read.
function verifyRouting(accts, routing) {
  var allowed = routing.eligible;
  var accountsById = Object.create(null);
  var dup = Object.create(null);
  for (var i = 0; i < accts.length; i++) {
    var m = accountMeta(accts[i]);
    if (m.id === null) continue;
    if (accountsById[m.id]) dup[m.id] = true;
    accountsById[m.id] = { acct: accts[i], meta: m };
  }
  var seenAll = Object.keys(accountsById).sort();
  var expectedAll = routing.account_ids.slice().sort();
  if (JSON.stringify(seenAll) !== JSON.stringify(expectedAll) || Object.keys(dup).length > 0) fail('mail_routing_changed', 'The Mail accounts changed after gbrain decided which ones to read (an account was added, removed, or duplicated); nothing was read.');
  // Also compare the public metadata of EVERY account, not just eligible ones: e.g. a Google account re-pointed to an
  // Apple host under the same id must invalidate this decision before it can be silently skipped or read.
  var expectedMeta = Object.create(null);
  routing.observed.forEach(function (m) { expectedMeta[m.id] = m; });
  for (var oi = 0; oi < seenAll.length; oi++) {
    var id = seenAll[oi];
    var current = accountsById[id].meta;
    var expected = expectedMeta[id];
    if (!expected || current.server_name !== expected.server_name || current.account_type !== expected.account_type || current.enabled !== expected.enabled) {
      fail('mail_routing_changed', 'The Mail accounts changed after gbrain decided which ones to read (an account provider or enabled state changed); nothing was read.');
    }
  }
  var scoped = [];
  var seen = Object.create(null);
  for (var k = 0; k < allowed.length; k++) {
    var want = allowed[k];
    var have = accountsById[want.id];
    if (seen[want.id] || dup[want.id] || !have || have.meta.enabled !== true || have.meta.server_name !== want.server_name || have.meta.account_type !== want.account_type) {
      fail('mail_routing_changed', 'The Mail accounts changed after gbrain decided which ones to read (an account was added, removed, disabled, or its server changed); nothing was read.');
    }
    seen[want.id] = true;
    scoped.push({ id: want.id, acct: have.acct });
  }
  return scoped;
}

// INBOX and Sent are ROLES: every routed account must have exactly one top-level mailbox that fits, else this fails
// explicitly (a localized or unusual folder name is never guessed). Any other name is matched exactly, per account.
var ROLE_NAMES = { inbox: ['inbox'], sent: ['sent', 'sent messages', 'sent items', 'sent mail'] };

function resolveMailboxes(scoped, names) {
  var found = [];
  var seen = {};
  var missing = [];
  var lists = scoped.map(function (s) {
    var named = [];
    function collect(boxes, prefix) {
      for (var j = 0; j < boxes.length; j++) {
        var bn = '';
        try { bn = String(boxes[j].name()); } catch (e) { continue; }
        var id = '';
        try { id = String(boxes[j].id()); } catch (e) { id = prefix + j; }
        named.push({ idx: prefix + id, name: bn.toLowerCase(), mb: boxes[j] });
        // Mailbox names are local to each account; nested mailboxes are permitted, but every match remains in that account.
        try { collect(boxes[j].mailboxes(), prefix + id + '/'); } catch (e) { /* no child mailboxes */ }
      }
    }
    collect(s.acct.mailboxes(), '');
    return { id: s.id, boxes: named };
  });
  function add(label, accountId, idx, mb) {
    var key = JSON.stringify([accountId, idx]);
    if (seen[key]) return;
    seen[key] = true;
    found.push({ label: label, key: key, accountId: accountId, mb: mb });
  }
  names.forEach(function (name) {
    var lower = name.toLowerCase();
    if (lower === 'inbox' || lower === 'sent') {
      var label = lower === 'inbox' ? 'INBOX' : 'Sent';
      var accepted = ROLE_NAMES[lower];
      lists.forEach(function (l) {
        var hits = l.boxes.filter(function (b) { return accepted.indexOf(b.name) >= 0; });
        if (hits.length === 0) fail('selection_not_found', 'Mail account ' + l.id + ' has no mailbox for the ' + label + ' role (looked for: ' + accepted.join(', ') + '); name the exact mailbox in the mailbox list.');
        if (hits.length > 1) fail('selection_ambiguous', 'Mail account ' + l.id + ' has ' + hits.length + ' mailboxes that fit the ' + label + ' role (' + accepted.join(', ') + '); name the exact mailbox in the mailbox list.');
        add(label, l.id, hits[0].idx, hits[0].mb);
      });
      return;
    }
    var before = found.length;
    lists.forEach(function (l) {
      l.boxes.forEach(function (b) { if (b.name === lower) add(name, l.id, b.idx, b.mb); });
    });
    if (found.length === before) missing.push(name);
  });
  // A configured mailbox that matches nothing would shrink the listing silently, and a --full
  // sweep reads a short listing as deletions: refuse instead.
  if (missing.length > 0) {
    fail('selection_not_found', 'No mailbox in the routed Mail accounts matches: ' + missing.join(', ') + '.');
  }
  return found;
}

function whoseSince(mb, since, until) {
  var after = { dateReceived: { _greaterThan: since } };
  if (!until) return mb.messages.whose(after);
  return mb.messages.whose({ _and: [after, { dateReceived: { _lessThanEquals: until } }] });
}

function stableMessageId(entry, appId, rfcId, headers) {
  var rfc = firstMsgId(String(rfcId || '')) || firstMsgId(headerValue(String(headers || ''), 'Message-ID'));
  return rfc || ('mail-id:' + entry.accountId + ':' + entry.label + ':' + appId);
}

// The per-run identity of one message inside one routed mailbox (two accounts can both have an INBOX and equal app ids).
function msgKey(entry, appId) {
  return JSON.stringify([entry.key, appId]);
}

// Metadata-only pass across the mailbox; bodies are fetched only for the bounded page below.
function listCandidates(entries, since, until) {
  var all = [];
  entries.forEach(function (entry) {
    var spec = whoseSince(entry.mb, since, until || null);
    var ids = spec.id();
    var rfcIds = spec.messageId();
    var heads = spec.allHeaders();
    var dates = spec.dateReceived();
    for (var i = 0; i < ids.length; i++) {
      var date = new Date(dates[i]).toISOString();
      all.push({ entry: entry, appId: ids[i], id: stableMessageId(entry, ids[i], rfcIds[i], heads[i]), date: date });
    }
  });
  return all;
}

function idClauses(appIds) {
  return { _or: appIds.map(function (id) { return { id: { _equals: id } }; }) };
}

// Metadata (everything but the body) for the selected messages of one mailbox, in bulk: one Apple
// event per property. Cheap even for hundreds of messages. Keyed by the Apple message id.
// The property arrays are positional, so they are trusted only when every one lines up with `ids` and the
// id list is unchanged after the reads; otherwise nothing from this mailbox is used (the selected messages
// then have no metadata and are reported incomplete by flagUnresolved, never guessed).
function readMeta(entry, appIds, metaByKey, state) {
  if (appIds.length === 0) return;
  var spec = entry.mb.messages.whose(idClauses(appIds));
  var ids = spec.id();
  var rfcIds = spec.messageId();
  var subjects = spec.subject();
  var senders = spec.sender();
  var dates = spec.dateReceived();
  var reads = spec.readStatus();
  var heads = spec.allHeaders();
  var idsAfter = spec.id();
  if (!sameIds(ids, idsAfter)) return;
  var cols = [rfcIds, subjects, senders, dates, reads, heads];
  for (var c = 0; c < cols.length; c++) {
    if (!Array.isArray(cols[c]) || cols[c].length !== ids.length) return;
  }
  for (var i = 0; i < ids.length; i++) {
    var threadId = '';
    var key = msgKey(entry, ids[i]);
    try {
      var headers = String(heads[i] || '');
      var id = stableMessageId(entry, ids[i], rfcIds[i], headers);
      var ref = firstMsgId(headerValue(headers, 'References'));
      var irt = firstMsgId(headerValue(headers, 'In-Reply-To'));
      var subject = String(subjects[i] || '');
      threadId = ref || irt || firstMsgId(String(rfcIds[i] || '')) || ('subject:' + normSubject(subject));
      metaByKey[key] = {
        id: id,
        threadId: threadId,
        mailbox: entry.label,
        subject: subject,
        from: String(senders[i] || ''),
        to: addrsOfHeader(headers, 'To'),
        cc: addrsOfHeader(headers, 'Cc'),
        date: new Date(dates[i]).toISOString(),
        read: !!reads[i],
        automated: automationFlags(headers).automated,
        bulk: automationFlags(headers).bulk
      };
    } catch (e) {
      state.metaHandled[key] = true;
      if (threadId) {
        state.unavailable[threadId] = true;
        // This one message threw while its metadata was assembled: proven, and its identity is the candidate's.
        var cand = state.cand[key];
        if (cand) markProven(state, cand.id, threadId, cand.date);
        else state.deferred[threadId] = true;
      } else state.incomplete = true;
    }
  }
}

// A message proven unreadable on its own: the only kind of failure the caller may count toward a hold.
function markProven(state, id, threadId, date) {
  if (!id || !threadId || !date) { state.incomplete = true; return; }
  if (!state.bad[id]) state.bad[id] = { id: id, date: date, thread_id: threadId };
}

function sameIds(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (String(a[i]) !== String(b[i])) return false;
  return true;
}

// Bodies for one batch of one mailbox's messages (one `content` Apple event for the batch).
// Returns false when the batch could not be read AS A BATCH (the call threw, or the ids/bodies arrays are not
// trustworthy): nothing from it is used and the caller may retry the messages singly. Returns true when the
// reply was consistent; messages it did not return (vanished) or returned without a string body are left
// unresolved, or marked unavailable, individually. Resolved messages are recorded in state.resolved.
function readBodies(entry, appIds, metaByKey, items, seenIds, state) {
  if (appIds.length === 0) return true;
  var spec = entry.mb.messages.whose(idClauses(appIds));
  var ids, bodies, idsAfter;
  try {
    ids = spec.id();
    bodies = spec.content();
    idsAfter = spec.id();
  } catch (eb) {
    return false;
  }
  // ids, bodies and the re-read ids must line up one to one, and every id must be one we asked for: the
  // body of message i is trusted only if it demonstrably belongs to ids[i].
  if (!sameIds(ids, idsAfter) || !Array.isArray(bodies) || bodies.length !== ids.length) return false;
  var asked = {};
  appIds.forEach(function (x) { asked[String(x)] = true; });
  var got = {};
  for (var q = 0; q < ids.length; q++) {
    if (!asked[String(ids[q])] || got[String(ids[q])]) return false;
    got[String(ids[q])] = true;
  }
  for (var i = 0; i < ids.length; i++) {
    var key = msgKey(entry, ids[i]);
    var meta = metaByKey[key];
    if (!meta) continue; // no usable metadata: flagUnresolved reports it
    try {
      if (typeof bodies[i] !== 'string') {
        // Missing / null body: unreadable, not empty. Keep the thread unavailable and re-read it next run.
        state.unavailable[meta.threadId] = true;
        markProven(state, meta.id, meta.threadId, meta.date);
        state.resolved[key] = true;
        continue;
      }
      if (seenIds[key]) { state.resolved[key] = true; continue; }
      var body = bodies[i];
      if (body.length > BODY_CAP) body = body.slice(0, BODY_CAP);
      var item = {};
      for (var k in meta) item[k] = meta[k];
      item.body = body;
      items.push(item);
      seenIds[key] = true;
      state.resolved[key] = true;
    } catch (e) {
      state.unavailable[meta.threadId] = true;
      markProven(state, meta.id, meta.threadId, meta.date);
      state.resolved[key] = true;
    }
  }
  return true;
}

// Worst plausible cost of reading `n` more bodies, from the slowest per-message cost seen so far.
function projectedCost(n, clock) {
  return n * Math.max(BODY_COST_FLOOR_MS, clock.perMessageMs);
}

// May a read of `n` messages start now? The hard deadline always applies; the soft budget applies unless
// this is the first read of the run (so a run that can still fit one makes progress).
function mayStart(n, clock, first) {
  var now = Date.now();
  if (now + projectedCost(n, clock) > clock.hardDeadline) return false;
  return first || now - clock.startedAt <= clock.budgetMs;
}

// Largest batch (<= BODY_BATCH) that may start now; 0 when none may.
function nextBatchSize(remaining, clock, first) {
  for (var n = Math.min(BODY_BATCH, remaining); n >= 1; n--) {
    if (mayStart(n, clock, first)) return n;
  }
  return 0;
}

function groupByEntry(batch) {
  var byEntry = new Map();
  batch.forEach(function (c) {
    if (!byEntry.has(c.entry)) byEntry.set(c.entry, []);
    byEntry.get(c.entry).push(c);
  });
  return byEntry;
}

// Bodies for the selected candidates, oldest first, in batches of up to BODY_BATCH, while time allows.
// A batch that cannot be read as a batch is retried one message at a time, again only while time allows.
// Returns true when it stopped early (the remaining candidates are left for the next run).
function readSelectedBodies(selected, metaByKey, items, seenIds, state, clock) {
  var i = 0;
  var first = true;
  while (i < selected.length) {
    var n = nextBatchSize(selected.length - i, clock, first);
    if (n < 1) return true;
    first = false;
    var batch = selected.slice(i, i + n);
    i += n;
    var t0 = Date.now();
    batch.forEach(function (c) { state.attempted[msgKey(c.entry, c.appId)] = true; });
    var failed = [];
    groupByEntry(batch).forEach(function (cands, entry) {
      var appIds = cands.map(function (c) { return c.appId; });
      // A group that was already a single read and failed is genuinely unreadable: no point re-reading it.
      if (!readBodies(entry, appIds, metaByKey, items, seenIds, state)) {
        if (cands.length > 1) failed = failed.concat(cands);
        else state.single[msgKey(cands[0].entry, cands[0].appId)] = true;
      }
    });
    clock.perMessageMs = Math.max(clock.perMessageMs, (Date.now() - t0) / batch.length);
    for (var f = 0; f < failed.length; f++) {
      if (!mayStart(1, clock, false)) return true; // the rest stay unresolved -> unavailable
      var t1 = Date.now();
      if (!readBodies(failed[f].entry, [failed[f].appId], metaByKey, items, seenIds, state)) state.single[msgKey(failed[f].entry, failed[f].appId)] = true;
      clock.perMessageMs = Math.max(clock.perMessageMs, Date.now() - t1);
    }
  }
  return false;
}

// Every selected message that was attempted but did not get an item or an explicit verdict (still throwing,
// not retried in time, vanished before the body read) must keep its thread unavailable; with no metadata its
// thread is unknown, so the run is incomplete. Messages never attempted (time ran out first) are simply
// beyond the truncated listing. Metadata-less selected messages are incomplete whether attempted or not.
function flagUnresolved(selected, metaByKey, state) {
  selected.forEach(function (c) {
    var key = msgKey(c.entry, c.appId);
    var meta = metaByKey[key];
    if (!meta) {
      if (!state.metaHandled[key]) state.incomplete = true;
      return;
    }
    if (state.attempted[key] && !state.resolved[key]) {
      state.unavailable[meta.threadId] = true;
      // Proven only when this message was read on its own and that read failed. A batch neighbour that was not
      // retried in time, or a message that vanished mid-read, is deferred: it pins the caller's cursor, nothing more.
      if (state.single[key]) markProven(state, meta.id, meta.threadId, meta.date);
      else state.deferred[meta.threadId] = true;
    }
  });
}

function run(argv) {
  var args = parseArgs(argv);
  // The budget counts from here: a slow `accounts()` (24 s seen on a live Mac) eats into it, so the
  // body batches that follow still finish inside the caller's helper timeout.
  var startedAt = Date.now();
  var reserveMs = Math.min(SAFETY_RESERVE_MS, Math.floor(args.timeoutMs / 4));
  var clock = { startedAt: startedAt, budgetMs: args.budgetMs, hardDeadline: startedAt + args.timeoutMs - reserveMs, perMessageMs: 0 };

  var Mail;
  try {
    Mail = Application('Mail');
    // running() does not launch Mail. A closed Mail is reported, never started, on probe AND sync.
    if (!Mail.running()) {
      fail('mail_not_running_or_unconfigured', 'Mail.app is not running. Open Mail and let it finish setting up an account.');
    }
    var accts = Mail.accounts();
    if (accts.length === 0) {
      fail('mail_not_running_or_unconfigured', 'Mail.app has no accounts configured.');
    }
  } catch (e) {
    var c = classify(e);
    fail(c[0], c[1]);
  }
  if (args.probe) emit({ items: [], status: 'available' }, 0);
  if (args.accounts) {
    var metas = [];
    for (var ai = 0; ai < accts.length; ai++) metas.push(accountMeta(accts[ai]));
    emit({ items: [], accounts: metas }, 0);
  }

  if (!args.targets && !args.since) fail('helper_failed', '--since is required', 2);
  var since = args.since ? new Date(args.since) : null;
  if (since && isNaN(since.getTime())) fail('helper_failed', '--since must be ISO8601', 2);
  if (args.mailboxes.length === 0) fail('helper_failed', '--mailboxes is required', 2);
  // Fail closed: without the accounts gbrain decided on, the only thing left to read would be Mail's unified mailboxes.
  if (!args.routing || args.routing.eligible.length === 0) fail('helper_failed', '--routing is required: the helper reads only the accounts it is given, never Mail\'s unified mailboxes', 2);

  var items = [];
  var state = { unavailable: {}, incomplete: false, metaHandled: {}, attempted: {}, resolved: {}, single: {}, bad: {}, deferred: {}, cand: {} };
  var truncated = false;
  var budgetExhausted = false;
  var targetMissing = [];
  try {
    var scoped = verifyRouting(accts, args.routing);
    var entries = resolveMailboxes(scoped, args.mailboxes);
    var candidates;
    var targetMode = !!args.targets;
    if (targetMode) {
      // Targeted read: only the named messages, found through a narrow received-date window around each one. The
      // window cursor, the --max cap and the --exclude list do not apply: the caller named exactly what it wants.
      var wanted = {};
      var found = {};
      candidates = [];
      args.targets.forEach(function (t) {
        wanted[t.id] = true;
        var at = new Date(t.date).getTime();
        listCandidates(entries, new Date(at - 1000), new Date(at + 1000)).forEach(function (c) {
          if (c.id === t.id && !found[c.id]) { found[c.id] = true; candidates.push(c); }
        });
      });
      Object.keys(wanted).forEach(function (id) { if (!found[id]) targetMissing.push(id); });
    } else {
      candidates = listCandidates(entries, since);
    }
    candidates.sort(function (a, b) { return a.date === b.date ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.date < b.date ? -1 : 1); });
    var candidateIds = Object.create(null);
    var excluded = Object.create(null);
    (args.exclude || []).forEach(function (id) { excluded[id] = true; });
    candidates = candidates.filter(function (c) {
      // Deduplicate one message only inside the same account+mailbox; never collapse equal app ids across Mail accounts.
      var messageKey = msgKey(c.entry, c.appId);
      if (candidateIds[messageKey]) return false;
      candidateIds[messageKey] = true;
      if (targetMode) return true;
      // A held message is never listed, read or reported: it costs no body time and cannot starve its neighbours.
      if (excluded[c.id]) return false;
      return !args.afterDate || !args.afterId || c.date > args.afterDate || (c.date === args.afterDate && c.id > args.afterId);
    });
    truncated = !targetMode && candidates.length > args.max;
    var selected = targetMode ? candidates : candidates.slice(0, args.max);
    var selectedByEntry = new Map();
    selected.forEach(function (c) {
      state.cand[msgKey(c.entry, c.appId)] = c;
      if (!selectedByEntry.has(c.entry)) selectedByEntry.set(c.entry, []);
      selectedByEntry.get(c.entry).push(c.appId);
    });
    var metaByKey = {};
    entries.forEach(function (entry) { readMeta(entry, selectedByEntry.get(entry) || [], metaByKey, state); });
    var seenIds = {};
    budgetExhausted = readSelectedBodies(selected, metaByKey, items, seenIds, state, clock);
    flagUnresolved(selected, metaByKey, state);
    if (budgetExhausted) truncated = true;
  } catch (e2) {
    var c2 = classify(e2);
    fail(c2[0], c2[1]);
  }
  items.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (!args.targets && args.afterDate && args.afterId) {
    items = items.filter(function (m) { return m.date > args.afterDate || (m.date === args.afterDate && m.id > args.afterId); });
  }
  if (!args.targets) {
    truncated = truncated || items.length > args.max;
    if (items.length > args.max) items = items.slice(0, args.max);
  }
  var doc = { items: items, truncated: truncated, budget_exhausted: budgetExhausted, unavailable: Object.keys(state.unavailable),
    unavailable_messages: Object.keys(state.bad).map(function (id) { return state.bad[id]; }), deferred: Object.keys(state.deferred), incomplete: state.incomplete };
  if (args.targets) doc.target_missing = targetMissing;
  emit(doc, 0);
}
