export const macQuitCommand = 'chancekit:quit';

export const macLoader = `const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const data = process.env.CHANCEKIT_QQ_DATA;
if (!data || !process.env.CHANCEKIT_NAPCAT_ENTRY) throw new Error('Launch this runtime from ChanceKit');
fs.mkdirSync(path.join(data, 'Library/Application Support/QQ'), {recursive:true});
os.homedir = () => data;
require('node:module').syncBuiltinESMExports();
require('electron').app.setPath('userData', path.join(data, 'electron'));
// stdin is a private pipe from ChanceKit and is available before OneBot login.
require('node:readline').createInterface({ input: process.stdin }).on('line', command => {
  if (command === ${JSON.stringify(macQuitCommand)}) process.exit(0);
});
import(require('node:url').pathToFileURL(process.env.CHANCEKIT_NAPCAT_ENTRY).href).catch(e => { console.error(e); process.exit(1); });
`;
