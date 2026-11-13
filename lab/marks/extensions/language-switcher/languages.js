// A language switcher, as one looks from the page: the languages the person picked, defined as getters on the navigator object
// itself, so every script in the page reads them in place of the browser's own list.
(function () {
  var languages = ['de-DE', 'de', 'en-US', 'en']
  var values = { language: languages[0], languages: languages }
  Object.keys(values).forEach(function (name) {
    try {
      Object.defineProperty(navigator, name, { configurable: true, enumerable: true, get: function () { return values[name] } })
    } catch (e) {}
  })
})()
