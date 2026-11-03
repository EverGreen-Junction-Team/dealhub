// ISO 3166-1 alpha-2 codes and names, copied verbatim from GoHighLevel's own
// country list.
//
// VERBATIM MATTERS. The names are theirs, including the ones that look like
// typos — 'AndorrA' with the capital A, 'Cote D"Ivoire' with the stray double
// quote, and 'UK' rather than 'United Kingdom' for GB. Correcting them here
// would make our dropdown disagree with the same field in GHL, and a rep
// checking one against the other would find two different spellings for the
// same country. If GHL fixes theirs, fix this then.
//
// Codes are what we store and send: GHL's business API takes a two-letter code,
// not a name.
const COUNTRIES = {
  AF: 'Afghanistan', AX: 'Aland Islands', AL: 'Albania', DZ: 'Algeria',
  AS: 'American Samoa', AD: 'AndorrA', AO: 'Angola', AI: 'Anguilla',
  AQ: 'Antarctica', AG: 'Antigua and Barbuda', AR: 'Argentina', AM: 'Armenia',
  AW: 'Aruba', AU: 'Australia', AT: 'Austria', AZ: 'Azerbaijan',
  BS: 'Bahamas', BH: 'Bahrain', BD: 'Bangladesh', BB: 'Barbados',
  BY: 'Belarus', BE: 'Belgium', BZ: 'Belize', BJ: 'Benin',
  BM: 'Bermuda', BT: 'Bhutan', BO: 'Bolivia', BA: 'Bosnia and Herzegovina',
  BW: 'Botswana', BV: 'Bouvet Island', BR: 'Brazil',
  IO: 'British Indian Ocean Territory', BN: 'Brunei Darussalam',
  BG: 'Bulgaria', BF: 'Burkina Faso', BI: 'Burundi', KH: 'Cambodia',
  CM: 'Cameroon', CA: 'Canada', CV: 'Cape Verde', KY: 'Cayman Islands',
  CF: 'Central African Republic', TD: 'Chad', CL: 'Chile', CN: 'China',
  CX: 'Christmas Island', CC: 'Cocos (Keeling) Islands', CO: 'Colombia',
  KM: 'Comoros', CG: 'Congo', CD: 'Congo, The Democratic Republic of the',
  CK: 'Cook Islands', CR: 'Costa Rica', CI: 'Cote D"Ivoire', HR: 'Croatia',
  CU: 'Cuba', CY: 'Cyprus', CZ: 'Czech Republic', DK: 'Denmark',
  DJ: 'Djibouti', DM: 'Dominica', DO: 'Dominican Republic', EC: 'Ecuador',
  EG: 'Egypt', SV: 'El Salvador', GQ: 'Equatorial Guinea', ER: 'Eritrea',
  EE: 'Estonia', ET: 'Ethiopia', FK: 'Falkland Islands (Malvinas)',
  FO: 'Faroe Islands', FJ: 'Fiji', FI: 'Finland', FR: 'France',
  GF: 'French Guiana', PF: 'French Polynesia', TF: 'French Southern Territories',
  GA: 'Gabon', GM: 'Gambia', GE: 'Georgia', DE: 'Germany', GH: 'Ghana',
  GI: 'Gibraltar', GR: 'Greece', GL: 'Greenland', GD: 'Grenada',
  GP: 'Guadeloupe', GU: 'Guam', GT: 'Guatemala', GG: 'Guernsey',
  GN: 'Guinea', GW: 'Guinea-Bissau', GY: 'Guyana', HT: 'Haiti',
  HM: 'Heard Island and McDonald Islands', VA: 'Holy See (Vatican City State)',
  HN: 'Honduras', HK: 'Hong Kong', HU: 'Hungary', IS: 'Iceland',
  IN: 'India', ID: 'Indonesia', IR: 'Iran, Islamic Republic Of', IQ: 'Iraq',
  IE: 'Ireland', IM: 'Isle of Man', IL: 'Israel', IT: 'Italy',
  JM: 'Jamaica', JP: 'Japan', JE: 'Jersey', JO: 'Jordan',
  KZ: 'Kazakhstan', KE: 'Kenya', KI: 'Kiribati',
  KP: "Korea People's Democratic Republic", KR: 'Republic of Korea',
  XK: 'Kosovo', KW: 'Kuwait', KG: 'Kyrgyzstan',
  LA: "Lao People's Democratic Republic", LV: 'Latvia', LB: 'Lebanon',
  LS: 'Lesotho', LR: 'Liberia', LY: 'Libyan Arab Jamahiriya',
  LI: 'Liechtenstein', LT: 'Lithuania', LU: 'Luxembourg', MO: 'Macao',
  MK: 'North Macedonia', MG: 'Madagascar', MW: 'Malawi', MY: 'Malaysia',
  MV: 'Maldives', ML: 'Mali', MT: 'Malta', MH: 'Marshall Islands',
  MQ: 'Martinique', MR: 'Mauritania', MU: 'Mauritius', YT: 'Mayotte',
  MX: 'Mexico', FM: 'Federated States of Micronesia', MD: 'Moldova, Republic of',
  MC: 'Monaco', MN: 'Mongolia', ME: 'Montenegro', MS: 'Montserrat',
  MA: 'Morocco', MZ: 'Mozambique', MM: 'Myanmar', NA: 'Namibia',
  NR: 'Nauru', NP: 'Nepal', NL: 'Netherlands', AN: 'Netherlands Antilles',
  NC: 'New Caledonia', NZ: 'New Zealand', NI: 'Nicaragua', NE: 'Niger',
  NG: 'Nigeria', NU: 'Niue', NF: 'Norfolk Island',
  MP: 'Northern Mariana Islands', NO: 'Norway', OM: 'Oman', PK: 'Pakistan',
  PW: 'Palau', PS: 'Palestinian Territory, Occupied', PA: 'Panama',
  PG: 'Papua New Guinea', PY: 'Paraguay', PE: 'Peru', PH: 'Philippines',
  PN: 'Pitcairn', PL: 'Poland', PT: 'Portugal', PR: 'Puerto Rico',
  QA: 'Qatar', RE: 'Reunion', RO: 'Romania', RU: 'Russian Federation',
  RW: 'Rwanda', SH: 'Saint Helena', KN: 'Saint Kitts and Nevis',
  LC: 'Saint Lucia', MF: 'Saint Martin', PM: 'Saint Pierre and Miquelon',
  VC: 'Saint Vincent and the Grenadines', WS: 'Samoa', SM: 'San Marino',
  ST: 'Sao Tome and Principe', SA: 'Saudi Arabia', SN: 'Senegal',
  RS: 'Serbia', SC: 'Seychelles', SL: 'Sierra Leone', SG: 'Singapore',
  SX: 'Sint Maarten', SK: 'Slovakia', SI: 'Slovenia', SB: 'Solomon Islands',
  SO: 'Somalia', ZA: 'South Africa',
  GS: 'South Georgia and the South Sandwich Islands', ES: 'Spain',
  LK: 'Sri Lanka', SD: 'Sudan', SR: 'Suriname', SJ: 'Svalbard and Jan Mayen',
  SZ: 'Eswatini', SE: 'Sweden', CH: 'Switzerland', SY: 'Syrian Arab Republic',
  TW: 'Taiwan', TJ: 'Tajikistan', TZ: 'Tanzania, United Republic of',
  TH: 'Thailand', TL: 'Timor-Leste', TG: 'Togo', TK: 'Tokelau',
  TO: 'Tonga', TT: 'Trinidad and Tobago', TN: 'Tunisia', TR: 'Turkey',
  TM: 'Turkmenistan', TC: 'Turks and Caicos Islands', TV: 'Tuvalu',
  UG: 'Uganda', GB: 'UK', UA: 'Ukraine', AE: 'United Arab Emirates',
  US: 'United States', UM: 'United States Minor Outlying Islands',
  UY: 'Uruguay', UZ: 'Uzbekistan', VU: 'Vanuatu', VE: 'Venezuela',
  VN: 'Vietnam', VG: 'Virgin Islands, British', VI: 'Virgin Islands, U.S.',
  WF: 'Wallis and Futuna', EH: 'Western Sahara', YE: 'Yemen',
  ZM: 'Zambia', ZW: 'Zimbabwe'
}

// The ones this client actually uses, floated to the top. Crittall is a UK
// glazing business; scrolling past Afghanistan to reach GB every time is a tax
// paid on every edit.
//
// These are EXCLUDED from the alphabetical group below rather than repeated in
// both — antd renders each option where it is listed, so a country in two
// groups appears twice in the menu and twice in every search result. Search
// still finds them: the filter runs across all options regardless of group.
const COMMON = ['GB', 'IE', 'US', 'AU', 'CA', 'NZ', 'FR', 'DE', 'ES', 'NL', 'AE', 'IN']

/**
 * Options for an antd Select, common countries first under a group heading.
 *
 * `label` carries the name and the code — "Ireland (IE)", and "UK (GB)", since
 * UK is what GHL calls it. antd's own `optionFilterProp="label"` then searches
 * both halves, so typing "gb" or "ireland" works with no custom filter.
 */
export function countryOptions() {
  const label = (code) => `${COUNTRIES[code]} (${code})`
  const rest = Object.keys(COUNTRIES)
    .filter((c) => !COMMON.includes(c))
    .sort((a, b) => COUNTRIES[a].localeCompare(COUNTRIES[b]))

  return [
    {
      label: 'Common',
      options: COMMON.filter((c) => COUNTRIES[c]).map((c) => ({ value: c, label: label(c) }))
    },
    {
      label: 'All countries',
      options: rest.map((c) => ({ value: c, label: label(c) }))
    }
  ]
}

/** GHL's display name for a code — "UK" for GB. Falls back to the code itself
 *  for anything unknown, so a business synced with a code we don't list still
 *  shows something rather than a blank. */
export function countryName(code) {
  if (!code) return null
  return COUNTRIES[String(code).toUpperCase()] || String(code).toUpperCase()
}

export default COUNTRIES
