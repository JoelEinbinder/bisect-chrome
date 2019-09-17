# bisect-chrome

Usage:
- `npx bisect-chrome [--good <revision>] [--bad <revision>] [<script>]`

Parameters:
- `--good`    revision that is known to be GOOD
- `--bad`     revision that is known to be BAD
- `<script>`  path to a Puppeteer script that returns a non-zero code for BAD and 0 for GOOD

Example:
- `npx bisect-chrome --good 577361 --bad 599821 simple.js`

Use https://omahaproxy.appspot.com/ to find revisions.
