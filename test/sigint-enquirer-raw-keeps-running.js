// open issue: prevents handleSIGINT() to work if prompt is cancelled with Ctrl-C instead of Escape: https://github.com/enquirer/enquirer/issues/372
import { onRawSIGINT } from '../src/raw-sigint.js';
console.log(1);
onRawSIGINT(() => {
  console.log('raw');
  process.exit(1);
});
console.log(2);

// onRawSIGINT workaround for enquirer keeps the process from exiting here...
