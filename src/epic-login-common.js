export const epicConsentCookie = (now = Date.now()) => ({
  name: 'OptanonAlertBoxClosed',
  value: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
  domain: '.epicgames.com',
  path: '/',
});

export const prepareLogin = (context, cfg, logger = console) => {
  logger.error('Not signed in anymore. Please login in the browser or here in the terminal.');
  if (cfg.novnc_port) logger.info(`Open http://localhost:${cfg.novnc_port} to login inside the docker container.`);
  if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
  logger.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
};

export const watchEpicMfa = (page, cfg, generate, prompt) =>
  page
    .waitForURL('**/id/login/mfa**')
    .then(() => submitEpicMfa(page, cfg, generate, prompt))
    .catch(() => {});

export const submitEpicMfa = async (page, cfg, generate, prompt, logger = console) => {
  logger.log(
    'Enter the security code to continue - This appears to be a new device, browser or location. A security code has been sent to your email address at ...',
  );
  const otp =
    (cfg.eg_otpkey && generate(cfg.eg_otpkey)) ||
    (await prompt({
      type: 'text',
      message: 'Enter two-factor sign in code',
      validate: n => n.toString().length == 6 || 'The code must be 6 digits!',
    }));
  await page.locator('input[name="code-input-0"]').pressSequentially(otp.toString());
  await page.click('button[type="submit"]');
};
