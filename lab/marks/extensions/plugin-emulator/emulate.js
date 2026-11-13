// A plug-in emulator, as one looks from the page: its own lists, holding the browser's entries and then its own, defined on
// navigator itself, and its own constructors in place of the window's PluginArray and MimeTypeArray.
(function () {
  try {
    var native = navigator.plugins
    var nativeTypes = navigator.mimeTypes
    var PluginArray = function PluginArray() {}
    var MimeTypeArray = function MimeTypeArray() {}
    var type = { type: 'application/x-emulated-plugin', suffixes: 'emu', description: 'Emulated plug-in' }
    var plugin = { name: 'Emulated Plug-in', filename: 'emulated.js', description: 'Emulated plug-in 1.0', length: 1, 0: type }
    type.enabledPlugin = plugin
    var fill = function (list, from, own) {
      var n = 0
      for (; n < from.length; n++) list[n] = from[n]
      list[n] = own
      list.length = n + 1
      list.item = function (i) { return this[i] || null }
      list.namedItem = function (name) { for (var i = 0; i < this.length; i++) if (this[i].name === name || this[i].type === name) return this[i]; return null }
      return list
    }
    var plugins = fill(Object.create(PluginArray.prototype), native, plugin)
    plugins.refresh = function () {}
    var types = fill(Object.create(MimeTypeArray.prototype), nativeTypes, type)
    Object.defineProperty(navigator, 'plugins', { configurable: true, enumerable: true, value: plugins })
    Object.defineProperty(navigator, 'mimeTypes', { configurable: true, enumerable: true, value: types })
    Object.defineProperty(window, 'PluginArray', { configurable: true, writable: true, value: PluginArray })
    Object.defineProperty(window, 'MimeTypeArray', { configurable: true, writable: true, value: MimeTypeArray })
  } catch (e) {}
})()
