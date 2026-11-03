import { useEffect, useRef, useState } from 'react'

// Voice dictation via the Web Speech API. Extracted from AskDeal.jsx (the
// Deal Hub's own Co-Pilot) so the portfolio-wide Co-Pilot tab can offer the
// same mic behaviour without a second, drifting copy of this state machine.
//
// Chromium and Safari only — Firefox has never shipped SpeechRecognition —
// so `supported` lets a caller disable the mic with a reason rather than
// show a control that silently does nothing.
//
// The composer swaps into a recording state while this runs, the way a
// messaging app does: live transcript, elapsed timer, and an explicit
// cancel. A mic that silently fills the box gives no way to abandon a
// mis-heard sentence without deleting it by hand.
export function useDictation({ q, setQ, onError, inputRef }) {
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState('')        // live transcript, this session
  const [elapsed, setElapsed] = useState(0)     // seconds
  const recognitionRef = useRef(null)
  const baseTextRef = useRef('')                // what was typed before recording
  const cancelledRef = useRef(false)
  const timerRef = useRef(null)

  const supported =
    typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition)

  const stopTimer = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const start = (e) => {
    e?.stopPropagation()
    if (!supported || listening) return

    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new Ctor()
    rec.lang = 'en-GB'
    rec.interimResults = true
    // Continuous, because the overlay gives an explicit stop. Without one you
    // get a single utterance and the mic closes itself mid-thought.
    rec.continuous = true
    recognitionRef.current = rec

    // Keep whatever was already typed — tapping the mic part-way through a
    // question means "carry on", not "start again".
    baseTextRef.current = q
    cancelledRef.current = false
    setHeard('')
    setElapsed(0)

    rec.onresult = (ev) => {
      let text = ''
      for (let i = 0; i < ev.results.length; i++) {
        text += ev.results[i][0].transcript
      }
      setHeard(text.trimStart())
    }
    rec.onend = () => {
      stopTimer()
      setListening(false)
      recognitionRef.current = null
      // Commit unless the user cancelled. Reading the transcript from state
      // here would be stale inside this closure, so the commit happens in the
      // effect below, keyed on `listening` going false.
    }
    rec.onerror = (ev) => {
      // 'no-speech' and 'aborted' are ordinary — someone tapped the mic and
      // said nothing. A permission denial is worth surfacing, since the
      // control looks broken otherwise.
      if (ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed') {
        onError?.('Microphone access is blocked — allow it in your browser to dictate.')
        cancelledRef.current = true
      }
      stopTimer()
      setListening(false)
      recognitionRef.current = null
    }

    try {
      rec.start()
      setListening(true)
      timerRef.current = window.setInterval(() => setElapsed((n) => n + 1), 1000)
    } catch {
      stopTimer()
      setListening(false)
    }
  }

  // Finish and keep what was heard.
  const finish = (e) => {
    e?.stopPropagation()
    cancelledRef.current = false
    recognitionRef.current?.stop()
  }

  // Abandon: the mic closes and nothing reaches the composer.
  const cancel = (e) => {
    e?.stopPropagation()
    cancelledRef.current = true
    recognitionRef.current?.abort?.() ?? recognitionRef.current?.stop()
    setHeard('')
  }

  // Commit the transcript once recording actually stops. Doing this in
  // rec.onend would read a stale `heard` from the closure that created the
  // recogniser.
  useEffect(() => {
    if (listening) return
    if (cancelledRef.current) { setHeard(''); return }
    const text = heard.trim()
    if (!text) return
    const base = baseTextRef.current
    setQ((base ? `${base.replace(/\s+$/, '')} ` : '') + text)
    setHeard('')
    inputRef?.current?.focus()
    // `heard` is intentionally the only trigger alongside `listening`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening])

  // Leaving the page mid-dictation must release the microphone, or the
  // browser keeps its recording indicator on after the panel is gone.
  useEffect(() => () => {
    recognitionRef.current?.abort?.() ?? recognitionRef.current?.stop?.()
    stopTimer()
  }, [])

  return { supported, listening, heard, elapsed, start, finish, cancel }
}
