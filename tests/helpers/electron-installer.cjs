const { writeFileSync } = require('node:fs');

if (process.env.CHANCEKIT_INSTALLER_RESULT) {
  writeFileSync(process.env.CHANCEKIT_INSTALLER_RESULT, JSON.stringify({
    useProxy: process.env.ELECTRON_GET_USE_PROXY,
    httpProxy: process.env.HTTP_PROXY,
    lowerHttpProxy: process.env.http_proxy,
    httpsProxy: process.env.HTTPS_PROXY,
    lowerHttpsProxy: process.env.https_proxy,
    noProxy: process.env.NO_PROXY,
    lowerNoProxy: process.env.no_proxy,
    cache: process.env.electron_config_cache,
  }));
}
if (process.env.CHANCEKIT_INSTALLER_HANG) setInterval(() => {}, 1000);
else process.exit(Number(process.env.CHANCEKIT_INSTALLER_EXIT || 0));
