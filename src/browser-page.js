export const firstBrowserPage = async context =>
  context.pages().length ? context.pages()[0] : await context.newPage();

export const initialBrowserPage = async (context, { width, height }) => {
  const page = await firstBrowserPage(context);
  await page.setViewportSize({ width, height });
  return page;
};

export const logRecordedVideo = async page => {
  if (page.video()) console.log('Recorded video:', await page.video().path());
};
