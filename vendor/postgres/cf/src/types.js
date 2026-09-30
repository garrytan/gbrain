import { Buffer } from 'node:buffer'
import { Query } from './query.js'
import { Errors } from './errors.js'

export const types = {
  string: {
    to: 25,
    from: null,             // defaults to string
    serialize: x => '' + x
  },
  number: {
    to: 0,
    from: [21, 23, 26, 700, 701],
    serialize: x => '' + x,
    parse: x => +x
  },
  json: {
    to: 114,
    from: [114, 3802],
    serialize: x => JSON.stringify(x),
    parse: x => JSON.parse(x)
  },
  boolean: {
    to: 16,
    from: 16,
    serialize: x => x === true ? 't' : 'f',
    parse: x => x === 't'
  },
  date: {
    to: 1184,
    from: [1082, 1114, 1184],
    serialize: x => (x instanceof Date ? x : new Date(x)).toISOString(),
    parse: x => new Date(x)
  },
  bytea: {
    to: 17,
    from: 17,
    serialize: x => '\\x' + Buffer.from(x).toString('hex'),
    parse: x => Buffer.from(x.slice(2), 'hex')
  }
}

class NotTagged { then() { notTagged() } catch() { notTagged() } finally() { notTagged() }}

export class Identifier extends NotTagged {
  constructor(value) {
    super()
    this.value = escapeIdentifier(value)
  }
}

export class Parameter extends NotTagged {
  constructor(value, type, array) {
    super()
    this.value = value
    this.type = type
    this.array = array
  }
}

export class Builder extends NotTagged {
  constructor(first, rest) {
    super()
    this.first = first
    this.rest = rest
  }

  build(before, parameters, types, options) {
    const keyword = builders.map(([x, fn]) => ({ fn, i: before.search(x) })).sort((a, b) => a.i - b.i).pop()
    return keyword.i === -1
      ? escapeIdentifiers(this.first, options)
      : keyword.fn(this.first, this.rest, parameters, types, options)
  }
}

export function handleValue(x, parameters, types, options) {
  let value = x instanceof Parameter ? x.value : x
  if (value === undefined) {
    x instanceof Parameter
      ? x.value = options.transform.undefined
      : value = x = options.transform.undefined

    if (value === undefined)
      throw Errors.generic('UNDEFINED_VALUE', 'Undefined values are not allowed')
  }

  return '$' + (types.push(
    x instanceof Parameter
      ? (parameters.push(x.value), x.array
        ? x.array[x.type || inferType(x.value)] || x.type || firstIsString(x.value)
        : x.type
      )
      : (parameters.push(x), inferType(x))
  ))
}

const defaultHandlers = typeHandlers(types)

export function stringify(q, string, value, parameters, types, options) { // eslint-disable-line
  for (let i = 1; i < q.strings.length; i++) {
    string += (stringifyValue(string, value, parameters, types, options)) + q.strings[i]
    value = q.args[i]
  }

  return string
}

function stringifyValue(string, value, parameters, types, o) {
  return (
    value instanceof Builder ? value.build(string, parameters, types, o) :
    value instanceof Query ? fragment(value, parameters, types, o) :
    value instanceof Identifier ? value.value :
    value && value[0] instanceof Query ? value.reduce((acc, x) => acc + ' ' + fragment(x, parameters, types, o), '') :
    handleValue(value, parameters, types, o)
  )
}

function fragment(q, parameters, types, options) {
  q.fragment = true
  return stringify(q, q.strings[0], q.args[0], parameters, types, options)
}

function valuesBuilder(first, parameters, types, columns, options) {
  return first.map(row =>
    '(' + columns.map(column =>
      stringifyValue('values', row[column], parameters, types, options)
    ).join(',') + ')'
  ).join(',')
}

function values(first, rest, parameters, types, options) {
  const multi = Array.isArray(first[0])
  const columns = rest.length ? rest.flat() : Object.keys(multi ? first[0] : first)
  return valuesBuilder(multi ? first : [first], parameters, types, columns, options)
}

function select(first, rest, parameters, types, options) {
  typeof first === 'string' && (first = [first].concat(rest))
  if (Array.isArray(first))
    return escapeIdentifiers(first, options)

  let value
  const columns = rest.length ? rest.flat() : Object.keys(first)
  return columns.map(x => {
    value = first[x]
    return (
      value instanceof Query ? fragment(value, parameters, types, options) :
      value instanceof Identifier ? value.value :
      handleValue(value, parameters, types, options)
    ) + ' as ' + escapeIdentifier(options.transform.column.to ? options.transform.column.to(x) : x)
  }).join(',')
}

const builders = Object.entries({
  values,
  in: (...xs) => {
    const x = values(...xs)
    return x === '()' ? '(null)' : x
  },
  select,
  as: select,
  returning: select,
  '\\(': select,

  update(first, rest, parameters, types, options) {
    return (rest.length ? rest.flat() : Object.keys(first)).map(x =>
      escapeIdentifier(options.transform.column.to ? options.transform.column.to(x) : x) +
      '=' + stringifyValue('values', first[x], parameters, types, options)
    )
  },

  insert(first, rest, parameters, types, options) {
    const columns = rest.length ? rest.flat() : Object.keys(Array.isArray(first) ? first[0] : first)
    return '(' + escapeIdentifiers(columns, options) + ')values' +
    valuesBuilder(Array.isArray(first) ? first : [first], parameters, types, columns, options)
  }
}).map(([x, fn]) => ([new RegExp('((?:^|[\\s(])' + x + '(?:$|[\\s(]))(?![\\s\\S]*\\1)', 'i'), fn]))

function notTagged() {
  throw Errors.generic('NOT_TAGGED_CALL', 'Query not called as a tagged template literal')
}

export const serializers = defaultHandlers.serializers
export const parsers = defaultHandlers.parsers

export const END = {}

function firstIsString(x) {
  if (Array.isArray(x))
    return firstIsString(x[0])
  return typeof x === 'string' ? 1009 : 0
}

export const mergeUserTypes = function(types) {
  const user = typeHandlers(types || {})
  return {
    serializers: Object.assign({}, serializers, user.serializers),
    parsers: Object.assign({}, parsers, user.parsers)
  }
}

function typeHandlers(types) {
  return Object.keys(types).reduce((acc, k) => {
    types[k].from && [].concat(types[k].from).forEach(x => acc.parsers[x] = types[k].parse)
    if (types[k].serialize) {
      acc.serializers[types[k].to] = types[k].serialize
      types[k].from && [].concat(types[k].from).forEach(x => acc.serializers[x] = types[k].serialize)
    }
    return acc
  }, { parsers: {}, serializers: {} })
}

function escapeIdentifiers(xs, { transform: { column } }) {
  return xs.map(x => escapeIdentifier(column.to ? column.to(x) : x)).join(',')
}

export const escapeIdentifier = function escape(str) {
  return '"' + str.replace(/"/g, '""').replace(/\./g, '"."') + '"'
}

export const inferType = function inferType(x) {
  return (
    x instanceof Parameter ? x.type :
    x instanceof Date ? 1184 :
    x instanceof Uint8Array ? 17 :
    (x === true || x === false) ? 16 :
    typeof x === 'bigint' ? 20 :
    Array.isArray(x) ? inferType(x[0]) :
    0
  )
}

const escapeBackslash = /\\/g
const escapeQuote = /"/g

function arrayEscape(x) {
  return x
    .replace(escapeBackslash, '\\\\')
    .replace(escapeQuote, '\\"')
}

export const arraySerializer = function arraySerializer(xs, serializer, options, typarray) {
  if (Array.isArray(xs) === false)
    return xs

  if (!xs.length)
    return '{}'

  const first = xs[0]
  // Only _box (1020) has the ';' delimiter for arrays, all other types use the ',' delimiter
  const delimiter = typarray === 1020 ? ';' : ','

  if (Array.isArray(first) && !first.type)
    return '{' + xs.map(x => arraySerializer(x, serializer, options, typarray)).join(delimiter) + '}'

  return '{' + xs.map(x => {
    if (x === undefined) {
      x = options.transform.undefined
      if (x === undefined)
        throw Errors.generic('UNDEFINED_VALUE', 'Undefined values are not allowed')
    }

    return x === null
      ? 'null'
      : '"' + arrayEscape(serializer ? serializer(x.type ? x.value : x) : '' + x) + '"'
  }).join(delimiter) + '}'
}

const arrayParserState = {
  i: 0,
  char: null,
  str: '',
  quoted: false,
  last: 0
}

export const arrayParser = function arrayParser(x, parser, typarray) {
  arrayParserState.i = arrayParserState.last = 0
  return arrayParserLoop(arrayParserState, x, parser, typarray)
}

function arrayParserLoop(s, x, parser, typarray) {
  const xs = []
  // Only _box (1020) has the ';' delimiter for arrays, all other types use the ',' delimiter
  const delimiter = typarray === 1020 ? ';' : ','
  for (; s.i < x.length; s.i++) {
    s.char = x[s.i]
    if (s.quoted) {
      if (s.char === '\\') {
        s.str += x[++s.i]
      } else if (s.char === '"') {
        xs.push(parser ? parser(s.str) : s.str)
        s.str = ''
        s.quoted = x[s.i + 1] === '"'
        s.last = s.i + 2
      } else {
        s.str += s.char
      }
    } else if (s.char === '"') {
      s.quoted = true
    } else if (s.char === '{') {
      s.last = ++s.i
      xs.push(arrayParserLoop(s, x, parser, typarray))
    } else if (s.char === '}') {
      s.quoted = false
      s.last < s.i && xs.push(parser ? parser(x.slice(s.last, s.i)) : x.slice(s.last, s.i))
      s.last = s.i + 1
      break
    } else if (s.char === delimiter && s.p !== '}' && s.p !== '"') {
      xs.push(parser ? parser(x.slice(s.last, s.i)) : x.slice(s.last, s.i))
      s.last = s.i + 1
    }
    s.p = s.char
  }
  s.last < s.i && xs.push(parser ? parser(x.slice(s.last, s.i + 1)) : x.slice(s.last, s.i + 1))
  return xs
}

export const toCamel = x => {
  let str = x[0]
  for (let i = 1; i < x.length; i++)
    str += x[i] === '_' ? x[++i].toUpperCase() : x[i]
  return str
}

export const toPascal = x => {
  let str = x[0].toUpperCase()
  for (let i = 1; i < x.length; i++)
    str += x[i] === '_' ? x[++i].toUpperCase() : x[i]
  return str
}

export const toKebab = x => x.replace(/_/g, '-')

export const fromCamel = x => x.replace(/([A-Z])/g, '_$1').toLowerCase()
export const fromPascal = x => (x.slice(0, 1) + x.slice(1).replace(/([A-Z])/g, '_$1')).toLowerCase()
export const fromKebab = x => x.replace(/-/g, '_')

function createJsonTransform(fn) {
  return function jsonTransform(x, column) {
    return typeof x === 'object' && x !== null && (column.type === 114 || column.type === 3802)
      ? Array.isArray(x)
        ? x.map(x => jsonTransform(x, column))
        : Object.entries(x).reduce((acc, [k, v]) => Object.assign(acc, { [fn(k)]: jsonTransform(v, column) }), {})
      : x
  }
}

toCamel.column = { from: toCamel }
toCamel.value = { from: createJsonTransform(toCamel) }
fromCamel.column = { to: fromCamel }

export const camel = { ...toCamel }
camel.column.to = fromCamel

toPascal.column = { from: toPascal }
toPascal.value = { from: createJsonTransform(toPascal) }
fromPascal.column = { to: fromPascal }

export const pascal = { ...toPascal }
pascal.column.to = fromPascal

toKebab.column = { from: toKebab }
toKebab.value = { from: createJsonTransform(toKebab) }
fromKebab.column = { to: fromKebab }

export const kebab = { ...toKebab }
kebab.column.to = fromKebab
