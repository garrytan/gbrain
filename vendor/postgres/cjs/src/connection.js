const net = require('net')
const tls = require('tls')
const crypto = require('crypto')
const Stream = require('stream')
const { performance } = require('perf_hooks')

const { stringify, handleValue, arrayParser, arraySerializer } = require('./types.js')
const { Errors } = require('./errors.js')
const Result = require('./result.js')
const Queue = require('./queue.js')
const { Query, CLOSE } = require('./query.js')
const b = require('./bytes.js')

module.exports = Connection

let uid = 1

const Sync = b().S().end()
    , Flush = b().H().end()
    , SSLRequest = b().i32(8).i32(80877103).end(8)
    , ExecuteUnnamed = Buffer.concat([b().E().str(b.N).i32(0).end(), Sync])
    , DescribeUnnamed = b().D().str('S').str(b.N).end()
    , Unbuildable = b().Q().str('postgres.js: query could not be built' + b.N).end()
    , noop = () => { /* noop */ }

const retryRoutines = new Set([
  'FetchPreparedStatement',
  'RevalidateCachedQuery',
  'transformAssignedExpr'
])

const errorFields = {
  83  : 'severity_local',    // S
  86  : 'severity',          // V
  67  : 'code',              // C
  77  : 'message',           // M
  68  : 'detail',            // D
  72  : 'hint',              // H
  80  : 'position',          // P
  112 : 'internal_position', // p
  113 : 'internal_query',    // q
  87  : 'where',             // W
  115 : 'schema_name',       // s
  116 : 'table_name',        // t
  99  : 'column_name',       // c
  100 : 'data type_name',    // d
  110 : 'constraint_name',   // n
  70  : 'file',              // F
  76  : 'line',              // L
  82  : 'routine'            // R
}

function Connection(options, queues = {}, { onopen = noop, onend = noop, onclose = noop, onstuck = noop, ondesync = noop } = {}) {
  const {
    sslnegotiation,
    ssl,
    max,
    user,
    host,
    port,
    database,
    parsers,
    transform,
    onnotice,
    onnotify,
    onparameter,
    max_pipeline,
    keep_alive,
    backoff,
    target_session_attrs
  } = options

  const sent = Queue()
      , id = uid++
      , backend = { pid: null, secret: null }
      , idleTimer = timer(end, options.idle_timeout)
      , lifeTimer = timer(end, options.max_lifetime)
      , connectTimer = timer(connectTimedOut, options.connect_timeout)
      , inflightTimer = budgetTimer('idle')
      , ageTimer = budgetTimer('age')

  let socket = null
    , cancelMessage
    , cancelResolve
    , cancelReject
    , cancelError
    , errorResponse = null
    , result = new Result()
    , incoming = Buffer.alloc(0)
    , needsTypes = options.fetch_types
    , backendParameters = {}
    , statements = {}
    , statementId = Math.random().toString(36).slice(2)
    , statementCount = 1
    , closedTime = 0
    , remaining = 0
    , hostIndex = 0
    , retries = 0
    , length = 0
    , delay = 0
    , rows = 0
    , serverSignature = null
    , nextWriteTimer = null
    , lastWritten = null
    , lastExecuted = null
    , deferredRetries = []
    , terminated = false
    , incomings = null
    , results = null
    , initial = null
    , ending = null
    , stream = null
    , chunk = null
    , ended = null
    , nonce = null
    , query = null
    , queryStart = 0
    , received = 0
    , localBudget = undefined
    , sessionBudget = undefined
    , recovering = null
    , final = null

  const connection = {
    queue: queues.closed,
    idleTimer,
    inflightSince: 0,
    inflightCap: 0,
    connect(query) {
      initial = query
      reconnect()
    },
    terminate,
    execute,
    cancel,
    end,
    count: 0,
    id
  }

  queues.closed && queues.closed.push(connection)

  return connection

  async function createSocket() {
    let x
    try {
      x = options.socket
        ? (await Promise.resolve(options.socket(options)))
        : new net.Socket()
    } catch (e) {
      error(e)
      return
    }
    x.on('error', error)
    x.on('close', closed)
    x.on('drain', drain)
    return x
  }

  async function cancel({ pid, secret }, resolve, reject) {
    cancelResolve = resolve
    cancelReject = reject
    try {
      cancelMessage = b().i32(16).i32(80877102).i32(pid).i32(secret).end(16)
      await connect()
      if (!socket)
        reject(cancelError || Errors.connection('CONNECTION_CLOSED', options))
    } catch (error) {
      reject(error)
    }
  }

  function execute(q) {
    if (terminated)
      return queryError(q, Errors.connection('CONNECTION_DESTROYED', options))

    if (stream)
      return queryError(q, Errors.generic('COPY_IN_PROGRESS', 'You cannot execute queries during copy'))

    if (q.cancelled)
      return

    let mayPipeline = !q.options.onexecute
    try {
      q.state = backend
      query
        ? sent.push(q)
        : (query = q, query.active = true, armInflight())

      build(q)
      mayPipeline = mayPipeline || q.options.onexecute(connection)
      noteBudget(q)
      lastWritten = q
      lastExecuted = q
      return write(toBuffer(q))
        && !q.describeFirst
        && !q.cursorFn
        && sent.length < max_pipeline
        && mayPipeline
    } catch (error) {
      // GBrain (#6383), the approach of porsager/postgres#1236: q already has its place in the queue of
      // queries awaiting an answer, but nothing of it was written. The stock catch rejected the connection's
      // current query with q's error and left q waiting, so every later answer went to the wrong query.
      // Send a query the server is sure to refuse in q's place: q gets an answer of its own, every later
      // answer stays with its query, and a transaction q was part of is aborted instead of committing
      // without it. q is then rejected with its own error, as a retried query is (ReadyForQuery). It is no
      // longer described first or a cursor, since either would make the server's error send a Sync of its
      // own and shift the next answer.
      q.retried = error
      q.describeFirst = false
      q.cursorFn = null
      // GBrain (#6543): the stock `return true` let the pool route more statements behind q whatever max_pipeline and
      // onexecute said, so a pool built not to pipeline (a transaction-mode pooler) pipelined after every build failure.
      // onexecute (a transaction's begin) ran only if q built; a begin that failed to build is never pipelined behind.
      options.onbuilderror && reportBuildError(q, error)
      return write(Unbuildable)
        && sent.length < max_pipeline
        && mayPipeline
    }
  }

  function reportBuildError(q, error) {
    try {
      options.onbuilderror(error && error.code ? error.code : 'BUILD_FAILED', statementText(q), error && error.parameter)
    } catch (_) {}
  }

  // The statement's text with $n placeholders, never its parameter values.
  function statementText(q) {
    const strings = Array.isArray(q.strings) ? q.strings : [String(q.strings)]
    return String(q.string || strings.reduce((a, s, i) => a + '$' + i + s)).replace(/\s+/g, ' ').trim().slice(0, 200)
  }

  // GBrain (#6383): the head statement's clock. It starts when a statement becomes the head, restarts on every
  // byte the server sends and stops at ReadyForQuery. A statement that outlives options.inflight_timeout with
  // nothing coming back (a desynced connection, a pooler that swallowed a CancelRequest, a dead peer) has no
  // server-side timeout left to save it: the connection is retired instead of holding its queue forever.
  //
  // GBrain (#6543 A4): a second clock, `ageTimer`, is not restarted by received bytes, so a statement that keeps
  // streaming (or keeps receiving notices) past its budget is retired too (`reason: 'age'`; `'idle'` when nothing came
  // back). Both budgets are derived per statement from the statement_timeout the operation itself declared on this
  // connection (`SET [LOCAL] statement_timeout`, `set_config('statement_timeout', ...)`, tracked client-side so it
  // holds behind a transaction-mode pooler that never applies it): max(the pool's budget, the declared timeout) plus
  // `inflight_grace`, and none at all for a declared timeout of 0 (an index build, a bulk copy).
  function armInflight() {
    queryStart = connection.inflightSince = performance.now()
    received = 0
    query.inflightCaps || (query.inflightCaps = inflightCaps())
    connection.inflightCap = query.inflightCaps.age
    inflightTimer.start()
    ageTimer.start()
  }

  function budgetTimer(kind) {
    let handle = null
    return {
      cancel() {
        handle && (clearTimeout(handle), handle = null)
      },
      start() {
        handle && clearTimeout(handle)
        const ms = query && query.inflightCaps ? query.inflightCaps[kind] : 0
        handle = ms ? setTimeout(() => (handle = null, inflightTimedOut(kind)), ms) : null
      }
    }
  }

  function inflightCaps() {
    const declared = localBudget !== undefined ? localBudget : sessionBudget
    if (declared === 0)
      return { idle: 0, age: 0 }
    const raised = declared === undefined ? 0 : declared + (options.inflight_grace || 0) * 1000
    return {
      idle: options.inflight_timeout ? Math.max(options.inflight_timeout * 1000, raised) : 0,
      age: options.inflight_max ? Math.max(options.inflight_max * 1000, raised) : 0
    }
  }

  // The statement_timeout changes a statement makes on this connection; a later statement is budgeted by them.
  function noteBudget(q) {
    const text = q.string || ''
    if (localBudget === undefined && sessionBudget === undefined && !/statement_timeout/i.test(text))
      return
    for (const change of statementTimeoutChanges(text, q.parameters)) {
      change.kind === 'end'
        ? localBudget = undefined
        : change.kind === 'reset'
          ? localBudget = sessionBudget = undefined
          : change.kind === 'set' && (change.local ? localBudget = change.ms : (sessionBudget = change.ms, localBudget = undefined))
    }
    q.inflightCaps = inflightCaps()
    if (q === query) {
      connection.inflightCap = q.inflightCaps.age
      inflightTimer.start()
      ageTimer.start()
    }
  }

  function inflightTimedOut(kind = 'idle') {
    if (!query)
      return
    inflightTimer.cancel()
    ageTimer.cancel()
    const reason = kind === 'age' && received > 0 ? 'age' : 'idle'
    const stuck = { age_ms: Math.round(performance.now() - queryStart), queued: sent.length, statement: statementText(query), reason, budget_ms: query.inflightCaps ? query.inflightCaps[kind] : 0 }
    const s = socket
    recovering = recovering || 'stuck'
    error(Errors.connection('CONNECTION_STUCK', options, socket))
    query = null
    connection.inflightSince = 0
    onstuck(connection, stuck)
    terminate()
    if (s && !s.destroyed) {
      const t = setTimeout(() => s.destroyed || s.destroy(), 1000)
      t.unref && t.unref()
    }
  }

  function toBuffer(q) {
    if (q.parameters.length >= 65534)
      throw Errors.generic('MAX_PARAMETERS_EXCEEDED', 'Max number of parameters (65534) exceeded')

    return q.options.simple
      ? b().Q().str(q.statement.string + b.N).end()
      : q.describeFirst
        ? Buffer.concat([describe(q), Flush])
        : q.prepare
          ? q.prepared
            ? prepared(q)
            : Buffer.concat([describe(q), prepared(q)])
          : unnamed(q)
  }

  function describe(q) {
    return Buffer.concat([
      Parse(q.statement.string, q.parameters, q.statement.types, q.statement.name),
      Describe('S', q.statement.name)
    ])
  }

  function prepared(q) {
    return Buffer.concat([
      Bind(q.parameters, q.statement.types, q.statement.name, q.cursorName),
      q.cursorFn
        ? Execute('', q.cursorRows)
        : ExecuteUnnamed
    ])
  }

  function unnamed(q) {
    return Buffer.concat([
      Parse(q.statement.string, q.parameters, q.statement.types),
      DescribeUnnamed,
      prepared(q)
    ])
  }

  function build(q) {
    const parameters = []
        , types = []

    const string = stringify(q, q.strings[0], q.args[0], parameters, types, options)

    !q.tagged && q.args.forEach(x => handleValue(x, parameters, types, options))

    q.prepare = options.prepare && ('prepare' in q.options ? q.options.prepare : true)
    q.string = string
    q.signature = q.prepare && types + string
    q.onlyDescribe && (delete statements[q.signature])
    q.parameters = q.parameters || parameters
    q.prepared = q.prepare && q.signature in statements
    // GBrain: a statement this pool already described on another connection reuses its parameter
    // types, so it is parsed, described and executed in one pipelined message group (no describe first).
    q.typesKey = options.shared_types && parameters.length && !q.onlyDescribe ? types + string : null
    const shared = !q.prepared && q.typesKey && options.shared_types.get(q.typesKey)
    q.sharedTypes = !!shared
    q.describeFirst = q.onlyDescribe || (parameters.length && !q.prepared && !shared)
    q.statement = q.prepared
      ? statements[q.signature]
      : { string, types: shared ? shared.slice() : types, name: q.prepare ? statementId + statementCount++ : '' }

    typeof options.debug === 'function' && options.debug(id, string, parameters, types)
  }

  function write(x, fn) {
    chunk = chunk ? Buffer.concat([chunk, x]) : Buffer.from(x)
    if (fn || chunk.length >= 1024)
      return nextWrite(fn)
    nextWriteTimer === null && (nextWriteTimer = setImmediate(nextWrite))
    return true
  }

  function nextWrite(fn) {
    const x = socket.write(chunk, fn)
    nextWriteTimer !== null && clearImmediate(nextWriteTimer)
    chunk = nextWriteTimer = null
    return x
  }

  function connectTimedOut() {
    errored(Errors.connection('CONNECT_TIMEOUT', options, socket))
    socket.destroy()
  }

  async function secure() {
    if (sslnegotiation !== 'direct') {
      write(SSLRequest)
      const canSSL = await new Promise(r => socket.once('data', x => r(x[0] === 83))) // S

      if (!canSSL && ssl === 'prefer')
        return connected()
    }

    const options = {
      socket,
      servername: net.isIP(socket.host) ? undefined : socket.host
    }

    if (sslnegotiation === 'direct')
      options.ALPNProtocols = ['postgresql']

    if (ssl === 'require' || ssl === 'allow' || ssl === 'prefer')
      options.rejectUnauthorized = false
    else if (typeof ssl === 'object')
      Object.assign(options, ssl)

    socket.removeAllListeners()
    socket = tls.connect(options)
    socket.on('secureConnect', connected)
    socket.on('error', error)
    socket.on('close', closed)
    socket.on('drain', drain)
  }

  /* c8 ignore next 3 */
  function drain() {
    !query && !connection.reserved && onopen(connection)
  }

  function data(x) {
    query && (received += x.length, inflightTimer.start())
    if (incomings) {
      incomings.push(x)
      remaining -= x.length
      if (remaining > 0)
        return
    }

    incoming = incomings
      ? Buffer.concat(incomings, length - remaining)
      : incoming.length === 0
        ? x
        : Buffer.concat([incoming, x], incoming.length + x.length)

    while (incoming.length > 4) {
      length = incoming.readUInt32BE(1)
      if (length >= incoming.length) {
        remaining = length - incoming.length
        incomings = [incoming]
        break
      }

      try {
        handle(incoming.subarray(0, length + 1))
      } catch (e) {
        query && (query.cursorFn || query.describeFirst) && write(Sync)
        errored(e)
      }
      incoming = incoming.subarray(length + 1)
      remaining = 0
      incomings = null
    }
  }

  async function connect() {
    terminated = false
    backendParameters = {}
    socket || (socket = await createSocket())

    if (!socket)
      return

    connectTimer.start()

    if (options.socket)
      return ssl ? secure() : connected()

    socket.on('connect', ssl ? secure : connected)

    if (options.path)
      return socket.connect(options.path)

    socket.ssl = ssl
    socket.connect(port[hostIndex], host[hostIndex])
    socket.host = host[hostIndex]
    socket.port = port[hostIndex]

    hostIndex = (hostIndex + 1) % port.length
  }

  function reconnect() {
    setTimeout(connect, closedTime ? Math.max(0, closedTime + delay - performance.now()) : 0)
  }

  function connected() {
    try {
      statements = {}
      needsTypes = options.fetch_types
      statementId = Math.random().toString(36).slice(2)
      statementCount = 1
      lifeTimer.start()
      socket.on('data', data)
      keep_alive && socket.setKeepAlive && socket.setKeepAlive(true, 1000 * keep_alive)
      const s = StartupMessage()
      write(s)
    } catch (err) {
      error(err)
    }
  }

  function error(err) {
    if (cancelMessage)
      cancelError = err
    if (connection.queue === queues.connecting && options.host[retries + 1])
      return

    errored(err)
    while (sent.length)
      queryError(sent.shift(), err)
    while (deferredRetries.length)
      queryError(deferredRetries.shift(), err)
  }

  function errored(err) {
    if (cancelMessage)
      cancelError = err
    stream && (stream.destroy(err), stream = null)
    query && queryError(query, err)
    initial && recovering && recoveryFailed(err)
    initial && (queryError(initial, err), initial = null)
  }

  // GBrain (#6543 A6): a connection retired by an incident (stuck, desync, closed under statements) that completes a
  // new startup is `recovered`; one whose reconnect fails is `recovery_failed` (it stays marked until one succeeds).
  function recoveryFailed(err) {
    try {
      options.onrecoveryfailed && options.onrecoveryfailed({ connection: id, cause: recovering, code: String(err && err.code || 'CONNECTION_ERROR') })
    } catch (_) {}
  }

  function queryError(query, err) {
    if (query.reserve)
      return query.reject(err)

    if (!err || typeof err !== 'object')
      err = new Error(err)

    'query' in err || 'parameters' in err || Object.defineProperties(err, {
      stack: { value: err.stack + query.origin.replace(/.*\n/, '\n'), enumerable: options.debug },
      query: { value: query.string, enumerable: options.debug },
      parameters: { value: query.parameters, enumerable: options.debug },
      args: { value: query.args, enumerable: options.debug },
      types: { value: query.statement && query.statement.types, enumerable: options.debug }
    })
    query.reject(err)
  }

  function end() {
    return ending || (
      !connection.reserved && onend(connection),
      !connection.reserved && !initial && !query && sent.length === 0
        ? (terminate(), new Promise(r => socket && socket.readyState !== 'closed' ? socket.once('close', r) : r()))
        : ending = new Promise(r => ended = r)
    )
  }

  function terminate() {
    terminated = true
    if (stream || query || initial || sent.length)
      error(Errors.connection('CONNECTION_DESTROYED', options))

    clearImmediate(nextWriteTimer)
    if (socket) {
      socket.removeListener('data', data)
      socket.removeListener('connect', connected)
      socket.readyState === 'open' && socket.end(b().X().end())
    }
    ended && (ended(), ending = ended = null)
  }

  async function closed(hadError) {
    incoming = Buffer.alloc(0)
    remaining = 0
    incomings = null
    clearImmediate(nextWriteTimer)
    // GBrain (#6355): bytes still waiting for the cleared immediate belonged to this socket. Left in place, the next
    // connection's StartupMessage is appended to them and never scheduled for writing (the timer handle is not
    // null), so the connection sits open until CONNECT_TIMEOUT and every statement bound to it fails.
    chunk = nextWriteTimer = null
    socket.removeListener('data', data)
    socket.removeListener('connect', connected)
    idleTimer.cancel()
    lifeTimer.cancel()
    connectTimer.cancel()
    inflightTimer.cancel()
    ageTimer.cancel()
    connection.inflightSince = connection.inflightCap = 0
    localBudget = sessionBudget = undefined

    socket.removeAllListeners()
    socket = null

    if (cancelMessage)
      return cancelError || hadError
        ? cancelReject(cancelError || Errors.connection('CONNECTION_CLOSED', options))
        : cancelResolve()

    if (initial) {
      // GBrain (#6355): a connection that died during startup (its backend terminated under the array-types fetch)
      // leaves that internal query and the error it saw behind. The fresh connection must not deliver the stale
      // error to the caller's query at its first ReadyForQuery, and the internal query settles here instead of
      // rejecting with nobody to hear it.
      query && query !== initial && queryError(query, Errors.connection('CONNECTION_CLOSED', options, socket))
      query = results = errorResponse = null
      return reconnect()
    }

    // GBrain (#6543 A6): a socket that closed under statements is a recovery the next completed startup reports.
    ;(query || sent.length) && (recovering = recovering || 'closed')
    !hadError && (query || sent.length) && error(Errors.connection('CONNECTION_CLOSED', options, socket))
    // GBrain (#6543): the dead socket's ErrorResponse (a FATAL 57P01, a pooler's XX000) and its partial result belonged
    // to statements that just failed. Left in place, the replacement connection's startup ReadyForQuery handed that
    // error to its first statement, and a stale row count left holes at the start of the next result.
    query = errorResponse = results = null
    result = new Result()
    rows = 0
    closedTime = performance.now()
    hadError && options.shared.retries++
    delay = (typeof backoff === 'function' ? backoff(options.shared.retries) : backoff) * 1000
    onclose(connection, Errors.connection('CONNECTION_CLOSED', options, socket))
  }

  /* Handlers */
  function handle(xs, x = xs[0]) {
    if (!query && !initial && !stream && answersStatement(xs, x)) {
      desynced(x)
      return
    }
    (
      x === 68 ? DataRow :                   // D
      x === 100 ? CopyData :                 // d
      x === 65 ? NotificationResponse :      // A
      x === 83 ? ParameterStatus :           // S
      x === 90 ? ReadyForQuery :             // Z
      x === 67 ? CommandComplete :           // C
      x === 50 ? BindComplete :              // 2
      x === 49 ? ParseComplete :             // 1
      x === 116 ? ParameterDescription :     // t
      x === 84 ? RowDescription :            // T
      x === 82 ? Authentication :            // R
      x === 110 ? NoData :                   // n
      x === 75 ? BackendKeyData :            // K
      x === 69 ? ErrorResponse :             // E
      x === 115 ? PortalSuspended :          // s
      x === 51 ? CloseComplete :             // 3
      x === 71 ? CopyInResponse :            // G
      x === 78 ? NoticeResponse :            // N
      x === 72 ? CopyOutResponse :           // H
      x === 99 ? CopyDone :                  // c
      x === 73 ? EmptyQueryResponse :        // I
      x === 86 ? FunctionCallResponse :      // V
      x === 118 ? NegotiateProtocolVersion : // v
      x === 87 ? CopyBothResponse :          // W
      /* c8 ignore next */
      UnknownMessage
    )(xs)
  }

  // GBrain: a message that answers a statement (its columns, rows, completion, parse/bind acknowledgements or a
  // statement error) arriving when no statement is waiting for one means the client and the server no longer
  // agree on which answer belongs to which statement: every later answer on this connection would be read for
  // the wrong query. The connection is retired and everything queued on it fails with CONNECTION_DESYNC.
  // Notices, parameter changes, notifications, ReadyForQuery and a FATAL/PANIC error legitimately arrive
  // without a statement and pass through.
  function answersStatement(xs, x) {
    if (x === 84 || x === 68 || x === 67 || x === 73 || x === 49 || x === 50 || x === 116 || x === 110)
      return true
    if (x !== 69)
      return false
    const fields = parseError(xs)
    const severity = fields.severity || fields.severity_local
    return severity !== 'FATAL' && severity !== 'PANIC'
  }

  function desynced(x) {
    const s = socket
    const info = { message: String.fromCharCode(x), connection: id, statement: lastExecuted ? statementText(lastExecuted) : '' }
    recovering = recovering || 'desync'
    error(Errors.connection('CONNECTION_DESYNC', options, socket))
    inflightTimer.cancel()
    ageTimer.cancel()
    query = null
    connection.inflightSince = connection.inflightCap = 0
    ondesync(connection, info)
    terminate()
    if (s && !s.destroyed) {
      const t = setTimeout(() => s.destroyed || s.destroy(), 1000)
      t.unref && t.unref()
    }
  }

  function DataRow(x) {
    let index = 7
    let length
    let column
    let value

    const row = query.isRaw ? new Array(query.statement.columns.length) : {}
    for (let i = 0; i < query.statement.columns.length; i++) {
      column = query.statement.columns[i]
      length = x.readInt32BE(index)
      index += 4

      value = length === -1
        ? null
        : query.isRaw === true
          ? x.subarray(index, index += length)
          : column.parser === undefined
            ? x.toString('utf8', index, index += length)
            : column.parser.array === true
              ? column.parser(x.toString('utf8', index + 1, index += length))
              : column.parser(x.toString('utf8', index, index += length))

      query.isRaw
        ? (row[i] = query.isRaw === true
          ? value
          : transform.value.from ? transform.value.from(value, column) : value)
        : (row[column.name] = transform.value.from ? transform.value.from(value, column) : value)
    }

    query.forEachFn
      ? query.forEachFn(transform.row.from ? transform.row.from(row) : row, result)
      : (result[rows++] = transform.row.from ? transform.row.from(row) : row)
  }

  function ParameterStatus(x) {
    const [k, v] = x.toString('utf8', 5, x.length - 1).split(b.N)
    backendParameters[k] = v
    if (options.parameters[k] !== v) {
      options.parameters[k] = v
      onparameter && onparameter(k, v)
    }
  }

  function ReadyForQuery(x) {
    connection.status = x[5]
    query && query === lastWritten && (lastWritten = null)
    connection.inflightSince = connection.inflightCap = 0
    // A transaction that ended takes its SET LOCAL statement_timeout with it.
    x[5] === 73 && !sent.length && (localBudget = undefined)
    if (query) {
      options.shared.completed++
      if (errorResponse) {
        // GBrain: a failed statement describes again next time instead of trusting shared parameter types.
        query.sharedTypes && options.shared_types.delete(query.typesKey)
        query.retried
          ? errored(query.retried)
          : query.prepared && retryRoutines.has(errorResponse.routine) && !query.cancelled
            ? retry(query, errorResponse)
            : errored(errorResponse)
      } else if (query.cancelled) {
        // GBrain: a query cancelled while it waited behind another one on this connection still gets the
        // server's answer to it; that answer is consumed here and the query rejects as cancelled.
        query.reject(Errors.generic('57014', 'canceling statement due to user request'))
      } else {
        query.resolve(results || result)
      }
    } else if (errorResponse) {
      errored(errorResponse)
    }

    // GBrain: a statement that streamed rows and then failed (a cancel, a timeout or an error after its first rows) never
    // reached CommandComplete, which is where the row count resets. Left in place, the next statement on this connection
    // stored its rows after that many empty slots: a one-row read came back as [empty, row], so a reader that requires
    // exactly one row refused and `const [row] = rows` read nothing.
    query = results = errorResponse = null
    result = new Result()
    rows = 0
    connectTimer.cancel()
    inflightTimer.cancel()
    ageTimer.cancel()

    if (initial) {
      if (target_session_attrs) {
        if (!backendParameters.in_hot_standby || !backendParameters.default_transaction_read_only)
          return fetchState()
        else if (tryNext(target_session_attrs, backendParameters))
          return terminate()
      }

      if (needsTypes) {
        initial.reserve && (initial = null)
        return fetchArrayTypes()
      }

      const reserving = initial && initial.reserve
      initial && !reserving && execute(initial)
      options.shared.retries = retries = 0
      initial = null
      if (recovering) {
        const cause = recovering
        recovering = null
        try {
          options.onrecovered && options.onrecovered({ connection: id, cause })
        } catch (_) {}
      }
      if (!reserving)
        return
    }

    // GBrain: the stock loop skipped a query cancelled while it waited behind another one, so the answer the
    // server still sent for it was read for the next query (the next query resolved with another statement's
    // rows, and the cancelled one never settled). The cancelled query stays current and absorbs its own answer.
    // A server cancel targets the backend, not a statement, so it is only sent when nothing is pipelined behind.
    if (sent.length) {
      query = sent.shift()
      query.active = true
      query.cancelled && (sent.length
        ? query.cancelled.resolve()
        : Connection(options).cancel(query.state, query.cancelled.resolve, query.cancelled.reject))
    }

    flushRetries()

    if (query)
      return armInflight() // Consider opening if able and sent.length < 50

    connection.reserved
      ? !connection.reserved.release && x[5] === 73 // I
        ? ending
          ? terminate()
          : connection.reserved(true)
        : connection.reserved()
      : ending
        ? terminate()
        : onopen(connection)
  }

  function CommandComplete(x) {
    rows = 0

    for (let i = x.length - 1; i > 0; i--) {
      if (x[i] === 32 && x[i + 1] < 58 && result.count === null)
        result.count = +x.toString('utf8', i + 1, x.length - 1)
      if (x[i - 1] >= 65) {
        result.command = x.toString('utf8', 5, i)
        result.state = backend
        break
      }
    }

    final && (final(), final = null)

    if (result.command === 'BEGIN' && max !== 1 && !connection.reserved)
      return errored(Errors.generic('UNSAFE_TRANSACTION', 'Only use sql.begin, sql.reserved or max: 1'))

    if (query.options.simple)
      return BindComplete()

    if (query.cursorFn) {
      result.count && query.cursorFn(result)
      write(Sync)
    }
  }

  function ParseComplete() {
    query.parsing = false
  }

  function BindComplete() {
    !result.statement && (result.statement = query.statement)
    result.columns = query.statement.columns
  }

  function ParameterDescription(x) {
    const length = x.readUInt16BE(5)

    for (let i = 0; i < length; ++i)
      !query.statement.types[i] && (query.statement.types[i] = x.readUInt32BE(7 + i * 4))

    query.prepare && (statements[query.signature] = query.statement)
    // GBrain: only built-in parameter types are shared; a database's own types may be recreated under a new oid.
    query.typesKey && query.statement.types.every(t => t > 0 && t < 16384)
      && options.shared_types.set(query.typesKey, query.statement.types.slice())
    query.describeFirst && !query.onlyDescribe && (write(prepared(query)), query.describeFirst = false)
    flushRetries()
  }

  function RowDescription(x) {
    if (result.command) {
      results = results || [result]
      results.push(result = new Result())
      result.count = null
      query.statement.columns = null
    }

    const length = x.readUInt16BE(5)
    let index = 7
    let start

    query.statement.columns = Array(length)

    for (let i = 0; i < length; ++i) {
      start = index
      while (x[index++] !== 0);
      const table = x.readUInt32BE(index)
      const number = x.readUInt16BE(index + 4)
      const type = x.readUInt32BE(index + 6)
      query.statement.columns[i] = {
        name: transform.column.from
          ? transform.column.from(x.toString('utf8', start, index - 1))
          : x.toString('utf8', start, index - 1),
        parser: parsers[type],
        table,
        number,
        type
      }
      index += 18
    }

    result.statement = query.statement
    if (query.onlyDescribe)
      return (query.resolve(query.statement), write(Sync))
  }

  async function Authentication(x, type = x.readUInt32BE(5)) {
    (
      type === 3 ? AuthenticationCleartextPassword :
      type === 5 ? AuthenticationMD5Password :
      type === 10 ? SASL :
      type === 11 ? SASLContinue :
      type === 12 ? SASLFinal :
      type !== 0 ? UnknownAuth :
      noop
    )(x, type)
  }

  /* c8 ignore next 5 */
  async function AuthenticationCleartextPassword() {
    const payload = await Pass()
    write(
      b().p().str(payload).z(1).end()
    )
  }

  async function AuthenticationMD5Password(x) {
    const payload = 'md5' + (
      await md5(
        Buffer.concat([
          Buffer.from(await md5((await Pass()) + user)),
          x.subarray(9)
        ])
      )
    )
    write(
      b().p().str(payload).z(1).end()
    )
  }

  async function SASL() {
    nonce = (await crypto.randomBytes(18)).toString('base64')
    b().p().str('SCRAM-SHA-256' + b.N)
    const i = b.i
    write(b.inc(4).str('n,,n=*,r=' + nonce).i32(b.i - i - 4, i).end())
  }

  async function SASLContinue(x) {
    const res = x.toString('utf8', 9).split(',').reduce((acc, x) => (acc[x[0]] = x.slice(2), acc), {})

    const saltedPassword = await crypto.pbkdf2Sync(
      await Pass(),
      Buffer.from(res.s, 'base64'),
      parseInt(res.i), 32,
      'sha256'
    )

    const clientKey = await hmac(saltedPassword, 'Client Key')

    const auth = 'n=*,r=' + nonce + ','
               + 'r=' + res.r + ',s=' + res.s + ',i=' + res.i
               + ',c=biws,r=' + res.r

    serverSignature = (await hmac(await hmac(saltedPassword, 'Server Key'), auth)).toString('base64')

    const payload = 'c=biws,r=' + res.r + ',p=' + xor(
      clientKey, Buffer.from(await hmac(await sha256(clientKey), auth))
    ).toString('base64')

    write(
      b().p().str(payload).end()
    )
  }

  function SASLFinal(x) {
    if (x.toString('utf8', 9).split(b.N, 1)[0].slice(2) === serverSignature)
      return
    /* c8 ignore next 5 */
    errored(Errors.generic('SASL_SIGNATURE_MISMATCH', 'The server did not return the correct signature'))
    socket.destroy()
  }

  function Pass() {
    return Promise.resolve(typeof options.pass === 'function'
      ? options.pass()
      : options.pass
    )
  }

  function NoData() {
    result.statement = query.statement
    result.statement.columns = []
    if (query.onlyDescribe)
      return (query.resolve(query.statement), write(Sync))
  }

  function BackendKeyData(x) {
    backend.pid = x.readUInt32BE(5)
    backend.secret = x.readUInt32BE(9)
  }

  async function fetchArrayTypes() {
    needsTypes = false
    let types
    try {
      types = await new Query([`
        select b.oid, b.typarray
        from pg_catalog.pg_type a
        left join pg_catalog.pg_type b on b.oid = a.typelem
        where a.typcategory = 'A'
        group by b.oid, b.typarray
        order by b.oid
      `], [], execute)
    } catch (error) {
      // GBrain (#6355): the fetch failed or its connection closed; errored() has already told the caller's query, and
      // connected() re-arms the fetch for the next connection. Nothing awaits this promise, so it must not reject.
      return
    }
    types.forEach(({ oid, typarray }) => addArrayType(oid, typarray))
  }

  function addArrayType(oid, typarray) {
    if (!!options.parsers[typarray] && !!options.serializers[typarray]) return
    const parser = options.parsers[oid]
    options.shared.typeArrayMap[oid] = typarray
    options.parsers[typarray] = (xs) => arrayParser(xs, parser, typarray)
    options.parsers[typarray].array = true
    options.serializers[typarray] = (xs) => arraySerializer(xs, options.serializers[oid], options, typarray)
  }

  function tryNext(x, xs) {
    return (
      (x === 'read-write' && xs.default_transaction_read_only === 'on') ||
      (x === 'read-only' && xs.default_transaction_read_only === 'off') ||
      (x === 'primary' && xs.in_hot_standby === 'on') ||
      (x === 'standby' && xs.in_hot_standby === 'off') ||
      (x === 'prefer-standby' && xs.in_hot_standby === 'off' && options.host[retries])
    )
  }

  function fetchState() {
    const query = new Query([`
      show transaction_read_only;
      select pg_catalog.pg_is_in_recovery()
    `], [], execute, null, { simple: true })
    query.resolve = ([[a], [b]]) => {
      backendParameters.default_transaction_read_only = a.transaction_read_only
      backendParameters.in_hot_standby = b.pg_is_in_recovery ? 'on' : 'off'
    }
    query.execute()
  }

  function ErrorResponse(x) {
    if (query) {
      (query.cursorFn || query.describeFirst) && write(Sync)
      errorResponse = Errors.postgres(parseError(x))
    } else {
      errored(Errors.postgres(parseError(x)))
    }
  }

  function retry(q, error) {
    delete statements[q.signature]
    q.retried = error
    deferredRetries.push(q)
    flushRetries()
  }

  // GBrain: a describe-first or cursor query writes its next messages only when the server answers its first
  // ones. A retry written in that gap lands between them on the wire, and every later response is then read
  // for the wrong query (rows built with another statement's columns). Retries wait for that query.
  function flushRetries() {
    while (deferredRetries.length && !(lastWritten && (lastWritten.describeFirst || lastWritten.cursorFn)))
      execute(deferredRetries.shift())
  }

  function NotificationResponse(x) {
    if (!onnotify)
      return

    let index = 9
    while (x[index++] !== 0);
    onnotify(
      x.toString('utf8', 9, index - 1),
      x.toString('utf8', index, x.length - 1)
    )
  }

  async function PortalSuspended() {
    try {
      const x = await Promise.resolve(query.cursorFn(result))
      rows = 0
      x === CLOSE
        ? write(Close(query.portal))
        : (result = new Result(), write(Execute('', query.cursorRows)))
    } catch (err) {
      write(Sync)
      query.reject(err)
    }
  }

  function CloseComplete() {
    result.count && query.cursorFn(result)
    query.resolve(result)
  }

  function CopyInResponse() {
    stream = new Stream.Writable({
      autoDestroy: true,
      write(chunk, encoding, callback) {
        socket.write(b().d().raw(chunk).end(), callback)
      },
      destroy(error, callback) {
        callback(error)
        socket.write(b().f().str(error + b.N).end())
        stream = null
      },
      final(callback) {
        socket.write(b().c().end())
        final = callback
        stream = null
      }
    })
    query.resolve(stream)
  }

  function CopyOutResponse() {
    stream = new Stream.Readable({
      read() { socket.resume() }
    })
    query.resolve(stream)
  }

  /* c8 ignore next 3 */
  function CopyBothResponse() {
    stream = new Stream.Duplex({
      autoDestroy: true,
      read() { socket.resume() },
      /* c8 ignore next 11 */
      write(chunk, encoding, callback) {
        socket.write(b().d().raw(chunk).end(), callback)
      },
      destroy(error, callback) {
        callback(error)
        socket.write(b().f().str(error + b.N).end())
        stream = null
      },
      final(callback) {
        socket.write(b().c().end())
        final = callback
      }
    })
    query.resolve(stream)
  }

  function CopyData(x) {
    stream && (stream.push(x.subarray(5)) || socket.pause())
  }

  function CopyDone() {
    stream && stream.push(null)
    stream = null
  }

  function NoticeResponse(x) {
    onnotice
      ? onnotice(parseError(x))
      : console.log(parseError(x)) // eslint-disable-line

  }

  /* c8 ignore next 3 */
  function EmptyQueryResponse() {
    /* noop */
  }

  /* c8 ignore next 3 */
  function FunctionCallResponse() {
    errored(Errors.notSupported('FunctionCallResponse'))
  }

  /* c8 ignore next 3 */
  function NegotiateProtocolVersion() {
    errored(Errors.notSupported('NegotiateProtocolVersion'))
  }

  /* c8 ignore next 3 */
  function UnknownMessage(x) {
    console.error('Postgres.js : Unknown Message:', x[0]) // eslint-disable-line
  }

  /* c8 ignore next 3 */
  function UnknownAuth(x, type) {
    console.error('Postgres.js : Unknown Auth:', type) // eslint-disable-line
  }

  /* Messages */
  function Bind(parameters, types, statement = '', portal = '') {
    let prev
      , type

    b().B().str(portal + b.N).str(statement + b.N).i16(0).i16(parameters.length)

    parameters.forEach((x, i) => {
      if (x === null)
        return b.i32(0xFFFFFFFF)

      type = types[i]
      parameters[i] = x = type in options.serializers
        ? options.serializers[type](x)
        : '' + x

      prev = b.i
      b.inc(4).str(x).i32(b.i - prev - 4, prev)
    })

    b.i16(0)

    return b.end()
  }

  function Parse(str, parameters, types, name = '') {
    b().P().str(name + b.N).str(str + b.N).i16(parameters.length)
    parameters.forEach((x, i) => b.i32(types[i] || 0))
    return b.end()
  }

  function Describe(x, name = '') {
    return b().D().str(x).str(name + b.N).end()
  }

  function Execute(portal = '', rows = 0) {
    return Buffer.concat([
      b().E().str(portal + b.N).i32(rows).end(),
      Flush
    ])
  }

  function Close(portal = '') {
    return Buffer.concat([
      b().C().str('P').str(portal + b.N).end(),
      b().S().end()
    ])
  }

  function StartupMessage() {
    return cancelMessage || b().inc(4).i16(3).z(2).str(
      Object.entries(Object.assign({
        user,
        database,
        client_encoding: 'UTF8'
      },
        options.connection
      )).filter(([, v]) => v).map(([k, v]) => k + b.N + v).join(b.N)
    ).z(2).end(0)
  }

}

function parseError(x) {
  const error = {}
  let start = 5
  for (let i = 5; i < x.length - 1; i++) {
    if (x[i] === 0) {
      error[errorFields[x[start]]] = x.toString('utf8', start + 1, i)
      start = i + 1
    }
  }
  return error
}

function md5(x) {
  return crypto.createHash('md5').update(x).digest('hex')
}

function hmac(key, x) {
  return crypto.createHmac('sha256', key).update(x).digest()
}

function sha256(x) {
  return crypto.createHash('sha256').update(x).digest()
}

function xor(a, b) {
  const length = Math.max(a.length, b.length)
  const buffer = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i++)
    buffer[i] = a[i] ^ b[i]
  return buffer
}

// GBrain (#6543 A4): what one statement does to the connection's statement_timeout, in order: `set` (`local`, `ms`;
// 0 disables it, undefined is DEFAULT), `reset` (RESET statement_timeout / RESET ALL / DISCARD ALL), `end` (a
// transaction began or ended, which drops a SET LOCAL), and `unknown` for a change whose value cannot be read here.
// Dollar-quoted bodies are skipped, so a function body's BEGIN/END is not a transaction boundary.
const budgetSyntax = /(?:^|;)\s*(begin|start\s+transaction|commit|end|abort|rollback(?!\s+(?:to|prepared)\b))\b|\bset\s+(local\s+|session\s+)?statement_timeout\s*(?:=|\bto\b)\s*('(?:[^']|'')*'|[^\s;)]+)|\breset\s+(?:statement_timeout|all)\b|\bdiscard\s+all\b|\bset_config\s*\(\s*'statement_timeout'\s*,\s*('(?:[^']|'')*'|\$\d+)\s*,\s*([^)\s]+)\s*\)/gi

function statementTimeoutChanges(text, parameters) {
  const changes = []
  const plain = String(text || '').replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, ' ')
  budgetSyntax.lastIndex = 0
  let m
  while ((m = budgetSyntax.exec(plain))) {
    if (m[1]) {
      changes.push({ kind: 'end' })
    } else if (m[3] !== undefined) {
      const ms = timeoutMs(m[3], parameters)
      changes.push(Number.isNaN(ms) ? { kind: 'unknown' } : { kind: 'set', local: /^local/i.test(m[2] || ''), ms })
    } else if (m[4] !== undefined) {
      const ms = timeoutMs(m[4], parameters)
      const local = parameterValue(m[5], parameters)
      changes.push(Number.isNaN(ms) || local === undefined ? { kind: 'unknown' } : { kind: 'set', local: /^(t|true|on|1)$/i.test(local), ms })
    } else {
      changes.push({ kind: 'reset' })
    }
  }
  return changes
}

function parameterValue(raw, parameters) {
  const p = /^\$(\d+)$/.exec(raw.trim())
  if (p) {
    const v = parameters && parameters[p[1] - 1]
    return v === null || v === undefined ? undefined : String(v)
  }
  const v = raw.trim()
  return /^'.*'$/s.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v
}

function timeoutMs(raw, parameters) {
  const v = parameterValue(raw, parameters)
  if (v === undefined)
    return NaN
  if (/^default$/i.test(v.trim()))
    return undefined
  const m = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/i.exec(v)
  if (!m)
    return NaN
  const unit = (m[2] || 'ms').toLowerCase()
  return Math.round(+m[1] * { us: 0.001, ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 }[unit])
}

Connection.statementTimeoutChanges = statementTimeoutChanges

function timer(fn, seconds) {
  seconds = typeof seconds === 'function' ? seconds() : seconds
  if (!seconds)
    return { cancel: noop, start: noop }

  let timer
  return {
    cancel() {
      timer && (clearTimeout(timer), timer = null)
    },
    start() {
      timer && clearTimeout(timer)
      timer = setTimeout(done, seconds * 1000, arguments)
    }
  }

  function done(args) {
    fn.apply(null, args)
    timer = null
  }
}
