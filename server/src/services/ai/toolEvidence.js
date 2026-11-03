// toolEvidence.js — citable rows a tool fetched during a turn.
//
// WHY THIS EXISTS.
// Deal AI validates every factual sentence against a verbatim quote. That
// check is built from the pre-assembled context (contextBuilder), which is
// fixed before the question is answered. Once the deal surface can call tools
// mid-answer, the model can fetch a message that is NOT in that context — and
// a citation to it would be rejected as unquotable. The model would be
// penalised precisely for looking something up.
//
// So tool results are mined for the same three citable kinds the validator
// already knows — messages, notes, tasks — and handed to makeValidator as
// extra evidence. The standard does not move: a quote must still appear
// verbatim in the row it cites. Only the set of rows widens.
//
// WHAT IS NOT MINED.
// Aggregates (get_deal_metrics, counts, breakdowns) produce no quotable text,
// so nothing is taken from them. A number cannot be cited to a message, and
// pretending otherwise would let a figure pass the citation check by quoting
// an unrelated sentence from the same deal.

// Where quotable text lives, per row shape. Tool rows use `id` (aliased in
// the SQL), context rows use message_id / note_id / task_id.
const ID_KEYS = ['id', 'message_id', 'note_id', 'task_id'];
const TEXT_KEYS = ['body_text', 'body', 'text', 'title'];

function idOf(row) {
  for (const k of ID_KEYS) {
    const v = row?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

// Title AND body, joined — the same rule makeValidator applies to tasks,
// where the commitment is usually in the title ("Send revised quote").
function textOf(row) {
  const parts = [];
  for (const k of TEXT_KEYS) {
    const v = row?.[k];
    if (typeof v === 'string' && v.trim()) parts.push(v);
  }
  return parts.join('\n');
}

// Arrays inside a tool result that may hold citable rows. Named rather than
// walked blindly: a recursive scrape would pull ids out of aggregates and
// make unquotable things look citable.
const ROW_KEYS = ['messages', 'notes', 'tasks', 'rows', 'items', 'results'];

/**
 * Pull citable { id, text } rows out of this turn's tool calls.
 *
 * @param {Array<{name: string, result: any}>} toolCalls
 * @returns {Array<{id: string, text: string}>}
 */
export function evidenceFromToolCalls(toolCalls = []) {
  const out = [];
  const seen = new Set();

  const take = (row) => {
    const id = idOf(row);
    if (!id || seen.has(id)) return;
    const text = textOf(row);
    // No text is not evidence. Keeping it would let a citation name a real id
    // and quote nothing, which is the exact failure the validator exists to
    // catch.
    if (!text.trim()) return;
    seen.add(id);
    out.push({ id, text });
  };

  for (const call of toolCalls) {
    const r = call?.result;
    if (!r || typeof r !== 'object') continue;
    if (Array.isArray(r)) { r.forEach(take); continue; }
    for (const key of ROW_KEYS) {
      if (Array.isArray(r[key])) r[key].forEach(take);
    }
  }
  return out;
}
