export const firstBrowserPage = async context =>
  context.pages().length ? context.pages()[0] : await context.newPage();

export const initialBrowserPage = async (context, { width, height }) => {
  const page = await firstBrowserPage(context);
  await page.setViewportSize({ width, height });
  return page;
};

// A restored page may be a manual tab. Use only the fresh startup blank (or a
// new page), and close our page before context shutdown saves the next session.
export const withEpicPage = async (context, { width, height }, run) => {
  const page = context.pages().find(page => page.url() === 'about:blank') || (await context.newPage());
  try {
    await page.setViewportSize({ width, height });
    return await run(page);
  } finally {
    await page.close().catch(() => {
      console.error('Could not close Epic run page; browser lifecycle cleanup will retry context shutdown.');
    });
  }
};

export const logRecordedVideo = async page => {
  if (page.video()) console.log('Recorded video:', await page.video().path());
};
