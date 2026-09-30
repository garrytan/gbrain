const Stream = require('stream')

module.exports = largeObject;function largeObject(sql, oid, mode = 0x00020000 | 0x00040000) {
  return new Promise(async(resolve, reject) => {
    await sql.begin(async sql => {
      let finish
      !oid && ([{ oid }] = await sql`select lo_creat(-1) as oid`)
      const [{ fd }] = await sql`select lo_open(${ oid }, ${ mode }) as fd`

      const lo = {
        writable,
        readable,
        close     : () => sql`select lo_close(${ fd })`.then(finish),
        tell      : () => sql`select lo_tell64(${ fd })`,
        read      : (x) => sql`select loread(${ fd }, ${ x }) as data`,
        write     : (x) => sql`select lowrite(${ fd }, ${ x })`,
        truncate  : (x) => sql`select lo_truncate64(${ fd }, ${ x })`,
        seek      : (x, whence = 0) => sql`select lo_lseek64(${ fd }, ${ x }, ${ whence })`,
        size      : () => sql`
          select
            lo_lseek64(${ fd }, location, 0) as position,
            seek.size
          from (
            select
              lo_lseek64($1, 0, 2) as size,
              tell.location
            from (select lo_tell64($1) as location) tell
          ) seek
        `
      }

      resolve(lo)

      return new Promise(async r => finish = r)

      async function readable({
        highWaterMark = 2048 * 8,
        start = 0,
        end = Infinity
      } = {}) {
        let max = end - start
        start && await lo.seek(start)
        return new Stream.Readable({
          highWaterMark,
          async read(size) {
            const l = size > max ? size - max : size
            max -= size
            const [{ data }] = await lo.read(l)
            this.push(data)
            if (data.length < size)
              this.push(null)
          }
        })
      }

      async function writable({
        highWaterMark = 2048 * 8,
        start = 0
      } = {}) {
        start && await lo.seek(start)
        return new Stream.Writable({
          highWaterMark,
          write(chunk, encoding, callback) {
            lo.write(chunk).then(() => callback(), callback)
          }
        })
      }
    }).catch(reject)
  })
}
