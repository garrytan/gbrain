export class PostgresError extends Error {
  constructor(x) {
    super(x.message)
    this.name = this.constructor.name
    Object.assign(this, x)
  }
}

export const Errors = {
  connection,
  postgres,
  generic,
  notSupported
}

function connection(x, options, socket) {
  const { host, port } = socket || options
  const error = Object.assign(
    new Error(('write ' + x + ' ' + (options.path || (host + ':' + port)))),
    {
      code: x,
      errno: x,
      address: options.path || host
    }, options.path ? {} : { port: port }
  )
  Error.captureStackTrace(error, connection)
  return error
}

function postgres(x) {
  const error = new PostgresError(x)
  Error.captureStackTrace(error, postgres)
  return error
}

function generic(code, message) {
  const error = Object.assign(new Error(code + ': ' + message), { code })
  Error.captureStackTrace(error, generic)
  return error
}

/* c8 ignore next 10 */
function notSupported(x) {
  const error = Object.assign(
    new Error(x + ' (B) is not supported'),
    {
      code: 'MESSAGE_NOT_SUPPORTED',
      name: x
    }
  )
  Error.captureStackTrace(error, notSupported)
  return error
}
