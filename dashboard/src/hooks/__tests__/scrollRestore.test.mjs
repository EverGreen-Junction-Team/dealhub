// Restoring a scroll position onto a page that has not loaded yet.
//
// THE BUG THIS EXISTS FOR. The first version of the restore loop gave up as
// soon as the saved offset looked unreachable:
//
//     const reached = Math.abs(window.scrollY - target) < 2 || max <= target
//
// At mount the page is empty — the fetch has not landed — so the furthest
// you can scroll is 0, and every target is "unreachable". It decided the
// page was too short on its FIRST FRAME and stopped, every single time. The
// symptom was a scroll position that never came back, which reads exactly
// like one that was never saved, so the whole diagnosis started in the wrong
// place.
//
// The rule now is that "too short" means nothing until the page has stopped
// changing size. These are the cases that separates.
import assert from 'node:assert/strict'
import { restoreStep } from '../useScrollMemory.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name) }

// Walk a restore frame by frame against a page whose height is a function of
// the frame number — which is what a loading list actually is.
function run({ target, heightAt, frames = 400, msPerFrame = 16 }) {
  let current = 0
  for (let f = 0; f < frames; f++) {
    const max = heightAt(f)
    current = Math.min(target, max)
    const v = restoreStep({ current, target, elapsedMs: f * msPerFrame })
    if (v.done) return { frames: f + 1, landedAt: current }
  }
  return { frames, landedAt: current, ranOut: true }
}

console.log('the empty page at mount')

t('an empty page does not end the restore on frame one', () => {
  // THE REGRESSION. With the old rule this returned after 1 frame at 0.
  const r = run({ target: 800, heightAt: (f) => (f < 30 ? 0 : 2000) })
  assert.ok(r.frames > 1, 'gave up before the content arrived')
  assert.equal(r.landedAt, 800)
})

t('it waits through a slow fetch', () => {
  // 100 frames is about 1.6 seconds — a real list on a real connection.
  const r = run({ target: 1200, heightAt: (f) => (f < 100 ? 0 : 5000) })
  assert.equal(r.landedAt, 1200)
})

t('it survives the page growing in stages', () => {
  // A list that renders a skeleton, then a first page, then more. The height
  // changes several times, and each change resets the steadiness count.
  const r = run({
    target: 900,
    heightAt: (f) => (f < 10 ? 0 : f < 25 ? 300 : f < 40 ? 700 : 3000)
  })
  assert.equal(r.landedAt, 900)
})

console.log('pages that genuinely cannot reach it')

t('a permanently shorter page parks at the bottom and lets go', () => {
  // The filter was narrowed while away, so the list is now 400px and the
  // saved 800 no longer exists. The closest we can get is the bottom, and
  // the clock releases it — there is no way to tell this apart from a page
  // still loading, so it is not worth guessing.
  const r = run({ target: 800, heightAt: () => 400 })
  assert.equal(r.landedAt, 400)
  assert.ok(!r.ranOut, 'the time limit did not stop it')
})

t('a page that never loads waits for the clock, not the steadiness rule', () => {
  // Deliberately NOT quick. A height of 0 held for ten frames is what a
  // slow fetch looks like, so zero must never count as settled — otherwise
  // the restore abandons exactly the case it exists for. Nothing is on
  // screen to disturb, so waiting costs nothing.
  const r = run({ target: 500, heightAt: () => 0, frames: 400 })
  assert.ok(!r.ranOut, 'the time limit did not stop it')
  assert.ok(r.frames * 16 >= 3000, 'gave up before the window elapsed')
})

t('the time limit stops a page that keeps growing for ever', () => {
  // An infinite-scroll list that keeps appending would otherwise retry
  // without end — the height never holds still, so the steadiness rule never
  // fires. The clock is the backstop.
  const r = run({ target: 10 ** 9, heightAt: (f) => f * 10 })
  assert.ok(!r.ranOut, 'the time limit did not stop it')
  assert.ok(r.frames * 16 >= 3000)
})

console.log('arriving')

t('it stops the moment it lands', () => {
  const r = run({ target: 300, heightAt: () => 5000 })
  assert.equal(r.frames, 1)
  assert.equal(r.landedAt, 300)
})

t('landing within a pixel or two counts as landed', () => {
  // Sub-pixel layout and zoom both mean the final offset is rarely exact.
  // Without tolerance this would retry until the clock ran out on every
  // successful restore.
  const v = restoreStep({
    current: 799, target: 800, max: 5000, lastMax: 5000, steady: 0, elapsedMs: 0
  })
  assert.equal(v.done, true)
})

console.log(`\n${n} passed, 0 failed`)
