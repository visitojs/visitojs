// An anti-fingerprinting extension, as one looks from the page: two navigator getters replaced by ordinary functions that give
// common values, and the screen getters wrapped in proxies that pass the browser's own answer through.
(function () {
  var common = { hardwareConcurrency: 4, deviceMemory: 8 }
  Object.keys(common).forEach(function (name) {
    try {
      var d = Object.getOwnPropertyDescriptor(Navigator.prototype, name)
      if (!d) return
      Object.defineProperty(Navigator.prototype, name, { configurable: true, enumerable: d.enumerable, get: function () { return common[name] } })
    } catch (e) {}
  })
  ;['width', 'height', 'availWidth', 'availHeight', 'colorDepth'].forEach(function (name) {
    try {
      var d = Object.getOwnPropertyDescriptor(Screen.prototype, name)
      if (!d || !d.get) return
      var get = new Proxy(d.get, { apply: function (real, self, args) { return Reflect.apply(real, self, args) } })
      Object.defineProperty(Screen.prototype, name, { configurable: true, enumerable: d.enumerable, get: get })
    } catch (e) {}
  })
})()
