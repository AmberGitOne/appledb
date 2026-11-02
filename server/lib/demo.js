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

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Welcome@123';

const DEMO_LOGIN = process.env.DEMO_LOGIN !== undefined
  ? String(process.env.DEMO_LOGIN).toLowerCase() === 'true'
  : String(process.env.NODE_ENV).toLowerCase() !== 'production';

module.exports = { DEMO_PASSWORD, DEMO_LOGIN };
