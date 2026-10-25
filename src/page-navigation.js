export const sameOrNewPage = async (context, page, url) => {
  const isNew = page.url() != url;
  let p = page;
  if (isNew) {
    p = await context.newPage();
    await p.goto(url, { waitUntil: 'domcontentloaded' });
  }
  return [p, isNew];
};

export const waitUntilStable = async (read, act) => {
  let previous;
  for (;;) {
    const current = await read();
    console.log('waitUntilStable', current);
    if (previous == current) return;
    previous = current;
    await act();
  }
};
