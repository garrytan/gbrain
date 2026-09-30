const size = 256
let buffer = Buffer.allocUnsafe(size)

const messages = 'BCcDdEFfHPpQSX'.split('').reduce((acc, x) => {
  const v = x.charCodeAt(0)
  acc[x] = () => {
    buffer[0] = v
    b.i = 5
    return b
  }
  return acc
}, {})

const b = Object.assign(reset, messages, {
  N: String.fromCharCode(0),
  i: 0,
  inc(x) {
    b.i += x
    return b
  },
  str(x) {
    const length = Buffer.byteLength(x)
    fit(length)
    b.i += buffer.write(x, b.i, length, 'utf8')
    return b
  },
  i16(x) {
    fit(2)
    buffer.writeUInt16BE(x, b.i)
    b.i += 2
    return b
  },
  i32(x, i) {
    if (i || i === 0) {
      buffer.writeUInt32BE(x, i)
      return b
    }
    fit(4)
    buffer.writeUInt32BE(x, b.i)
    b.i += 4
    return b
  },
  z(x) {
    fit(x)
    buffer.fill(0, b.i, b.i + x)
    b.i += x
    return b
  },
  raw(x) {
    buffer = Buffer.concat([buffer.subarray(0, b.i), x])
    b.i = buffer.length
    return b
  },
  end(at = 1) {
    buffer.writeUInt32BE(b.i - at, at)
    const out = buffer.subarray(0, b.i)
    b.i = 0
    buffer = Buffer.allocUnsafe(size)
    return out
  }
})

export default b

function fit(x) {
  if (buffer.length - b.i < x) {
    const prev = buffer
        , length = prev.length

    buffer = Buffer.allocUnsafe(length + (length >> 1) + x)
    prev.copy(buffer)
  }
}

function reset() {
  b.i = 0
  return b
}
