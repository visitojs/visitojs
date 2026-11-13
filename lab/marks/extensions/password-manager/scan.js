// A password manager's content script, in the isolated world: it looks for password fields at document start, when the document
// is parsed and whenever it changes, listens for focus, and marks the root element with what it found, as such tools mark what they scanned.
(function () {
  var fields = 0
  var scan = function () {
    fields = document.querySelectorAll('input[type="password"]').length
    if (document.documentElement) document.documentElement.setAttribute('data-test-password-manager', String(fields))
  }
  // a first look at document start, so the mark is there whenever the page's own scripts look for it
  scan()
  document.addEventListener('DOMContentLoaded', function () {
    scan()
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true })
  })
  document.addEventListener('focusin', function (e) {
    if (e.target && e.target.type === 'password') scan()
  }, true)
})()
