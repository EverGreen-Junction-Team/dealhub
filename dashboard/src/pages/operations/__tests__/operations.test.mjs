// Operations Hub slice 1 (docs/operations-hub-plan.md): the wiring that
// keeps it hidden, switches the menu, and leaves the client's open questions
// to the server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const shell = read('../../DealHubShell.jsx')
const home = read('../../tabs/HomeTab.jsx')
const tab = read('../../tabs/OperationsTab.jsx')
const views = read('../OpsViews.jsx')
const job = read('../JobPage.jsx')
const api = read('../../../api/operations.js')
const decisions = read('../opsDecisions.js')

const control = read('../../tabs/ControlCentreTab.jsx')
const section = read('../../control/OperationsSection.jsx')

test('TWO switches: the build flag AND this sub-account\'s switch', () => {
  assert.match(shell, /const OPERATIONS_ENABLED = import\.meta\.env\.VITE_FEATURE_OPERATIONS === 'true'/)
  assert.match(shell, /const opsOn = OPERATIONS_ENABLED && opsEnabled === true/)
  // Not asked at all when the build does not have the feature.
  assert.match(shell, /useState\(OPERATIONS_ENABLED \? null : false\)/)
  assert.match(shell, /if \(!OPERATIONS_ENABLED\) return undefined/)
  assert.match(shell, /opsOn && OPS_IDS\.has\(activeTab\) && \(\s*<OperationsTab/)
  assert.match(shell, /operationsOn=\{opsOn\}/)
  assert.match(home, /const groupsFor = \(operationsOn\) => GROUPS\.filter\(\(g\) => !g\.operations \|\| operationsOn\)/)
  assert.ok(!/VITE_FEATURE_OPERATIONS/.test(home), 'Home takes the combined answer from the shell')
})

test('an operations screen in a sub-account without it goes Home, once known', () => {
  assert.match(shell, /if \(opsEnabled === false && OPS_IDS\.has\(activeTab\)\) setActiveTab\('home'\)/)
})

test('the Control panel switch: only in builds with the feature, and the menu follows at once', () => {
  assert.match(control, /\{OPERATIONS_ENABLED && <OperationsSection \/>\}/)
  assert.match(section, /await opsAPI\.setEnabled\(next\)/)
  assert.match(section, /window\.dispatchEvent\(new CustomEvent\(OPS_ENABLED_EVENT, \{ detail: r\.enabled \}\)\)/)
  assert.match(shell, /window\.addEventListener\(OPS_ENABLED_EVENT, onChange\)/)
  // From the API module, not the shell — the shell imports the Control panel.
  assert.ok(!/from '\.\.\/DealHubShell'/.test(section))
})

test('two menus: an Operations hub pill on the sales menu, the ops items on ops screens', () => {
  assert.match(shell, /\(opsOn && OPS_IDS\.has\(activeTab\) \? OPS_MENU : \(opsOn \? SALES_MENU_WITH_OPS : VISIBLE_TABS\)\)\.map/)
  assert.match(shell, /\{ id: 'opsPipeline', label: 'Operations hub', icon: 'engineering' \}/)
  // Deal hub stays on the ops menu, to switch back.
  assert.match(shell, /const OPS_MENU = \[\s*\.\.\.TABS\.filter\(\(t\) => t\.id === 'home' \|\| t\.id === 'hub'\)/)
  // Keyboard shortcuts keep the sales menu they always had.
  assert.match(shell, /const tab = VISIBLE_TABS\[Number\(e\.key\) - 1\]/)
})

test('no "Start project" button while the client has not decided (Q1)', () => {
  for (const src of [tab, views, job]) assert.ok(!/Start project/.test(src))
  assert.ok(!/projects\/start/.test(api), 'the dashboard must not call the pending route')
})

test('the decisions come from the server; the dashboard only words them', () => {
  assert.match(api, /decisions: \(\) => apiClient\.get\('\/api\/ops\/decisions'\)/)
  assert.match(decisions, /export function pendingLines\(decisions\)/)
  for (const q of ['Q1', 'Q2', 'Q4']) assert.match(decisions, new RegExp(`${q}: '`))
  assert.ok(!/START_PROJECT|JOB_NUMBER_SOURCE|TASK_LINK_STORE/.test(tab + views + job))
})

test('job numbers are only typed when the server says they are editable (Q2)', () => {
  assert.match(job, /jobNumberEditable\s*\n?\s*\? <Input value=\{draft\.jobNumber\}/)
  assert.match(job, /if \(kind === 'project' && !jobNumberEditable\) delete patch\.jobNumber/)
})

test('moving a stage asks first, because it changes the CRM', () => {
  assert.match(job, /This changes the stage in your CRM\./)
  assert.match(job, /await opsAPI\.moveStage\(kind, id, pending\.key\)/)
})

test('choosing pipelines says it changes nothing in the CRM', () => {
  assert.match(views, /nothing changes in your CRM/)
  assert.match(views, /Deal Hub never creates one without asking/)
})

test('time defaults to the signed-in person', () => {
  assert.match(job, /useState\(\(\) => blankEntry\(meId\)\)/)
  assert.match(tab, /meId=\{meId\}/)
})
