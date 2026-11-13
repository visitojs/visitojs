// A user-agent switcher, as one looks from the page: the values replaced on the interface and again on the instance.
// lab/marks.mjs replaces the TARGET line for each run; this default is Edge on Windows.
(function () {
  var target = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0', appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0', platform: 'Win32' } // TARGET
  // the names the target gives: some switchers replace all three, simpler ones the user agent alone
  ;Object.keys(target).forEach(function (name) {
    var getter = function () { return target[name] }
    try {
      Object.defineProperty(Navigator.prototype, name, { configurable: true, enumerable: true, get: getter })
      Object.defineProperty(navigator, name, { configurable: true, enumerable: true, get: getter })
    } catch (e) {}
  })
})()
