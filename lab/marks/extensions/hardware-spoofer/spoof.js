// A hardware and screen spoofer, as one looks from the page: common values for the core count, the memory and the screen, defined
// as getters on the navigator and screen objects themselves.
(function () {
  var define = function (object, values) {
    Object.keys(values).forEach(function (name) {
      try {
        Object.defineProperty(object, name, { configurable: true, enumerable: true, get: function () { return values[name] } })
      } catch (e) {}
    })
  }
  define(navigator, { hardwareConcurrency: 8, deviceMemory: 8 })
  define(screen, { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 })
})()
