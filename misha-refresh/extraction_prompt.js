/**
 * System prompt for the fact-extraction pass that populates
 * misha.deal_extracts. Covers insights 9.1, 9.2, 9.4, 6.4, 5.4 (customer-
 * and rep-side facts keyed by fact_type/speaker) in one pass per message,
 * matching the existing one-table design.
 *
 * Deliberately excludes 5.2 (blocked — no misha.requirements population
 * plan approved by Charlie yet). 5.6/9.3/5.5 are handled by a second,
 * separate pass (see requirements_prompt.js) since they need a different
 * output shape (requirement_label, rep_reply pairing, price_limit_amount).
 */
const EXTRACTION_SYSTEM_PROMPT = `
You are extracting structured facts from a single real customer/rep message in a glazing/windows
CRM, for a sales insights database. You will be given ONE message's cleaned text plus context
about the deal it belongs to.

## What to extract

Read the message and decide if it contains any of these fact types. A single message can contain
zero, one, or several facts — extract each one separately.

- customer_phrase: a notable turn of phrase or descriptor the customer used (how they describe
  what they want, their style, their situation) — NOT a question or a requirement, just color.
- customer_question: a genuine question the customer is asking us.
- customer_requirement: something the customer wants, needs, or is asking for (a spec, a
  deadline, a constraint) — including objections and price/budget limits.
- rep_question: a genuine question our rep is asking the customer.
- rep_product_words: how our rep described/positioned a product or system to the customer.
- rep_ask: something our rep asked the customer to do, or offered to do (a next step, a
  discount, a commitment).

Only extract from real conversational content. If the message is purely administrative
("please see attached", "confirming receipt", a bare "ok" or "thanks") with nothing substantive,
return an empty facts array — do not force an extraction.

## Output format

Respond with a JSON object only, no markdown fences:
{
  "facts": [
    {
      "fact_type": "customer_phrase" | "customer_question" | "customer_requirement" | "rep_question" | "rep_product_words" | "rep_ask",
      "speaker": "customer" | "rep",
      "label": "<short, specific, human-written summary of this one fact, lowercase start, no trailing period>",
      "quote": "<the exact relevant excerpt from the message text you were given, verbatim>",
      "rep_ask_outcome": "<only for rep_ask facts: exactly one of 'done', 'not_done', or 'unknown' —
        no other value is allowed. Use 'done' only if THIS message itself shows the ask was
        fulfilled, 'not_done' only if it shows a refusal/inability, otherwise always 'unknown'.>"
    }
  ]
}

If there is nothing worth extracting, respond with {"facts": []}.

## Rules

1. "quote" must be an exact substring of the message text given to you — never paraphrase it,
   never invent text that isn't there.
2. "label" is your own short summary (5-15 words), not a copy of the quote.
3. Never include personal names, phone numbers, or email addresses in "label" — the quote may
   contain them if present in the source (PII stripping happens separately), but keep labels
   generic and about the substance.
4. Don't extract pure pleasantries ("thanks", "sounds good", "hi") as any fact type.
5. A message can and often will produce zero facts — that's a valid, expected result, not a
   failure. Do not pad the output to seem more thorough than the message actually is.
`;

module.exports = { EXTRACTION_SYSTEM_PROMPT };
