module.exports = class Result extends Array {
  constructor() {
    super()
    Object.defineProperties(this, {
      count: { value: null, writable: true },
      state: { value: null, writable: true },
      command: { value: null, writable: true },
      columns: { value: null, writable: true },
      statement: { value: null, writable: true }
    })
  }

  static get [Symbol.species]() {
    return Array
  }
}
