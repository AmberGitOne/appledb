'use strict';
/**
 * Demo-build settings.
 *
 * Every seeded account shares one password so the dataset can be explored
 * from the sign-in page without handing out six separate credentials. That
 * is only acceptable while this is a demo, so the sign-in page is told about
 * it solely when DEMO_LOGIN is on.
 *
 * DEMO_LOGIN defaults to off under NODE_ENV=production, and render.yaml also
 * sets it to "false" outright - two independent guards, because getting this
 * wrong publishes a working password on a public page. Turning it off leaves
 * the ordinary email + password form, which is the only code path that ever
 * authenticates anyone; the picker just fills the fields in.
 */

const DEFAULT_PASSWORD = 'Welcome@123';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || DEFAULT_PASSWORD;
const PASSWORD_IS_PUBLIC = DEMO_PASSWORD === DEFAULT_PASSWORD;

const DEMO_LOGIN = process.env.DEMO_LOGIN !== undefined
  ? String(process.env.DEMO_LOGIN).toLowerCase() === 'true'
  : String(process.env.NODE_ENV).toLowerCase() !== 'production';

/**
 * Refuse to seed a production database with the password that is in the
 * repository.
 *
 * Turning DEMO_LOGIN off stops the sign-in page from *printing* the shared
 * password, but the accounts still have it, and anyone who can read this
 * file can read it too. On a public URL that is an open system wearing a
 * login form. One environment variable fixes it, so the deploy says so
 * rather than coming up quietly insecure.
 *
 * It has to be checked before seeding, because seeding is what bakes the
 * hash in - setting DEMO_PASSWORD afterwards changes nothing.
 */
function assertSeedPasswordIsSafe() {
  const isProduction = String(process.env.NODE_ENV).toLowerCase() === 'production';
  if (!isProduction || !PASSWORD_IS_PUBLIC) return;
  throw new Error(
    'Refusing to seed a production database with the demo password, which ' +
    'is public in this repository. Set DEMO_PASSWORD to something of your ' +
    'own in the environment, then deploy again. (It must be set before the ' +
    'first request, because that is what creates the accounts.)'
  );
}

module.exports = {
  DEMO_PASSWORD,
  DEMO_LOGIN,
  PASSWORD_IS_PUBLIC,
  assertSeedPasswordIsSafe,
};
