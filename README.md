# bisect-chrome

Basic Usage:
- `npx bisect-chrome`

Advanced Usage:
- `npx bisect-chrome [--manual] [--good <revision>] [--bad <revision>] [<script>]`

Parameters:
- `--manual`  manually respond with "good" or "bad" instead of running script
- `--good`    revision that is known to be GOOD. Defaults to the latest revision
- `--bad`     revision that is known to be BAD. Defaults to 305043
- `<script>`  path to a Puppeteer script that returns a non-zero code for BAD and 0 for GOOD.

Example:
- `npx bisect-chrome --good 577361 --bad 599821 simple.js`
- `npx bisect-chrome --manual --good 577361 --bad 599821`

Use https://omahaproxy.appspot.com/ to find revisions.

If a script is specified, launching Puppeteer from within that script will use the current Chromium revision. Revisions older than 493957 won't work with modern Puppeteer.

This script was extracted from Puppeteer's [bisect.js](https://github.com/GoogleChrome/puppeteer/blob/master/utils/bisect.js) and then cleaned up a bit for public use.
