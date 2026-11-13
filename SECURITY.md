# Security Policy

## Supported versions

1.x gets security fixes for 24 months from the release of 1.0.0, and for at least 12 months after 2.0.0, as patches of the latest 1.x minor release. The policy is in [RELEASING.md](RELEASING.md#support-policy).

## Reporting a vulnerability

Please do not open a public issue. Use the "Report a vulnerability" form under the Security tab of the repository. It opens a private advisory that only the maintainers can read.

Include what you found, how to reproduce it, and the browser and version. We aim to answer within seven days.

## What counts

- Code in the library that lets one site read or change another site's stored id.
- A way for the library to throw into the host page, block it, or keep it busy beyond its own limits: 4 seconds of running time after script start, 1 second for a read that waits on the browser, and a callback after 30 seconds at the latest.
- A way to make the build send data anywhere, or run code it did not ship with.
- A user agent or a page state that makes the parser or a read take unbounded time.

## What does not

The library runs in a browser its user controls. A visitor who changes their user agent, clears their storage or edits the values the script reads will get a different reading; that is a limit of every client-side identifier, not a vulnerability. Treat a reading as a signal, and decide on the server.
