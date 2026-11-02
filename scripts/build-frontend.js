'use strict';
/**
 * Turns the single-file prototype into the served front end.
 *
 *   node scripts/build-frontend.js [path/to/AppleGlobalcare-CRM.html]
 *
 * It splits the file into web/index.html + web/app.css + web/app.js +
 * web/boot.js, then rewrites the three places that talked to localStorage so
 * they talk to the API instead. Everything else is copied through untouched,
 * so the UI is byte-for-byte the prototype.
 *
 * Re-runnable: point it at an updated prototype and the patches re-apply.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

const SOURCE = process.argv[2] || path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  'Downloads', 'AppleGlobalcare-CRM.html'
);

function fail(msg) {
  console.error('build-frontend: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(SOURCE)) fail(`source not found: ${SOURCE}`);

const html = fs.readFileSync(SOURCE, 'utf8');

// ---------------------------------------------------------------------
// 1. carve out <style> and the two <script> blocks
// ---------------------------------------------------------------------

function carve(tag, from) {
  const open = html.indexOf(`<${tag}>`, from);
  if (open < 0) return null;
  const bodyStart = open + tag.length + 2;
  const close = html.indexOf(`</${tag}>`, bodyStart);
  if (close < 0) fail(`unterminated <${tag}>`);
  return { open, close, end: close + tag.length + 3, body: html.slice(bodyStart, close) };
}

const style = carve('style', 0);
if (!style) fail('no <style> block found');

const script1 = carve('script', style.end);
if (!script1) fail('no <script> block found');

const script2 = carve('script', script1.end);
if (!script2) fail('expected a second <script> block');

console.log(`  style   ${style.body.length.toLocaleString()} chars`);
console.log(`  script1 ${script1.body.length.toLocaleString()} chars`);
console.log(`  script2 ${script2.body.length.toLocaleString()} chars`);

// ---------------------------------------------------------------------
// 2. patch the persistence layer in script 1
// ---------------------------------------------------------------------

let app = script1.body;
const applied = [];

function patch(name, find, replace) {
  if (typeof find === 'string') {
    if (!app.includes(find)) fail(`patch "${name}" did not match - the source has changed`);
    app = app.replace(find, replace);
  } else {
    if (!find.test(app)) fail(`patch "${name}" did not match - the source has changed`);
    app = app.replace(find, replace);
  }
  applied.push(name);
}

// 2a. load() / save() -> the API client
patch('load/save -> API',
  'function load(){ try{ var r = localStorage.getItem(KEY); if(r) return JSON.parse(r); }catch(e){} return JSON.parse(JSON.stringify(SEED)); }\n' +
  'function save(){ try{ localStorage.setItem(KEY, JSON.stringify(S)); }catch(e){} }',
  [
    '/* Persistence runs through the API (web/api.js), not localStorage.',
    '   window.CRM.state is fetched once at boot; save() debounces a PUT. */',
    'function load(){',
    '  if (window.CRM && window.CRM.state) return window.CRM.state;',
    '  /* only reached if the API client is missing: keep the UI usable */',
    '  console.warn("[CRM] API client unavailable - falling back to the bundled seed");',
    '  return JSON.parse(JSON.stringify(SEED));',
    '}',
    'function save(){',
    '  if (window.CRM) window.CRM.save(S);',
    '}'
  ].join('\n'));

// 2b. "Reset demo data" -> re-seed server side
patch('reset demo data',
  /if\(\(el = e\.target\.closest\("#reset-demo"\)\)\)\{[^\n]*?return; \}/,
  'if((el = e.target.closest("#reset-demo"))){\n' +
  '      if(window.CRM){\n' +
  '        window.CRM.reset().then(function(fresh){\n' +
  '          S = fresh; SEL = {}; FOLDER = "inbox";\n' +
  '          renderLabels(); renderList(); renderDetail(); renderComposer(); renderNotes();\n' +
  '          renderAdmin(); renderMyLeave(); renderLeaveMgmt(); renderHolidays();\n' +
  '          renderSuppliers(); renderEmployees(); renderRx(); renderQA(); renderOrders();\n' +
  '          renderQuote(); renderSourcing(); renderCase(); renderWarehouse(); renderColdChain();\n' +
  '          toast("Demo data reset");\n' +
  '        });\n' +
  '      }\n' +
  '      return; }');

// ---------------------------------------------------------------------
// 3. patch script 2 so the app boots only once the state has arrived
// ---------------------------------------------------------------------

let boot = script2.body;

function patchBoot(name, find, replace) {
  if (!boot.includes(find)) fail(`boot patch "${name}" did not match - the source has changed`);
  boot = boot.replace(find, replace);
  applied.push(name);
}

patchBoot('defer __crmInit',
  'if (window.__crmInit) window.__crmInit(show);',
  'if (window.__crmInit) {\n' +
  '    if (window.CRM) window.CRM.ready(function(){ window.__crmInit(show); });\n' +
  '    else window.__crmInit(show);\n' +
  '  }');

patchBoot('defer applyRole',
  '  applyRole(startRole, false);',
  '  if (window.CRM) window.CRM.ready(function(){ applyRole(startRole, false); });\n' +
  '  else applyRole(startRole, false);');

// ---------------------------------------------------------------------
// 4. rebuild index.html with external assets
// ---------------------------------------------------------------------

const head = html.slice(0, style.open);
const between = html.slice(style.end, script1.open);
const tail = html.slice(script2.end);

const indexHtml =
  head +
  '<link rel="stylesheet" href="app.css">' +
  // mobile.css is hand-maintained and must load after app.css so its
  // overrides win on narrow screens without needing !important
  '<link rel="stylesheet" href="mobile.css">' +
  between +
  // api.js first: it starts the fetch and defines window.CRM
  '<script src="api.js"></script>\n' +
  '<script src="app.js"></script>\n' +
  '<script src="boot.js"></script>\n' +
  '<script src="mobile.js"></script>' +
  tail;

fs.mkdirSync(WEB, { recursive: true });
fs.writeFileSync(path.join(WEB, 'app.css'), style.body.trim() + '\n');
fs.writeFileSync(path.join(WEB, 'app.js'), app.trim() + '\n');
fs.writeFileSync(path.join(WEB, 'boot.js'), boot.trim() + '\n');
fs.writeFileSync(path.join(WEB, 'index.html'), indexHtml);

// ---------------------------------------------------------------------
// 5. report
// ---------------------------------------------------------------------

const size = (f) => (fs.statSync(path.join(WEB, f)).size / 1024).toFixed(0) + ' KB';

console.log('\n  patches applied:');
for (const p of applied) console.log('    - ' + p);

console.log('\n  written to web/:');
for (const f of ['index.html', 'app.css', 'app.js', 'boot.js']) {
  console.log(`    ${f.padEnd(12)} ${size(f)}`);
}

// Hand-maintained files this build only links to - warn loudly if one has
// gone missing, otherwise the page silently loses its mobile layout.
console.log('\n  hand-maintained (not generated):');
for (const f of ['api.js', 'mobile.css', 'mobile.js']) {
  if (fs.existsSync(path.join(WEB, f))) {
    console.log(`    ${f.padEnd(12)} ${size(f)}`);
  } else {
    fail(`${f} is missing from web/ but index.html references it`);
  }
}

const leftover = (app + boot).match(/localStorage\.(get|set|remove)Item\(\s*KEY/g);
if (leftover) fail(`still ${leftover.length} localStorage call(s) on the state key`);
console.log('\n  no localStorage calls remain on the app state key');
console.log('  (localStorage is still used for UI preferences: theme, screen, role)');
