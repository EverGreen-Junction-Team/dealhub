// Manual theme clustering for misha.deal_extracts fact_type='customer_question' labels.
// Built the same way as theme_clusters.mjs (requirement_theme_map): read every real label,
// group by genuine recurring subject matter. Order matters -- first match wins.
export const RULES = [
  // Pricing / cost
  [/\b(price|pricing|cost|budget|cheaper|discount|expensive|quote status|ballpark|deposit|payment|pay|bacs|credit card|cash|vat|retention|refund|surcharge)\b/i, 'Price, cost & payment terms'],

  // Photos / visual reference requests
  [/\b(photo|picture|image|mock-?up|example|brochure|visual look)\b/i, 'Photos & visual reference requests'],

  // Lead time / scheduling / dates
  [/\b(lead time|lead-in|lead\/road time|time from order|timeframe|installation date|installation dates|when.*(order|deposit|balance)|survey.*(date|time|slot|visit)|site visit|meeting|appointment|available|availability|schedule|scheduling|deadline|holiday|showroom visit|visit.*(showroom|site)|thursday|friday|monday|tuesday|wednesday|saturday|weekend|supply time|call (later|tomorrow|this week)|proposed date|proposed visit)\b/i, 'Lead time, scheduling & site visits'],

  // Quote / drawing status updates
  [/\b(update on|status of|status update|reviewed|sign(ed)? off|drawing revision|revised (quote|drawing)|drawings? (have|been|uploaded|sent|reviewed|included|forwarded)|aconex|materials have been ordered)\b/i, 'Status update on quote or drawings'],

  // What's included/excluded in the quote scope
  [/\b(quote (includes?|assumes?|covers?|excludes?)|included in (the )?quote|include (delivery|installation|removal|scaffold|vat)|scope (covers?|includes?)|full spec list|detailed list of included)\b/i, 'Quote scope & inclusions clarification'],

  // Colour / finish / material
  [/\b(colour|color|ral |finish|paint|bronze|black|traffic grey|agate)\b/i, 'Colour, finish & material spec'],

  // Dimensions / measurements / drawings & technical spec
  [/\b(dimension|measurement|mm |width|height|depth|profile|mullion|glass|sealed unit|sash|frame|track|handle|lock|hinge|cill|threshold|trickle vent|fd30|pas24|regulation|standard|rating|structural|drawing|sketch|u-value|u value|thermal|stiffener|subframe|reveal|beam|glulam)\b/i, 'Dimensions, specs & drawings'],

  // Product/system alternatives or configuration change
  [/\b(system|alternative|option|configuration|bifold|sliding|casement|crittall|cortizo|janisol|aluminium|steel|bar layout|panel|design (change|achievable)|swap|replace|like-for-like|retractable|manufactured|homelight|w20|alitherm|smarts aluspace)\b/i, 'Product/system alternative or change'],

  // Install / logistics / scope of work
  [/\b(install|scaffold|crane|survey|supply and fit|supply-only|removal|disposal|deliver|access|cherry picker|showroom|prep work|tidy|reinstate|builder needed)\b/i, 'Installation logistics & scope'],

  // Company / process / general admin
  [/\b(showroom in london|contact number|phone number|business hours|credit account|process for|next step|proceed|contractor|architect|planning|company|director|tender|warranty|contract)\b/i, 'Company process & admin questions'],
];

export function classify(label) {
  for (const [re, theme] of RULES) {
    if (re.test(label)) return theme;
  }
  return 'Other / uncategorized';
}
