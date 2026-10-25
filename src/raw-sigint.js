export function onRawSIGINT(fn, { stdin, stdout } = process) {
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', data => {
    const key = data.toString('utf-8');
    if (key === '\u0003') fn();
    else stdout.write(key);
  });
}
