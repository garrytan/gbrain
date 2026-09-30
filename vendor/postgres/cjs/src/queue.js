module.exports = Queue

function Queue(initial = []) {
  let xs = initial.slice()
  let index = 0

  return {
    get length() {
      return xs.length - index
    },
    remove: (x) => {
      const index = xs.indexOf(x)
      return index === -1
        ? null
        : (xs.splice(index, 1), x)
    },
    push: (x) => (xs.push(x), x),
    peek: () => xs[index],
    shift: () => {
      const out = xs[index++]

      if (index === xs.length) {
        index = 0
        xs = []
      } else {
        xs[index - 1] = undefined
      }

      return out
    }
  }
}
