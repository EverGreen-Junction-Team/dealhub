// opsStages.js — the Operations and Remedials stages, and how a GHL stage
// is recognised as one of them. Pure: no I/O, no config, so it is tested on
// its own and mirrored by the dashboard.
//
// ── WHY STAGES ARE MATCHED BY NAME ───────────────────────────────────
//
// The two pipelines are created in GHL (by hand, or later by the app with
// the pipelines.create scope), so their stage ids are not known in advance.
// The app knows the stages by the names in docs/operations-hub-plan.md §1 and
// finds each one in the mapped pipeline by name. Names are compared loosely —
// case, "&" vs "and", apostrophes and spacing do not matter — because "Fitter's
// drawing" typed as "Fitters Drawing" is the same stage to everyone who reads
// it. Anything else is reported as unmatched on the set-up screen, never
// guessed.

export const PROJECT_STAGES = [
  { key: 'deposit',             name: 'Deposit' },
  { key: 'ordering',            name: 'Ordering' },
  { key: 'fitters_drawing',     name: "Fitter's drawing" },
  { key: 'deliveries_check',    name: 'Deliveries & check' },
  { key: 'installation',        name: 'Installation' },
  { key: 'snagging',            name: 'Snagging' },
  { key: 'balance_completion',  name: 'Balance & completion' },
  { key: 'aftercare',           name: 'Aftercare' },
  { key: 'job_analysis',        name: 'Job analysis' }
];

export const REMEDIAL_STAGES = [
  { key: 'reported',       name: 'Reported' },
  { key: 'parts_to_order', name: 'Parts to order' },
  { key: 'parts_ordered',  name: 'Parts ordered' },
  { key: 'ready_to_book',  name: 'Ready to book' },
  { key: 'visit_booked',   name: 'Visit booked' },
  { key: 'fixed_closed',   name: 'Fixed and closed' }
];

export const JOB_KINDS = ['project', 'remedial'];

export function stagesFor(kind) {
  return kind === 'remedial' ? REMEDIAL_STAGES : PROJECT_STAGES;
}

/** Loose form of a stage name for matching. */
export function normaliseStageName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The stage key a GHL stage name stands for, or null. */
export function stageKeyForName(kind, name) {
  const n = normaliseStageName(name);
  if (!n) return null;
  const hit = stagesFor(kind).find((s) => normaliseStageName(s.name) === n);
  return hit ? hit.key : null;
}

/**
 * Match a GHL pipeline's stages against the expected ones.
 * ghlStages: [{ stage_id, name, position }]
 * → { byKey: { key: stageId }, missing: [names], extra: [names], ok }
 */
export function matchPipelineStages(kind, ghlStages) {
  const byKey = {};
  const extra = [];
  for (const s of ghlStages || []) {
    const key = stageKeyForName(kind, s.name);
    if (key && !byKey[key]) byKey[key] = s.stage_id;
    else extra.push(s.name);
  }
  const missing = stagesFor(kind).filter((s) => !byKey[s.key]).map((s) => s.name);
  return { byKey, missing, extra, ok: missing.length === 0 };
}

/** The stage after this one, or null at the end. */
export function nextStageKey(kind, key) {
  const list = stagesFor(kind);
  const i = list.findIndex((s) => s.key === key);
  return i >= 0 && i < list.length - 1 ? list[i + 1].key : null;
}

// ── Step templates ───────────────────────────────────────────────────
//
// What "to do in this stage" starts as for a job, taken from the screens
// (s6, s15). A starting point, not a rule: every job's steps can be edited,
// added to and removed, and a stage with no steps simply never moves on by
// itself — it is moved by hand.
export const STEP_TEMPLATES = {
  project: {
    deposit: ['Confirm deposit received', 'Book survey'],
    ordering: ['Place every order in TrueBlue (4 weeks before install)'],
    fitters_drawing: ["Build the fitter's drawing from the quote", "Issue fitter's drawing to the fitter"],
    deliveries_check: [
      'Book skip / rubbish removal',
      'Chase supplier confirmations',
      "Check in every delivery against the fitter's drawing",
      'Send install dates to client',
      'Book electrician'
    ],
    installation: ['Confirm start time with the fitter', "Fitter's completion photos and snag list"],
    snagging: ['Log any snags as remedials', 'Send client update'],
    balance_completion: ['Send balance invoice and payment link', 'Confirm balance paid'],
    aftercare: ['Aftercare call to client'],
    job_analysis: ['Check final costings']
  },
  remedial: {
    reported: ['Photos and description from the client', 'Decide product or fitting fault'],
    parts_to_order: ['Order the replacement part'],
    parts_ordered: ['Send client update', 'Get delivery date confirmed by the supplier'],
    ready_to_book: ['Book fitter visit'],
    visit_booked: ['Confirm visit with client'],
    fixed_closed: ['Get client sign-off']
  }
};

export function templateSteps(kind, stageKey) {
  return (STEP_TEMPLATES[kind] && STEP_TEMPLATES[kind][stageKey]) || [];
}

// ── Time entries ─────────────────────────────────────────────────────
// The activity lists from s13 (project) and s22 (remedial).
export const TIME_ACTIVITIES = {
  project: [
    'Delivery check-in', 'Design & quoting', 'Re-quoting', "Fitter's drawing",
    'Drawing revisions', 'Ordering in TrueBlue', 'Supplier chasing', 'Survey',
    'Fitter & subbie booking', 'Client updates', 'Install issue', 'Remedial', 'Admin'
  ],
  remedial: [
    'Remedial', 'Site visit', 'Supplier chasing', 'Ordering in TrueBlue',
    'Client updates', 'Drawing revisions', 'Install issue', 'Admin'
  ]
};

/** Hours as entered → a number, or null when it is not a valid entry. */
export function parseHours(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || n <= 0 || n > 24) return null;
  // Quarter hours are the finest the screens offer; anything finer is noise.
  return Math.round(n * 4) / 4 || null;
}
