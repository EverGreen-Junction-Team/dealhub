// The Deal hub's solid header bands, and the stage chevron bar.
//
// Run: node --test src/pages/dealhub/__tests__/panelHeaders.test.mjs
//
// The client's October 2026 design turns every Deal hub section header from a
// pale tint with coloured text into a solid band of that accent with white
// text, and adds the pipeline as a row of chevrons across the deal card.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dealhub = join(here, '..');
const read = (f) => readFileSync(join(dealhub, f), 'utf8');
const tokens = readFileSync(join(dealhub, '..', '..', 'styles', 'dealhub-tokens.css'), 'utf8');
const chrome = readFileSync(join(dealhub, '..', 'shared', 'ListChrome.jsx'), 'utf8');

// ---- contrast -------------------------------------------------------------

const lum = (hex) => {
  const c = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const l1 = lum(a); const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

test('every header band holds its 18px/600 white title at AA-large', () => {
  // 3:1 is the floor for text at 18px/600 and above. Gold is the tight one
  // (3.25:1) — it is the client's colour and it passes, but only just, which
  // is why the smaller subtitle is handled separately below.
  const bands = [...tokens.matchAll(/--panel-head-(\w+): (#[0-9a-f]{6});/g)]
    .filter(([, name]) => !name.endsWith('border'));
  assert.ok(bands.length >= 6, `expected the band tokens, found ${bands.length}`);
  for (const [, name, hex] of bands) {
    const r = ratio(hex, '#ffffff');
    assert.ok(r >= 3, `--panel-head-${name} (${hex}) is ${r.toFixed(2)}:1 against white — below AA-large`);
  }
});

test('the subtitle is not plain 85% white', () => {
  // On clay (4.40:1) and gold (3.25:1) the 13px subtitle misses AA for normal
  // text. The mockup's rgba(255,255,255,0.85) would make it worse, so it
  // renders at 92% instead.
  const head = read('PanelHead.jsx');
  assert.match(head, /rgba\(255,255,255,0\.92\)/);
  assert.doesNotMatch(head, /rgba\(255,\s*255,\s*255,\s*0\.85\)/);
});

// ---- the shared component -------------------------------------------------

test('every Deal hub panel uses the shared header', () => {
  // Seven panels had their own <header> with the same shape. One drifting
  // from the others is how Tasks ended up needing its own token.
  for (const f of ['Timeline.jsx', 'DealTasksSection.jsx',
    'QualificationSection.jsx', 'MediaSection.jsx', 'PeopleSection.jsx']) {
    assert.match(read(f), /import PanelHead(,| from)/, `${f} still rolls its own header`);
  }
  // The Deal card's band is rendered by DealHubTab, not by DealSection: one
  // <section> there wraps the header, the toolbar and whichever rail is
  // showing, which is what the design draws.
  const tab = readFileSync(join(dealhub, '..', 'tabs', 'DealHubTab.jsx'), 'utf8');
  assert.match(tab, /<PanelHead\n\s+icon="grid_view"/);
});

test('no Deal hub panel renders the old pale band', () => {
  // AskDeal's is a MODAL header ("Messages considered"), not a panel band.
  const offenders = readdirSync(dealhub)
    .filter((f) => f.endsWith('.jsx') && f !== 'AskDeal.jsx')
    .filter((f) => /background: 'var\(--panel-tint, var\(--gray-25\)\)'/.test(read(f)));
  assert.deepEqual(offenders, [], `pale headers remain in ${offenders.join(', ')}`);
});

test('the shared Panel keeps the pale band for every OTHER tab', () => {
  // ListChrome's Panel is the chrome for seven tabs. Flipping its default
  // would restyle Businesses, Contacts, Notes and the rest at the same time.
  assert.match(chrome, /solidHeader = false/);
});

test('the loading skeleton wears the same band', () => {
  // A pale skeleton header that turns coloured when data lands reads as the
  // layout shifting, not as the same panel filling in.
  assert.match(read('Skeleton.jsx'), /var\(--panel-head-\$\{accent\}/);
});

// ---- the stage stepper ----------------------------------------------------
//
// The chevron row already existed as StageStepper, rendered above the deal
// card — it just did nothing when clicked. A second component was written for
// the client's design before that was noticed; this pins the one that stays.

test('the stepper renders the server\'s own past/current answer', () => {
  // /deals/:id/stages already resolves the current index against the deal's
  // stage NAME and inserts a virtual entry when the pipeline no longer holds
  // it. Recomputing here would eventually disagree with it.
  const stepper = read('StageStepper.jsx');
  assert.match(stepper, /isCurrent/);
  assert.match(stepper, /isPast/);
});

test('the stepper sits at the CARD\'s foot, not in the page header', () => {
  // It described THIS deal while sitting above a card that might be showing
  // People or Media instead — so it named a deal the reader was not looking
  // at. The design puts it as the card's last row.
  const deal = read('DealSection.jsx');
  assert.match(deal, /<StageStepper/);
  assert.ok(
    deal.indexOf('<ProductFooter') < deal.indexOf('<StageStepper'),
    'the chevrons must come after the chip strip'
  );
  const tab = readFileSync(join(dealhub, '..', 'tabs', 'DealHubTab.jsx'), 'utf8');
  assert.doesNotMatch(tab, /<StageStepper/, 'the old header copy is back');
});

test('clicking a stage moves the deal, and a virtual stage does not', () => {
  // It was decorative: a row of chevrons that looked like a control and did
  // nothing. The virtual entry has stage_id null — GHL's update endpoint
  // takes pipelineStageId and accepts no name, so there is nothing to send.
  const deal = read('DealSection.jsx');
  assert.match(deal, /if \(st\?\.id && !st\.isCurrent\) onMoveStage\(st\.id\)/);
  const tab = readFileSync(join(dealhub, '..', 'tabs', 'DealHubTab.jsx'), 'utf8');
  assert.match(tab, /onMoveStage=\{\(id\) => saveDealField\('pipelineStageId', id\)\}/);
});

test('the toolbar outlives the rail it switches', () => {
  // It was put INSIDE DealSection, which only renders for leftRail 'deal' —
  // so clicking People unmounted the very control you switch with, and there
  // was no way back without a reload. It renders above all three rails.
  const tab = readFileSync(join(dealhub, '..', 'tabs', 'DealHubTab.jsx'), 'utf8');
  assert.match(tab, /<CardToolbar/);
  assert.ok(
    tab.indexOf('<CardToolbar') < tab.indexOf("{leftRail === 'people' &&"),
    'the toolbar must precede the conditional rails'
  );
  // And NOT inside the card, or the bug returns.
  assert.doesNotMatch(read('DealSection.jsx'), /<CardToolbar/);
  // The loose pills it replaced are still gone.
  assert.doesNotMatch(tab, /\['media',\s+'Media',\s+'folder_open'\]/, 'the loose pills are back');
});

test('there is only ONE chevron component', () => {
  // StageBar was built before StageStepper was noticed — two near-identical
  // components, one above the card and one below it.
  assert.ok(!existsSync(join(dealhub, 'StageBar.jsx')), 'the duplicate StageBar is back');
});

// ---- the bordered field cards --------------------------------------------

test('the customer, deal name and stage facts all use the shared card', () => {
  // Three places wanted the same bordered box with a tinted strip. Three
  // hand-rolled copies would drift on border colour and cell padding.
  const deal = read('DealSection.jsx');
  assert.match(deal, /import \{ FieldCard, FieldGrid, FieldCell, FieldRow, NotSet \} from '\.\/FieldCard'/);
  assert.match(deal, /<FieldCard[\s\S]*?label="Deal name"/);
  assert.match(deal, /<FieldCard[\s\S]*?label="Customer"/);
});

test('an empty value still renders as a dash', () => {
  // A gap in the customer's record is the thing a rep is meant to notice —
  // hiding it makes a half-filled record look complete.
  assert.match(read('FieldCard.jsx'), /\{empty \? '—' : value\}/);
});

test('a part-filled last row never shows the gap colour', () => {
  // Nine fields leave one over at two columns and none at three, so the
  // filler count depends on the layout — the customer band is three columns
  // wide at the card's foot and two in a narrow column.
  const deal = read('DealSection.jsx');
  assert.match(deal, /wide \? \(3 - \(fields\.length % 3\)\) % 3 : fields\.length % 2/);
  // The maths, not just its presence.
  const filler = (cols, n) => (cols === 3 ? (3 - (n % 3)) % 3 : n % 2);
  for (const cols of [2, 3]) {
    assert.equal((9 + filler(cols, 9)) % cols, 0, `${cols} columns leaves a ragged row`);
  }
});

test('the stale-contact warning survived the move into cells', () => {
  // 14 days of silence on an open deal is a signal the date alone cannot
  // give. It was a Row prop before these became FieldCells.
  assert.match(read('FieldCard.jsx'), /tone === 'danger'/);
  assert.match(read('DealSection.jsx'), /tone=\{stale \? 'danger' : undefined\}/);
});

test('the owner sits IN the facts grid, with its picker intact', () => {
  // The design shows Owner as the first of four facts, not as a row above
  // them. It still cannot BE a FieldCell — that renders a value and a pencil,
  // while this swaps the whole value for a searchable Select — so it renders
  // its own cell with the same shape.
  const deal = read('DealSection.jsx');
  const grid = deal.slice(deal.indexOf('<FieldGrid style={{'), deal.indexOf('</FieldGrid>'));
  assert.match(grid, /<OwnerRow/, 'Owner is not inside the facts grid');
  assert.match(deal, /showSearch/, 'the user picker was lost in the move');
  // The cell shape FieldCell uses, so the five cells line up.
  assert.match(deal, /const cell = \{ minWidth: 0, padding: '8px 12px', background: '#fff' \}/);
});

test('the stage select is a green outline, not a green block', () => {
  // A tinted fill made it the only coloured control in a column of white
  // ones, which read as a selected state rather than as the field that
  // matters most.
  assert.match(tokens, /border: 1\.5px solid var\(--brand-primary\) !important/);
  assert.doesNotMatch(tokens, /background: var\(--tint-pine\) !important/);
});

test('the deal badge reads STATUS + type, and is not a button', () => {
  // "Open DEAL" is the deal's STATUS followed by the record type — not a
  // verb. Read as an instruction it would duplicate "Edit record" on the
  // header band, which opens the same editor, so the badge is a <span>:
  // nothing on the card should look clickable and do nothing.
  const deal = read('DealSection.jsx');
  assert.match(deal, /\{deal\.status \|\| 'Open'\}/);
  const badge = deal.slice(deal.indexOf('// A "DEAL" badge'), deal.indexOf('</FieldCard>'));
  assert.doesNotMatch(badge, /<button/, 'the badge became a button again');
});

test('Qualification is a full-width section, not a rail item', () => {
  // It used to sit in the 320px right column under Notes, where ten long
  // free-text headings each wrapped to four or five lines. Full width it is a
  // row per heading — and it is where the design puts it, between the rail
  // and Co-Pilot.
  const tab = readFileSync(join(dealhub, '..', 'tabs', 'DealHubTab.jsx'), 'utf8');
  const railEnd = tab.indexOf('<DealNotesSection');
  const qual = tab.indexOf('<QualificationSection');
  const copilot = tab.indexOf('<AskDeal');
  assert.ok(qual > railEnd, 'Qualification is still inside the rail');
  assert.ok(qual < copilot, 'Qualification must sit above Co-Pilot');
});

test('tags sit under the stage facts', () => {
  // They were inside the CLIENT chip group at the card's foot; that foot
  // belongs to the customer now, and a tag is a fact about the deal's STATE
  // rather than about the client's type.
  const deal = read('DealSection.jsx');
  assert.match(deal, /<TagRow deal=\{deal\} embedded \/>/);
  // Still exactly one — two would render the pills twice.
  assert.equal((deal.match(/<TagRow /g) || []).length, 1);
  // And inside the Stage column, after its facts grid.
  const stage = deal.slice(deal.indexOf("<Column label=\"Stage\">"));
  assert.ok(stage.indexOf('<TagRow') > -1 && stage.indexOf('<TagRow') < stage.indexOf('</Column>'));
});

test('the customer band is full width, the deal fields are in the column', () => {
  // They swapped: nine customer fields in a 300px column wrapped every value
  // onto its own line, while the deal's own fields belong beside its name.
  const deal = read('DealSection.jsx');
  assert.match(deal, /<FieldChipRow/);
  assert.match(deal, /<ContactLines[\s\S]{0,200}?wide/);
  // `stacked` is gone: the grouped three-across layout was the only other
  // mode, and nothing rendered it. A prop with one value is not a choice.
  assert.doesNotMatch(deal, /<FieldChipRow[\s\S]{0,200}?stacked/);
})

test('the deal fields are THREE GROUPED CARDS, not one flat table', () => {
  // The client design (Oct 2026) drops the Client / Product / Lead source
  // HEADINGS — not the grouping. Each group is its own bordered card with a
  // gap above it, and those gaps are the only thing saying that "Product
  // system" and "Product type" answer one question.
  //
  // This shipped briefly as one flat five-row table, because at a glance that
  // is nearly what the mockup looks like. It is not, and the difference is
  // invisible unless you measure the gaps.
  const deal = read('DealSection.jsx');
  assert.match(deal, /const FIELD_GROUPS = \[/);
  assert.match(deal, /\['productSystem', 'productType'\]/);
  assert.match(deal, /\['firstContactMethod', 'leadSource'\]/);
  assert.match(deal, /FIELD_GROUPS\.map\(\(keys\)/);
  // A gap BETWEEN the cards is the grouping; without it they re-merge into
  // the flat table this test exists to prevent.
  assert.match(deal, /display: 'grid', gap: 'var\(--space-3\)'/);
  // No heading text — the design shows none. Asserted as the DECLARATION and
  // the USE, not as the bare word: a comment explaining why CHIP_GROUPS was
  // replaced contains the word, and matching the whole file fails on prose.
  assert.doesNotMatch(deal, /const CHIP_GROUPS = /);
  assert.doesNotMatch(deal, /CHIP_GROUPS\.map/);
  assert.doesNotMatch(deal, /function FieldChip\(/);
})

test('each group card closes its own last row', () => {
  // `last` is per CARD, not per list. Keyed off the flat FIELD_CHIPS index it
  // would leave a border hanging under the final field of every group but the
  // last one.
  const deal = read('DealSection.jsx');
  assert.match(deal, /last=\{i === keys\.length - 1\}/);
  assert.doesNotMatch(deal, /last=\{i === FIELD_CHIPS\.length - 1\}/);
})

test('the field order is fixed, never sorted by whether a value is set', () => {
  // Sorting set-before-unset moved the row being edited: picking a value
  // flips a field to set, DealHubTab applies it optimistically, React
  // reconciles a reordered list and the open dropdown snaps shut.
  const deal = read('DealSection.jsx');
  assert.doesNotMatch(deal, /FIELD_CHIPS\.filter\(\(\[, k\]\) => isSet\(k\)\)/);
})

test('"How they found us" is a LABEL over lead_source_opportunity', () => {
  // No such field exists in GHL or in our tables — the design just words the
  // question the way a rep would ask it. The key underneath is unchanged, so
  // the read and write paths do not move with the wording.
  const deal = read('DealSection.jsx');
  assert.match(deal, /\['How they found us',\s+'leadSource',\s+'lead_source_opportunity'/);
});

test('the embedded tags drop the "Tags:" prefix', () => {
  // The column's own TAGS heading already says what they are.
  assert.match(read('DealSection.jsx'), /\{!embedded && \(/);
});

test('the SEARCH slot holds the deal switcher, not an input', () => {
  // A text box there would be a second search beside a picker that already
  // searches every deal in the location.
  const tab = readFileSync(join(dealhub, '..', 'tabs', 'DealHubTab.jsx'), 'utf8');
  const open = tab.indexOf('<CardToolbar');
  const close = tab.indexOf('</CardToolbar>');
  const sw = tab.indexOf('{/* Deal switcher */}');
  assert.ok(open > -1 && close > open, 'the toolbar lost its children slot');
  assert.ok(open < sw && sw < close, 'the switcher is not in the SEARCH slot');
  // The toolbar renders whatever it is given there; it owns no input.
  assert.doesNotMatch(read('DealSection.jsx'), /type="search"/);
});

test('there is only ONE deal switcher', () => {
  // It used to sit in an OPPORTUNITY row above the card. Keeping both would
  // be two ways to do one thing, one of them outside the card it changes —
  // and the empty bordered box left behind read as a panel that failed.
  const tab = readFileSync(join(dealhub, '..', 'tabs', 'DealHubTab.jsx'), 'utf8');
  assert.equal((tab.match(/\{\/\* Deal switcher \*\/\}/g) || []).length, 1);
  assert.doesNotMatch(tab, /ref=\{switcherRef\} style=\{\{ position: 'relative', width: 420/,
    'the fixed 420px width is back — it overflows the toolbar slot');
});

// ---- the People view ------------------------------------------------------

test('a person\'s details are FULL-WIDTH rows, not a two-column grid', () => {
  // FieldCell stacks its label above the value, which suits the deal card's
  // narrow cells. A person card is the full width of its column, and a
  // stacked pair there wastes the right two thirds of every row — so the
  // label sits beside the value in its own tinted column.
  const people = read('PeopleSection.jsx');
  assert.match(people, /import \{ FieldRow \} from '\.\/FieldCard'/);
  assert.doesNotMatch(people, /<FieldGrid/, 'the two-column grid is back');
  for (const label of ['Email', 'Telephone', 'Business', 'Role']) {
    assert.match(people, new RegExp(`'${label}'`), `${label} row is missing`);
  }
});

test('the label column is fixed, so values line up down the card', () => {
  // Ragged left edges down four rows read as a broken table.
  assert.match(read('FieldCard.jsx'), /gridTemplateColumns: 'minmax\(132px, 190px\) minmax\(0, 1fr\) auto'/);
})

test('row cells STRETCH, so a wrapped label does not leave a ragged step', () => {
  // `alignItems: center` sizes each cell to its own content. A label that
  // wraps to two lines ("Last customer contact") then made the tinted cell
  // taller than the value beside it, and the tint and the divider stopped
  // short of the row's height.
  const card = read('FieldCard.jsx');
  assert.match(card, /alignItems: 'stretch'/);
  // The centring moves INSIDE each cell, where it only affects the text.
  assert.doesNotMatch(card, /gridTemplateColumns: 'minmax\(132px[^\n]*\n[^\n]*\n\s*alignItems: 'center'/);
})

test('the truncating element is never made a flex box', () => {
  // text-overflow: ellipsis needs a block container. Putting display:flex on
  // the Truncate to centre it silently disables the clipping it exists for,
  // so the centring sits on a wrapper around it.
  const card = read('FieldCard.jsx');
  assert.doesNotMatch(card, /<Truncate style=\{\{\s*\n\s*display: 'flex'/);
});

test('every field renders, filled or not', () => {
  // They used to be hidden when empty, which made a contact with no email
  // look complete rather than incomplete — a gap is the thing a rep needs to
  // notice. FieldCell draws an em dash for an empty value.
  const people = read('PeopleSection.jsx');
  assert.doesNotMatch(people, /\{p\.email && usedField !== 'email' &&/);
  assert.doesNotMatch(people, /\{p\.phone && usedField !== 'phone' &&/);
});

test('the pencils say where they actually go', () => {
  // They open the contact's own record rather than editing in place, so the
  // default "Edit email" tooltip would name the wrong action.
  assert.match(read('PeopleSection.jsx'), /editTitle=\{onViewContact \? `Edit on \$\{nameFor\(p\)\}'s record`/);
});

test('person actions are solid pills, toned by what they do', () => {
  // They were borderless text-and-icon, so four different actions — one of
  // them a destructive Remove — read at exactly the same weight.
  const people = read('PeopleSection.jsx');
  assert.match(people, /borderRadius: 'var\(--radius-pill\)'/);
  assert.match(people, /danger\s*\n?\s*\? 'var\(--status-stuck\)'/);
  assert.match(people, /primary\s*\n?\s*\? 'var\(--accent-sky\)'/);
});

test('every button fill carries white text at AA', () => {
  // 13px white needs 4.5:1. Red is the tight one at 4.52:1.
  const lum = (hex) => {
    const c = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const l1 = lum(a); const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  for (const [name, hex] of [
    ['slate', '#323844'], ['sky', '#2470c2'],
    ['red', '#d83a52'], ['pine', '#1f7a5c']
  ]) {
    const r = ratio(hex, '#ffffff');
    assert.ok(r >= 4.5, `${name} (${hex}) is ${r.toFixed(2)}:1 against white`);
  }
});

test('Open names its destination on the button', () => {
  // "Open CONTACT" — the verb plus a chip naming the record type, so the
  // destination is not only in the tooltip.
  assert.match(read('PeopleSection.jsx'), /chip="CONTACT"/);
});

test('the customer card has edit pencils', () => {
  // Nine labelled fields with no affordance at all — the design shows a
  // pencil on each. They open the CONTACT'S record, since these are the
  // customer's fields rather than the deal's.
  const deal = read('DealSection.jsx');
  assert.match(deal, /onEdit=\{onOpenContact \? \(\) => onOpenContact\(person\.id\) : undefined\}/);
  const tab = readFileSync(join(dealhub, '..', 'tabs', 'DealHubTab.jsx'), 'utf8');
  assert.match(tab, /onOpenContact=\{onOpenContact\}/);
});

test('a person chip is blue wherever it appears', () => {
  // It was a grey fill with muted text, which made the person a row is filed
  // against read as quieter than the row's own metadata — the opposite of
  // what it is. Both panels now use the same sky chip.
  for (const f of ['Timeline.jsx', 'DealTasksSection.jsx']) {
    const src = read(f);
    assert.match(src, /border: '1px solid var\(--accent-sky\)'/, `${f} chip is not blue`);
    assert.match(src, /color: 'var\(--accent-sky-text\)'/, `${f} uses the bare accent`);
  }
});

test('the chip text clears AA on its own tint', () => {
  // --accent-sky on --tint-sky is 4.41:1, just below. The -text variant
  // exists for exactly this pairing.
  const lum = (hex) => {
    const c = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const l1 = lum('#236ec0'); const l2 = lum('#e8f1fb');
  const r = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  assert.ok(r >= 4.5, `sky-text on tint-sky is ${r.toFixed(2)}:1`);
});

test('a NEW note or task waits for its webhook before refetching', () => {
  // Neither POST inserts our row: /notes and /tasks write to GHL, and the
  // NoteCreate / TaskCreate webhook is what inserts here. An immediate
  // refetch raced that insert and came back without the row the rep had just
  // created — so a new note only appeared after a manual refresh.
  const rail = read('DealTasksSection.jsx');
  assert.match(rail, /const reloadSoon = useCallback/);
  assert.match(rail, /setNonce\(\(n\) => n \+ 1\), 2500\)/);
  // Both rails, not just notes — at least two; the task rail also reloads
  // when a task moves to another deal.
  assert.ok((rail.match(/reloadSoon\(\)/g) || []).length >= 2);
});

test('an EDIT still updates instantly', () => {
  // The delay is for creates only — patching a row we already have needs no
  // webhook, and 2.5s of nothing would read as a failed save.
  assert.match(read('DealTasksSection.jsx'), /const reload = useCallback\(\(\) => setNonce\(\(n\) => n \+ 1\), \[\]\)/);
});

test('the qualification count sits on the right, with the missing pill', () => {
  // Split across the band, "0 of 10" and "10 missing" read as unrelated
  // facts; together they are one reading.
  const q = read('QualificationSection.jsx');
  assert.doesNotMatch(q, /subtitle=\{`\$\{filled\} of/);
  assert.match(q, /\{filled\} of \{qualification\.length\}/);
});

test('a wrapped placeholder loses its brackets, a real one keeps them', () => {
  // GHL writes these as form HINTS — "(What are their requirements?)" — and
  // the design shows them bare. Only a pair wrapping the WHOLE string goes.
  const unwrap = (text) => {
    const t = String(text || '').trim();
    if (!t.startsWith('(') || !t.endsWith(')')) return t;
    const inner = t.slice(1, -1);
    return inner.includes('(') || inner.includes(')') ? t : inner;
  };
  assert.equal(unwrap('(What are their requirements?)'), 'What are their requirements?');
  assert.equal(unwrap('Why did we loose the deal?'), 'Why did we loose the deal?');
  assert.equal(unwrap('(A) or (B)'), '(A) or (B)', 'a non-wrapping pair must survive');
  assert.match(read('QualificationSection.jsx'), /function unwrapParens/);
});

test('an unset field is an amber "Not set" chip, not a dash or a dashed box', () => {
  // Dashed on transparent read as a drop-target rather than a field; an em
  // dash reads as a value someone typed. The chip is neither.
  const deal = read('DealSection.jsx');
  const card = read('FieldCard.jsx');
  assert.doesNotMatch(deal, /'1px dashed var\(--accent-gold\)'/);
  assert.match(card, /export function NotSet\(\)/);
  // Still a SOLID amber chip — softened in Oct 2026 (client: "looks very
  // bright") to a half-strength border and a paler fill, not removed.
  assert.match(card, /border: '1px solid color-mix\(in srgb, var\(--accent-gold\) \d+%, transparent\)'/);
  assert.match(card, /background: 'color-mix\(in srgb, var\(--tint-gold\) \d+%, #fff\)'/);
  // Opt-in, so People keeps its dash: "not set" is worth flagging on a deal's
  // product type and not on a contact's middle name.
  assert.match(card, /notSet = false/);
  assert.match(card, /\{empty \? \(notSet \? <NotSet \/> : '—'\) : value\}/);
  // An empty PICKER takes the same chip — two kinds of emptiness in one
  // table would read as two different states.
  assert.match(deal, /bare && !set\s*\n\s*\? <NotSet \/>/);
})

test('a bare picker draws no border of its own', () => {
  // It sits inside a bordered table row; a second box around the control
  // reads as a nested control rather than an editable cell.
  const deal = read('DealSection.jsx');
  assert.match(deal, /border: bare\s*\n\s*\? '1px solid transparent'/);
  assert.match(deal, /background: bare \? 'none'/);
});

test('the view buttons are rounded rectangles, not pills', () => {
  // They share the search box's corner radius beside them; full pills next to
  // a square-cornered input read as two different control families.
  const deal = read('DealSection.jsx');
  const toolbar = deal.slice(deal.indexOf('VIEWS.map'), deal.indexOf('VIEWS.map') + 1200);
  assert.match(toolbar, /borderRadius: 'var\(--radius-sm\)'/);
  assert.doesNotMatch(toolbar, /borderRadius: 'var\(--radius-pill\)'/);
})

test('the business pill is PLUM, matching every other business affordance', () => {
  // It rendered sky-blue — the one place in the app where "business" was not
  // plum. Scoped to BusinessBlock so a sky token elsewhere does not trip it.
  const deal = read('DealSection.jsx');
  const block = deal.slice(deal.indexOf('function BusinessBlock('), deal.indexOf('function ValueColumn('));
  assert.match(block, /border: '1px solid var\(--accent-plum\)'/);
  assert.match(block, /background: 'var\(--tint-plum\)'/);
  assert.match(block, /color: 'var\(--accent-plum-text\)'/);
  assert.match(block, /borderRadius: 'var\(--radius-pill\)'/);
  assert.doesNotMatch(block, /accent-sky|tint-sky/);
})

test('the initial enquiry is a tinted, bordered block', () => {
  // Bare on the card's white it read as prose WE wrote; the frame says it
  // was received from the customer.
  const deal = read('DealSection.jsx');
  const at = deal.indexOf('<FieldLabel>Initial enquiry</FieldLabel>');
  const block = deal.slice(at, at + 900);
  assert.match(block, /border: '1px solid var\(--gray-200\)'/);
  assert.match(block, /background: 'var\(--gray-25\)'/);
  assert.match(block, /padding: '12px 14px'/);
})
