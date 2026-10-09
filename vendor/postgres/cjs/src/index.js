const os = require('os')
const fs = require('fs')

const {
  mergeUserTypes,
  inferType,
  Parameter,
  Identifier,
  Builder,
  toPascal,
  pascal,
  toCamel,
  camel,
  toKebab,
  kebab,
  fromPascal,
  fromCamel,
  fromKebab
} = require('./types.js')

const Connection = require('./connection.js')
const { Query, CLOSE } = require('./query.js')
const Queue = require('./queue.js')
const { Errors, PostgresError } = require('./errors.js')
const Subscribe = require('./subscribe.js')
const largeObject = require('./large.js')

Object.assign(Postgres, {
  PostgresError,
  toPascal,
  pascal,
  toCamel,
  camel,
  toKebab,
  kebab,
  fromPascal,
  fromCamel,
  fromKebab,
  BigInt: {
    to: 20,
    from: [20],
    parse: x => BigInt(x), // eslint-disable-line
    serialize: x => x.toString()
  }
})

module.exports = Postgres

function Postgres(a, b) {
  const options = parseOptions(a, b)
      , subscribe = options.no_subscribe || Subscribe(Postgres, { ...options })

  let ending = false

  const queries = Queue()
      , connecting = Queue()
      , reserved = Queue()
      , closed = Queue()
      , ended = Queue()
      , open = Queue()
      , busy = Queue()
      , full = Queue()
      , queues = { connecting, reserved, closed, ended, open, busy, full }

  const connections = [...Array(options.max)].map(() => Connection(options, queues, { onopen, onend, onclose }))

  const sql = Sql(handler)

  Object.assign(sql, {
    get parameters() { return options.parameters },
    // GBrain: the pool's own queue lengths, read-only, for the consumer's pool diagnostics (#6317).
    get pool() {
      return {
        max: options.max,
        open: open.length,
        busy: busy.length,
        full: full.length,
        reserved: reserved.length,
        connecting: connecting.length,
        closed: closed.length,
        ended: ended.length,
        queued: queries.length
      }
    },
    largeObject: largeObject.bind(null, sql),
    subscribe,
    CLOSE,
    END: CLOSE,
    PostgresError,
    options,
    reserve,
    listen,
    begin,
    close,
    end
  })

  return sql

  function Sql(handler) {
    handler.debug = options.debug

    Object.entries(options.types).reduce((acc, [name, type]) => {
      acc[name] = (x) => new Parameter(x, type.to)
      return acc
    }, typed)

    Object.assign(sql, {
      types: typed,
      typed,
      unsafe,
      notify,
      array,
      json,
      file
    })

    return sql

    function typed(value, type) {
      return new Parameter(value, type)
    }

    function sql(strings, ...args) {
      const query = strings && Array.isArray(strings.raw)
        ? new Query(strings, args, handler, cancel)
        : typeof strings === 'string' && !args.length
          ? new Identifier(options.transform.column.to ? options.transform.column.to(strings) : strings)
          : new Builder(strings, args)
      return query
    }

    function unsafe(string, args = [], options = {}) {
      arguments.length === 2 && !Array.isArray(args) && (options = args, args = [])
      const query = new Query([string], args, handler, cancel, {
        prepare: false,
        ...options,
        simple: 'simple' in options ? options.simple : args.length === 0
      })
      return query
    }

    function file(path, args = [], options = {}) {
      arguments.length === 2 && !Array.isArray(args) && (options = args, args = [])
      const query = new Query([], args, (query) => {
        fs.readFile(path, 'utf8', (err, string) => {
          if (err)
            return query.reject(err)

          query.strings = [string]
          handler(query)
        })
      }, cancel, {
        ...options,
        simple: 'simple' in options ? options.simple : args.length === 0
      })
      return query
    }
  }

  async function listen(name, fn, onlisten) {
    const listener = { fn, onlisten }

    const sql = listen.sql || (listen.sql = Postgres({
      ...options,
      max: 1,
      idle_timeout: null,
      max_lifetime: null,
      fetch_types: false,
      onclose() {
        Object.entries(listen.channels).forEach(([name, { listeners }]) => {
          delete listen.channels[name]
          Promise.all(listeners.map(l => listen(name, l.fn, l.onlisten).catch(() => { /* noop */ })))
        })
      },
      onnotify(c, x) {
        c in listen.channels && listen.channels[c].listeners.forEach(l => l.fn(x))
      }
    }))

    const channels = listen.channels || (listen.channels = {})
        , exists = name in channels

    if (exists) {
      channels[name].listeners.push(listener)
      const result = await channels[name].result
      listener.onlisten && listener.onlisten()
      return { state: result.state, unlisten }
    }

    channels[name] = { result: sql`listen ${
      sql.unsafe('"' + name.replace(/"/g, '""') + '"')
    }`, listeners: [listener] }
    const result = await channels[name].result
    listener.onlisten && listener.onlisten()
    return { state: result.state, unlisten }

    async function unlisten() {
      if (name in channels === false)
        return

      channels[name].listeners = channels[name].listeners.filter(x => x !== listener)
      if (channels[name].listeners.length)
        return

      delete channels[name]
      return sql`unlisten ${
        sql.unsafe('"' + name.replace(/"/g, '""') + '"')
      }`
    }
  }

  async function notify(channel, payload) {
    return await sql`select pg_notify(${ channel }, ${ '' + payload })`
  }

  function own(c) {
    const queue = Queue()
    let busy = false, fence = null, holding = null, releasing = false
    const reservation = c.reserved = (ended = false) => {
      if (c.reserved !== reservation)
        return
      busy = false
      if (ended) {
        releasing = true
        reservation.reject(Errors.generic('CONNECTION_CLOSED', 'Transaction has ended'))
      }
      const completed = fence
      fence = null
      if (completed && completed.cancelPromise) {
        holding = completed
        completed.cancelPromise.then(() => {
          if (c.reserved !== reservation || holding !== completed)
            return
          holding = null
          pump()
        }, reservation.discard)
      } else {
        pump()
      }
    }
    reservation.enqueue = q => {
      if (c.reserved !== reservation || releasing)
        return q.reject(Errors.generic('CONNECTION_CLOSED', 'Connection is no longer owned'))
      queue.push(q)
      pump()
    }
    reservation.reject = error => {
      while (queue.length)
        queue.shift().reject(error)
    }
    reservation.discard = () => {
      if (c.reserved !== reservation)
        return
      c.reserved = null
      reservation.reject(Errors.generic('CONNECTION_CLOSED', 'Connection was discarded'))
      c.terminate()
    }
    reservation.releaseConnection = () => {
      if (c.reserved !== reservation)
        return
      releasing = true
      pump()
    }
    return reservation

    function pump() {
      if (c.reserved !== reservation || holding || fence)
        return
      while (queue.length) {
        const q = queue.peek()
        if (q.cancelled) {
          queue.shift()
          continue
        }
        if (busy && (q.options.cancelFence || c.queue === full))
          return
        queue.shift()
        busy = true
        if (q.options.cancelFence)
          fence = q
        const ready = c.execute(q)
        move(c, ready ? reserved : full)
        if (fence || !ready)
          return
      }
      if (!busy) {
        if (releasing) {
          c.reserved = null
          onopen(c, true)
        } else {
          move(c, reserved)
        }
      }
    }
  }

  async function reserve({ signal } = {}) {
    signal && signal.throwIfAborted()
    if (ending)
      throw Errors.connection('CONNECTION_ENDED', options, options)
    const sql = open.length
      ? claim(open.shift())
      : await new Promise((resolve, reject) => {
        let settled = false
        const query = {
          reserve: c => { if (settle()) resolve(claim(c)) },
          reject: error => { if (settle()) reject(error) }
        }
        const abort = () => query.reject(signal.reason)
        function settle() {
          if (settled)
            return false
          settled = true
          queries.remove(query)
          signal && signal.removeEventListener('abort', abort)
          return true
        }
        if (signal)
          signal.addEventListener('abort', abort, { once: true })
        queries.push(query)
        closed.length && connect(closed.shift(), query)
      })

    if (signal && signal.aborted) {
      sql.release()
      signal.throwIfAborted()
    }

    return sql

    function claim(c) {
      move(c, reserved)
      const reservation = own(c)
      reservation.release = true
      const sql = Sql(reservation.enqueue)
      sql.release = reservation.releaseConnection
      sql.discard = reservation.discard
      return sql
    }
  }

  async function begin(options, fn) {
    !fn && (fn = options, options = '')
    let savepoints = 0
      , connection
      , prepare = null

    try {
      await sql.unsafe('begin ' + options.replace(/[^a-z ]/ig, ''), [], { onexecute }).execute()
      return await Promise.race([
        scope(connection, fn),
        new Promise((_, reject) => connection.onclose = reject)
      ])
    } catch (error) {
      throw error
    }

    async function scope(c, fn, name) {
      const reservation = c.reserved
      if (!reservation)
        throw Errors.generic('CONNECTION_CLOSED', 'Transaction connection is no longer owned')
      const sql = Sql(handler)
      sql.savepoint = savepoint
      sql.prepare = x => prepare = x.replace(/[^a-z0-9$-_. ]/gi)
      sql.discard = reservation.discard
      let uncaughtError
        , result

      name && await sql`savepoint ${ sql(name) }`
      try {
        result = await new Promise((resolve, reject) => {
          const x = fn(sql)
          Promise.resolve(Array.isArray(x) ? Promise.all(x) : x).then(resolve, reject)
        })

        if (uncaughtError)
          throw uncaughtError
      } catch (e) {
        await (name
          ? sql`rollback to ${ sql(name) }`
          : sql`rollback`
        )
        throw e instanceof PostgresError && e.code === '25P02' && uncaughtError || e
      }

      if (!name) {
        prepare
          ? await sql`prepare transaction '${ sql.unsafe(prepare) }'`
          : await sql`commit`
      }

      return result

      function savepoint(name, fn) {
        if (c.reserved !== reservation)
          return Promise.reject(Errors.generic('CONNECTION_CLOSED', 'Transaction connection is no longer owned'))
        if (name && Array.isArray(name.raw))
          return savepoint(sql => sql.apply(sql, arguments))

        arguments.length === 1 && (fn = name, name = null)
        return scope(c, fn, 's' + savepoints++ + (name ? '_' + name : ''))
      }

      function handler(q) {
        q.catch(e => uncaughtError || (uncaughtError = e))
        if (!reservation || c.reserved !== reservation)
          return q.reject(Errors.generic('CONNECTION_CLOSED', 'Transaction connection is no longer owned'))
        reservation.enqueue(q)
      }
    }

    function onexecute(c) {
      connection = c
      move(c, reserved)
      own(c)
    }
  }

  function move(c, queue) {
    c.queue.remove(c)
    queue.push(c)
    c.queue = queue
    queue === open
      ? c.idleTimer.start()
      : c.idleTimer.cancel()
    return c
  }

  function json(x) {
    return new Parameter(x, 3802)
  }

  function array(x, type) {
    if (!Array.isArray(x))
      return array(Array.from(arguments))

    return new Parameter(x, type || (x.length ? inferType(x) || 25 : 0), options.shared.typeArrayMap)
  }

  function handler(query) {
    if (ending)
      return query.reject(Errors.connection('CONNECTION_ENDED', options, options))

    if (open.length)
      return go(open.shift(), query)

    if (closed.length)
      return connect(closed.shift(), query)

    busy.length
      ? go(busy.shift(), query)
      : queries.push(query)
  }

  function go(c, query) {
    return c.execute(query)
      ? move(c, busy)
      : move(c, full)
  }

  function cancel(query) {
    return new Promise((resolve, reject) => {
      query.state
        ? query.active
          ? cancelActive(query, resolve, reject)
          : query.cancelled = { resolve, reject }
        : (
          queries.remove(query),
          query.cancelled = true,
          query.reject(Errors.generic('57014', 'canceling statement due to user request')),
          resolve()
        )
    })
  }

  function cancelActive(query, resolve, reject, delay = 50) {
    Connection(options).cancel(query.state, () => {
      if (!query.active)
        return resolve()
      let waiting = true
      const timer = setTimeout(next, delay)
      Promise.prototype.then.call(query, next, next)
      function next() {
        if (!waiting)
          return
        waiting = false
        clearTimeout(timer)
        query.active
          ? cancelActive(query, resolve, reject, Math.min(delay * 2, 1000))
          : resolve()
      }
    }, reject)
  }

  async function end({ timeout = null } = {}) {
    if (ending)
      return ending

    await 1
    let timer
    return ending = Promise.race([
      new Promise(r => timeout !== null && (timer = setTimeout(destroy, timeout * 1000, r))),
      Promise.all(connections.map(c => c.end()).concat(
        listen.sql ? listen.sql.end({ timeout: 0 }) : [],
        subscribe.sql ? subscribe.sql.end({ timeout: 0 }) : []
      ))
    ]).then(() => clearTimeout(timer))
  }

  async function close() {
    await Promise.all(connections.map(c => c.end()))
  }

  async function destroy(resolve) {
    await Promise.all(connections.map(c => c.terminate()))
    while (queries.length)
      queries.shift().reject(Errors.connection('CONNECTION_DESTROYED', options))
    resolve()
  }

  function connect(c, query) {
    move(c, connecting)
    c.connect(query)
    return c
  }

  function onend(c) {
    move(c, ended)
  }

  function onopen(c, released) {
    if (c.status && c.status !== 73 && (released || options.max !== 1)) // not I
      return poisoned(c)
    if (ending) {
      while (queries.length)
        queries.shift().reject(Errors.connection('CONNECTION_ENDED', options))
      return c.terminate()
    }
    if (queries.length === 0)
      return move(c, open)

    let max = Math.ceil(queries.length / (connecting.length + 1))
      , ready = true

    while (ready && queries.length && max-- > 0) {
      const query = queries.shift()
      if (query.reserve)
        return query.reserve(c)

      ready = c.execute(query)
    }

    ready
      ? move(c, busy)
      : move(c, full)
  }

  function poisoned(c) {
    if (c.queue === ended)
      return
    move(c, ended)
    try {
      options.onpoisoned && options.onpoisoned(String.fromCharCode(c.status))
    } catch (_) {}
    c.terminate()
  }

  function onclose(c, e) {
    move(c, closed)
    const reservation = c.reserved
    c.reserved = null
    reservation && reservation.reject(e)
    c.onclose && (c.onclose(e), c.onclose = null)
    options.onclose && options.onclose(c.id)
    if (ending) {
      while (queries.length)
        queries.shift().reject(Errors.connection('CONNECTION_ENDED', options))
      return
    }
    if (queries.length) {
      const query = queries.peek()
      connect(c, query.reserve ? query : queries.shift())
    }
  }
}

function parseOptions(a, b) {
  if (a && a.shared)
    return a

  const env = process.env // eslint-disable-line
      , o = (!a || typeof a === 'string' ? b : a) || {}
      , { url, multihost } = parseUrl(a)
      , query = [...url.searchParams].reduce((a, [b, c]) => (a[b] = c, a), {})
      , host = o.hostname || o.host || multihost || url.hostname || env.PGHOST || 'localhost'
      , port = o.port || url.port || env.PGPORT || 5432
      , user = o.user || o.username || url.username || env.PGUSERNAME || env.PGUSER || osUsername()

  o.no_prepare && (o.prepare = false)
  query.sslmode && (query.ssl = query.sslmode, delete query.sslmode)
  'timeout' in o && (console.log('The timeout option is deprecated, use idle_timeout instead'), o.idle_timeout = o.timeout) // eslint-disable-line
  query.sslrootcert === 'system' && (query.ssl = 'verify-full')

  const ints = ['idle_timeout', 'connect_timeout', 'max_lifetime', 'max_pipeline', 'backoff', 'keep_alive']
  const defaults = {
    max             : globalThis.Cloudflare ? 3 : 10,
    ssl             : false,
    sslnegotiation  : null,
    idle_timeout    : null,
    connect_timeout : 30,
    max_lifetime    : max_lifetime,
    max_pipeline    : 100,
    backoff         : backoff,
    keep_alive      : 60,
    prepare         : true,
    debug           : false,
    fetch_types     : true,
    publications    : 'alltables',
    target_session_attrs: null
  }

  return {
    host            : Array.isArray(host) ? host : host.split(',').map(x => x.split(':')[0]),
    port            : Array.isArray(port) ? port : host.split(',').map(x => parseInt(x.split(':')[1] || port)),
    path            : o.path || host.indexOf('/') > -1 && host + '/.s.PGSQL.' + port,
    database        : o.database || o.db || (url.pathname || '').slice(1) || env.PGDATABASE || user,
    user            : user,
    pass            : o.pass || o.password || url.password || env.PGPASSWORD || '',
    ...Object.entries(defaults).reduce(
      (acc, [k, d]) => {
        const value = k in o ? o[k] : k in query
          ? (query[k] === 'disable' || query[k] === 'false' ? false : query[k])
          : env['PG' + k.toUpperCase()] || d
        acc[k] = typeof value === 'string' && ints.includes(k)
          ? +value
          : value
        return acc
      },
      {}
    ),
    connection      : {
      application_name: env.PGAPPNAME || 'postgres.js',
      ...o.connection,
      ...Object.entries(query).reduce((acc, [k, v]) => (k in defaults || (acc[k] = v), acc), {})
    },
    types           : o.types || {},
    target_session_attrs: tsa(o, url, env),
    onnotice        : o.onnotice,
    onnotify        : o.onnotify,
    onclose         : o.onclose,
    onpoisoned      : o.onpoisoned,
    shared_types    : o.shared_types === false ? null : o.shared_types instanceof Map ? o.shared_types : new Map(),
    onparameter     : o.onparameter,
    socket          : o.socket,
    transform       : parseTransform(o.transform || { undefined: undefined }),
    parameters      : {},
    shared          : { retries: 0, typeArrayMap: {} },
    ...mergeUserTypes(o.types)
  }
}

function tsa(o, url, env) {
  const x = o.target_session_attrs || url.searchParams.get('target_session_attrs') || env.PGTARGETSESSIONATTRS
  if (!x || ['read-write', 'read-only', 'primary', 'standby', 'prefer-standby'].includes(x))
    return x

  throw new Error('target_session_attrs ' + x + ' is not supported')
}

function backoff(retries) {
  return (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20)
}

function max_lifetime() {
  return 60 * (30 + Math.random() * 30)
}

function parseTransform(x) {
  return {
    undefined: x.undefined,
    column: {
      from: typeof x.column === 'function' ? x.column : x.column && x.column.from,
      to: x.column && x.column.to
    },
    value: {
      from: typeof x.value === 'function' ? x.value : x.value && x.value.from,
      to: x.value && x.value.to
    },
    row: {
      from: typeof x.row === 'function' ? x.row : x.row && x.row.from,
      to: x.row && x.row.to
    }
  }
}

function parseUrl(url) {
  if (!url || typeof url !== 'string')
    return { url: { searchParams: new Map() } }

  let host = url
  host = host.slice(host.indexOf('://') + 3).split(/[?/]/)[0]
  host = decodeURIComponent(host.slice(host.indexOf('@') + 1))

  const urlObj = new URL(url.replace(host, host.split(',')[0]))

  return {
    url: {
      username: decodeURIComponent(urlObj.username),
      password: decodeURIComponent(urlObj.password),
      host: urlObj.host,
      hostname: urlObj.hostname,
      port: urlObj.port,
      pathname: urlObj.pathname,
      searchParams: urlObj.searchParams
    },
    multihost: host.indexOf(',') > -1 && host
  }
}

function osUsername() {
  try {
    return os.userInfo().username // eslint-disable-line
  } catch (_) {
    return process.env.USERNAME || process.env.USER || process.env.LOGNAME  // eslint-disable-line
  }
}
