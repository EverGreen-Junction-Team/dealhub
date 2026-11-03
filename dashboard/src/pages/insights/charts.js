// Chart adapters — one per chart key, ported from the InsightsHub prototype.
//
// Each spec says WHICH VIEWS its chart reads and HOW to turn those rows into
// bars. The shapes are the prototype's, and so the signed-off design's:
// these are the exact bar compositions the client approved, and a chart that
// looks subtly different from the handoff is one somebody has to re-check.
//
// WHAT CHANGED. Only the plumbing. The prototype read Supabase from the
// browser and named its views `i_1_1`; here `views` names our
// `vw_insight_1_1` and the rows arrive from /api/insights/charts/:key. Every
// build() is untouched — they are pure (rows in, bars out), which is why they
// could be lifted wholesale.
//
// TypeScript was stripped with esbuild, not by hand. A regex pass over 650
// lines of annotations mangled single-argument arrows and multi-line
// parameter lists, and the damage did not show up by eye.

// The design's series palette, as literals rather than app tokens: these
// hues ARE the signed-off chart language, and the app's accent tokens are
// tuned for chrome, not for four series that must stay apart inside one bar.
const SERIES = {
  primary: '#6d5dfc',
  accent: '#f26b1d',
  remainder: '#0ea5a4',
  third: '#b44cf0'
};

const fmtInt = (n) => (n == null ? '\u2014' : Number(n).toLocaleString());
const fmtGbp = (n) => (n == null ? '\u2014' : `\u00a3${Math.round(Number(n)).toLocaleString()}`);

const G = SERIES.primary;
const S = SERIES.accent;
const L = SERIES.remainder;
const V = SERIES.third;
const MID = "#f5a26b";
const num = (v) => v == null ? null : Number(v);
const n0 = (v) => Number(v) || 0;
function stacked(items, colors, maxOverride) {
  let max = maxOverride ?? 0;
  if (!maxOverride) {
    for (const it of items) {
      const sum2 = it.vals.reduce((a, v) => a + (v ?? 0), 0);
      if (sum2 > max) max = sum2;
    }
  }
  return items.map((it) => ({
    label: it.label,
    note: it.note,
    segments: it.vals.flatMap(
      (v, i) => v == null || !max || v <= 0 ? [] : [{ widthPct: v / max * 100, color: colors[i] }]
    )
  }));
}
function pctBars(items, colors) {
  return items.map((it) => ({
    label: it.label,
    note: it.note,
    separate: true,
    segments: it.parts.flatMap(
      (v, i) => v == null || v < 0 ? [] : [{ widthPct: v, color: colors[i] }]
    )
  }));
}
function medianTail(items, max) {
  const m = max || 1;
  return items.map((it) => ({
    label: it.label,
    note: it.note,
    segments: [
      { widthPct: (it.median ?? 0) / m * 100, color: G },
      { widthPct: ((it.tail ?? 0) - (it.median ?? 0)) / m * 100, color: L }
    ].filter((s) => s.widthPct > 0)
  }));
}
const THEME_LABELS = {
  "No response from customer": "No response",
  "Went with another supplier / product": "Went elsewhere",
  "Junk / not a real enquiry": "Junk enquiry",
  "Out of scope / cannot supply": "Out of scope",
  "Project stopped or delayed": "Project stopped"
};
const sum = (rows, col) => rows.reduce((a, r) => a + n0(r[col]), 0);
const maxOf = (rows, col) => rows.reduce((m, r) => Math.max(m, n0(r[col])), 0);
function routeLabel(r, rows) {
  const variants = new Set(rows.filter((x) => x.route === r.route).map((x) => x.paid_or_free));
  if (variants.size < 2) return String(r.route);
  return `${r.route} (${String(r.paid_or_free).startsWith("paid") ? "paid click" : "free"})`;
}
const CHARTS = {
  // ---- 1 Pipeline Leakage -------------------------------------------------
  c11: {
    views: ["vw_insight_1_1"],
    meta: { statuses: "lost + abandoned", n: null, run: "", locked: false },
    build: ([rows]) => stacked(
      rows.map((r) => ({
        label: r.stage_name,
        vals: [num(r.lost), num(r.abandoned)],
        note: `${fmtInt(num(r.closed_without_win))} deals`
      })),
      [G, S]
    ),
    sample: ([r]) => sum(r, "closed_without_win")
  },
  c14: {
    views: ["vw_insight_1_4"],
    meta: { statuses: "lost + abandoned", n: null, run: "", locked: false },
    build: ([rows]) => rows.map((r) => {
      const tot = n0(r.closed_without_win);
      return {
        label: r.stage_name,
        note: tot ? `${Math.round(n0(r.abandoned) / tot * 100)}% abandoned \xB7 ${tot}` : "no deals",
        segments: tot ? [
          { widthPct: n0(r.lost) / tot * 100, color: G },
          { widthPct: n0(r.abandoned) / tot * 100, color: S }
        ].filter((s) => s.widthPct > 0) : []
      };
    }),
    sample: ([r]) => sum(r, "closed_without_win")
  },
  c13: {
    views: ["vw_insight_1_3"],
    meta: { statuses: "all statuses", n: null, run: "", locked: true },
    build: ([rows]) => stacked(
      rows.map((r) => ({
        label: r.stage,
        vals: [num(r.reached)],
        note: `${fmtInt(num(r.reached))} reached \xB7 ` + (r.pct_to_next == null ? "no next stage" : `${Number(r.pct_to_next)}% carried on`)
      })),
      [G]
    ),
    sample: ([r]) => r[0] ? n0(r[0].reached) : null
  },
  c15b: {
    views: ["vw_insight_1_5_b", "vw_insight_1_5_a"],
    meta: { statuses: "lost + abandoned", n: null, run: "", locked: false },
    build: ([themes, fill]) => {
      const closed = sum(fill, "deals");
      const missing = closed - sum(fill, "reason_filled");
      const items = themes.map((r) => ({
        label: THEME_LABELS[r.theme] ?? r.theme,
        vals: [num(r.deals)],
        note: `${fmtInt(num(r.deals))} deals`
      }));
      items.push({
        label: "No reason recorded",
        vals: [null, missing],
        note: `${fmtInt(missing)} of ${fmtInt(closed)}`
      });
      return stacked(items, [G, L]);
    },
    sample: ([, fill]) => sum(fill, "deals")
  },
  // ---- 2 Scaling & Rep Performance ---------------------------------------
  c21: {
    views: ["vw_insight_2_1"],
    meta: { statuses: "closed deals only", n: null, run: "", locked: true },
    build: ([rows]) => {
      const r = rows[0];
      if (!r) return [];
      return stacked(
        [
          { label: "Won", vals: [num(r.won)], note: fmtInt(num(r.won)) },
          { label: "Lost", vals: [num(r.lost)], note: fmtInt(num(r.lost)) },
          { label: "Abandoned", vals: [num(r.abandoned)], note: fmtInt(num(r.abandoned)) },
          {
            label: "Lost at intake (junk)",
            vals: [num(r.lost_at_intake)],
            note: fmtInt(num(r.lost_at_intake))
          },
          {
            label: "Still open",
            vals: [null, num(r.open)],
            note: `${fmtInt(num(r.open))} \u2014 not in the win rate`
          }
        ],
        [S, L]
      );
    },
    sample: ([r]) => r[0] ? n0(r[0].won) + n0(r[0].lost) + n0(r[0].abandoned) : null
  },
  c22: {
    views: ["vw_insight_2_2"],
    meta: { statuses: "all months held", n: null, run: "", locked: false },
    build: ([rows]) => {
      const max = maxOf(rows, "leads") || 1;
      return rows.map((r) => ({
        label: monthLabel(r.mth),
        note: `${fmtInt(num(r.leads))} leads \xB7 ${fmtInt(num(r.won))} since won \xB7 ${fmtGbp(
          num(r.won_value) ?? 0
        )}`,
        segments: [
          { widthPct: n0(r.leads) / max * 100, color: L },
          { widthPct: n0(r.won) / max * 100, color: G }
        ].filter((s) => s.widthPct > 0)
      }));
    },
    sample: ([r]) => sum(r, "leads")
  },
  c24: {
    views: ["vw_insight_2_4"],
    meta: { statuses: "all statuses", n: null, run: "", locked: false },
    build: ([rows]) => stacked(
      rows.map((r) => ({
        label: r.rep_account,
        vals: [n0(r.won), n0(r.reached_quote) - n0(r.won), n0(r.deals) - n0(r.reached_quote)],
        note: (r.won_per_closed_pct == null ? "no closed deals" : `${Number(r.won_per_closed_pct)}% win`) + ` \xB7 ${Number(r.pct_reach_quote ?? 0)}% reach quote \xB7 ${n0(r.deals)} deals`
      })),
      [G, S, L],
      maxOf(rows, "deals") || 1
    ),
    sample: ([r]) => sum(r, "deals")
  },
  c25: {
    views: ["vw_insight_2_5"],
    meta: { statuses: "won + lost + abandoned", n: null, run: "", locked: false },
    build: ([rows]) => pctBars(
      rows.map((r) => ({
        label: r.rep_account,
        parts: [num(r.qualifying_pct), num(r.closing_pct)],
        note: `${Number(r.qualifying_pct ?? 0)}% qualifying \xB7 ${Number(
          r.closing_pct ?? 0
        )}% closing \xB7 ${fmtInt(num(r.closed))} closed deals`
      })),
      [G, S]
    ),
    sample: ([r]) => sum(r, "closed")
  },
  // ---- 3 Lead Source & Attribution ---------------------------------------
  c35a: {
    views: ["vw_insight_3_5_a"],
    meta: { statuses: "won", n: null, run: "", locked: false },
    build: ([rows]) => stacked(
      [...rows].sort((a, b) => n0(b.won_value) - n0(a.won_value)).map((r) => {
        const notARoute = /no intake text|hand/i.test(String(r.route));
        const value = num(r.won_value);
        return {
          label: routeLabel(r, rows),
          vals: notARoute ? [null, value ?? 0] : [value],
          note: (value == null || value === 0 ? "no won value" : fmtGbp(value)) + ` \xB7 ${n0(r.won)} won of ${n0(r.deals)}` + (r.won_per_closed_pct == null ? "" : ` \xB7 ${Number(r.won_per_closed_pct)}%`)
        };
      }),
      [G, L]
    ),
    sample: ([r]) => sum(r, "deals")
  },
  c37: {
    views: ["vw_insight_3_7"],
    meta: { statuses: "won", n: null, run: "", locked: false },
    build: ([all]) => {
      const rows = bySplit(all, "by system route");
      const max = maxOf(rows, "max_days") || 1;
      return rows.map((r) => {
        const med = n0(r.median_days);
        const lo = n0(r.min_days);
        const hi = n0(r.max_days);
        return {
          label: r.grp,
          note: `${med}d median \xB7 ${lo}\u2013${hi}d range \xB7 ${n0(r.won)} won`,
          segments: [
            { widthPct: lo / max * 100, color: "transparent", transparent: true },
            { widthPct: (med - lo) / max * 100, color: G },
            {
              widthPct: (hi - med) / max * 100,
              color: L,
              borderLeft: "2px solid #124d39"
            }
          ].filter((s) => s.widthPct > 0)
        };
      });
    },
    sample: ([all]) => sum(bySplit(all, "by system route"), "won")
  },
  c38: {
    views: ["vw_insight_3_8"],
    meta: { statuses: "lost + abandoned", n: null, run: "", locked: false },
    build: ([all]) => {
      const rows = bySplit(all, "by system route");
      const cols = [S, MID, V, L, G];
      const keys = [
        "died_pre_qualification",
        "died_pre_quote",
        "died_at_quote",
        "died_at_negotiation",
        "won"
      ];
      const max = rows.reduce((m, r) => Math.max(m, keys.reduce((a, k) => a + n0(r[k]), 0)), 0) || 1;
      return rows.map((r) => {
        const tot = keys.reduce((a, k) => a + n0(r[k]), 0);
        return {
          label: r.grp,
          note: `${tot} deals`,
          segments: keys.flatMap(
            (k, i) => n0(r[k]) > 0 ? [{ widthPct: n0(r[k]) / max * 100, color: cols[i] }] : []
          )
        };
      });
    },
    sample: ([all]) => sum(bySplit(all, "by system route"), "closed_no_win")
  },
  // ---- 4 Speed to Lead & Follow-up ---------------------------------------
  c41: {
    views: ["vw_insight_4_1"],
    meta: { statuses: "won + lost + abandoned", n: null, run: "", locked: false },
    // The view answers in six buckets; the card asks a three-way question.
    build: ([rows]) => {
      const groups = [
        ["Within 1 hour", ["a. within 5 min", "b. 5-60 min"]],
        ["After 1 hour", ["c. 1-24 hours", "d. 1-3 days", "e. over 3 days"]],
        ["Never replied in writing", ["f. never replied in writing"]]
      ];
      return stacked(
        groups.map(([label, buckets]) => {
          const set = rows.filter((r) => buckets.includes(String(r.bucket)));
          const deals = sum(set, "deals");
          const won = sum(set, "won");
          const rate = deals ? Math.round(won / deals * 100) : 0;
          return {
            label,
            vals: [rate],
            note: `${rate}% \xB7 ${won} won of ${deals}`
          };
        }),
        [G],
        100
      );
    },
    sample: ([r]) => sum(r, "deals")
  },
  c42: {
    views: ["vw_insight_4_2"],
    meta: { statuses: "all statuses", n: null, run: "", locked: false },
    build: ([rows]) => medianTail(
      rows.map((r) => ({
        label: r.rep_account,
        median: num(r.median_hours),
        tail: num(r.p90_hours),
        note: `${Number(r.median_hours ?? 0)}h median \xB7 ${Number(
          r.p90_hours ?? 0
        )}h p90 \xB7 ${Number(r.pct_within_1h ?? 0)}% within the hour \xB7 ${fmtInt(num(r.replies))} replies`
      })),
      maxOf(rows, "p90_hours")
    ),
    sample: ([r]) => sum(r, "replies")
  },
  c43a: {
    views: ["vw_insight_4_3_a"],
    meta: { statuses: "open only", n: null, run: "", locked: true },
    build: ([rows]) => {
      const r = rows[0];
      if (!r) return [];
      return stacked(
        [
          ["Open deals", r.open_deals],
          ["No written reply ever", r.no_written_reply_ever],
          ["Customer wrote, we did not", r.customer_wrote_no_reply],
          ["No reply, older than 7 days", r.no_reply_7d_plus]
        ].map(([label, v]) => ({
          label: String(label),
          vals: [num(v)],
          note: fmtInt(num(v))
        })),
        [S]
      );
    },
    sample: ([r]) => r[0] ? n0(r[0].open_deals) : null
  },
  c44: {
    views: ["vw_insight_4_4"],
    meta: { statuses: "open only", n: null, run: "", locked: true },
    build: ([rows]) => stacked(
      rows.map((r) => {
        const open = n0(r.open_deals);
        const idle60 = n0(r.d60_plus);
        const idle30 = n0(r.d30_59) + idle60;
        return {
          label: r.stage,
          vals: [idle60, idle30 - idle60, open - idle30],
          note: `${idle30} of ${open} idle 30+ \xB7 median ${n0(r.median_idle_days)}d \xB7 ${fmtGbp(
            num(r.value_idle_30plus) ?? 0
          )}`
        };
      }),
      [S, G, L]
    ),
    sample: ([r]) => sum(r, "open_deals")
  },
  c45: {
    views: ["vw_insight_4_5"],
    meta: { statuses: "won + lost + abandoned", n: null, run: "", locked: false },
    build: ([rows]) => {
      const max = Math.max(maxOf(rows, "median_inbound"), maxOf(rows, "median_outbound")) || 1;
      return rows.map((r) => ({
        label: String(r.status).charAt(0).toUpperCase() + String(r.status).slice(1),
        note: `${n0(r.median_inbound)} from customer \xB7 ${n0(
          r.median_outbound
        )} from us \xB7 ${n0(r.with_customer_msg)} of ${n0(r.deals)} deals readable`,
        segments: [
          { widthPct: n0(r.median_inbound) / max * 100, color: G },
          { widthPct: n0(r.median_outbound) / max * 100, color: S }
        ].filter((s) => s.widthPct > 0)
      }));
    },
    sample: ([r]) => sum(r, "deals")
  },
  // ---- 5 Objections & Bottlenecks ----------------------------------------
  c51: {
    views: ["vw_insight_5_1"],
    meta: { statuses: "lost + abandoned", n: null, run: "", locked: false },
    build: ([rows]) => medianTail(
      rows.map((r) => ({
        label: r.longest_stage,
        median: num(r.median_days),
        tail: num(r.p90_days),
        note: `${Number(r.median_days ?? 0)}d median \xB7 ${Number(
          r.p90_days ?? 0
        )}d p90 \xB7 ${n0(r.deals)} deals`
      })),
      maxOf(rows, "p90_days")
    ),
    sample: ([r]) => sum(r, "deals")
  },
  // ---- 6 Buyer Type & Product --------------------------------------------
  c61: {
    views: ["vw_insight_6_1"],
    meta: { statuses: "won + lost + abandoned", n: null, run: "", locked: false },
    build: ([rows]) => stacked(
      rows.map((r) => {
        const deals = n0(r.deals);
        const quoted = n0(r.reached_quote);
        const deposit = n0(r.reached_deposit);
        const won = n0(r.won);
        return {
          label: r.buyer_type,
          vals: [won, deposit, Math.max(0, quoted - deposit - won), deals - quoted],
          note: `${deals} deals \xB7 ${quoted} quoted \xB7 ${won} won \xB7 ${Number(
            r.won_per_closed_pct ?? 0
          )}% win`
        };
      }),
      [G, S, V, L],
      maxOf(rows, "deals") || 1
    ),
    sample: ([r]) => sum(r, "deals")
  },
  c62: {
    views: ["vw_insight_6_2"],
    meta: { statuses: "all statuses", n: null, run: "", locked: false },
    build: ([rows]) => rows.map((r) => ({
      label: r.buyer_type,
      separate: true,
      note: `${Number(r.pct_of_typed_leads ?? 0)}% of leads \xB7 ${r.pct_of_typed_won_value == null ? "no won value" : `${Number(r.pct_of_typed_won_value)}% of value`} \xB7 ${n0(r.deals)} deals`,
      segments: [
        { widthPct: n0(r.pct_of_typed_leads), color: S },
        { widthPct: n0(r.pct_of_typed_won_value), color: G }
      ].filter((s) => s.widthPct > 0)
    })),
    sample: ([r]) => sum(r, "deals")
  },
  c63a: {
    views: ["vw_insight_6_3_a"],
    meta: { statuses: "won + lost + abandoned", n: null, run: "", locked: false },
    build: ([rows]) => {
      const r = rows[0];
      if (!r) return [];
      return stacked(
        [
          ["Deals", r.deals],
          ["Product type recorded", r.has_product_type],
          ["Won", r.won],
          ["Won with product type", r.won_with_type]
        ].map(([label, v]) => ({ label: String(label), vals: [num(v)], note: fmtInt(num(v)) })),
        [S]
      );
    },
    sample: ([r]) => r[0] ? n0(r[0].has_product_type) : null
  },
  c63b: {
    views: ["vw_insight_6_3_b"],
    meta: { statuses: "won + lost + abandoned", n: null, run: "", locked: false },
    build: ([rows]) => stacked(
      rows.map((r) => ({
        label: r.product_type,
        vals: [num(r.won_value)],
        note: (r.won_value == null ? "no won value" : fmtGbp(num(r.won_value))) + ` \xB7 ${n0(r.won)} won of ${n0(r.deals)}` + (n0(r.deals) < 8 ? " \xB7 too few to read" : "")
      })),
      [G]
    ),
    sample: ([r]) => sum(r, "deals")
  },
  // ---- 8 Sales Discipline -------------------------------------------------
  c81: {
    views: ["vw_insight_8_1"],
    meta: { statuses: "open only", n: null, run: "", locked: true },
    build: ([rows]) => stacked(
      rows.map((r) => ({
        label: r.stage,
        vals: [n0(r.no_open_task), n0(r.open_deals) - n0(r.no_open_task)],
        note: `${n0(r.no_open_task)} of ${n0(r.open_deals)} \xB7 ${fmtGbp(
          num(r.value_no_task) ?? 0
        )} with no task`
      })),
      [S, L]
    ),
    sample: ([r]) => sum(r, "open_deals")
  },
  c82b: {
    views: ["vw_insight_8_2_b"],
    meta: { statuses: "open only", n: null, run: "", locked: true },
    build: ([rows]) => stacked(
      rows.map((r) => ({
        label: r.stage,
        vals: [n0(r.no_notes), n0(r.open_deals) - n0(r.no_notes)],
        note: `${n0(r.no_notes)} of ${n0(r.open_deals)} \xB7 ${fmtGbp(
          num(r.value_no_notes) ?? 0
        )}`
      })),
      [S, L]
    ),
    sample: ([r]) => sum(r, "open_deals")
  },
  c83a: {
    views: ["vw_insight_8_3"],
    meta: { statuses: "open only", n: null, run: "", locked: true },
    build: ([rows]) => {
      const r = rows[0];
      if (!r) return [];
      return stacked(
        [
          ["0\u20131 fields", r.score_0_1],
          ["2 fields", r.score_2],
          ["3 fields", r.score_3],
          ["4 fields", r.score_4],
          ["5 fields", r.score_5],
          ["6 fields", r.score_6]
        ].map(([label, v]) => ({
          label: String(label),
          vals: [num(v)],
          note: `${fmtInt(num(v))} deals`
        })),
        [S]
      );
    },
    sample: ([r]) => r[0] ? n0(r[0].open_deals) : null
  },
  c84: {
    views: ["vw_insight_8_4"],
    meta: { statuses: "open only", n: null, run: "", locked: true },
    build: () => [],
    heat: ([rows]) => {
      const keys = ["missing_value", "missing_source", "missing_buyer", "missing_product"];
      const max = rows.reduce((m, r) => Math.max(m, ...keys.map((k) => n0(r[k]))), 0) || 1;
      return rows.map((r) => ({
        label: r.rep_account,
        cells: keys.map((k) => ({ value: n0(r[k]), max })),
        note: `${Number(r.pct_of_4_filled ?? 0)}% of the four fields filled \xB7 ${fmtGbp(
          num(r.value_missing_buyer) ?? 0
        )} with no buyer type`
      }));
    },
    sample: ([r]) => sum(r, "open_deals")
  },
  c85: {
    views: ["vw_insight_8_5"],
    meta: { statuses: "open only", n: null, run: "", locked: true },
    build: ([rows]) => pctBars(
      rows.map((r) => ({
        label: r.rep_account,
        parts: [
          num(r.pct_with_next_action),
          num(r.pct_with_a_note),
          num(r.pct_with_assigned_msgs)
        ],
        note: `${Number(r.pct_with_next_action ?? 0)}% action \xB7 ${Number(
          r.pct_with_a_note ?? 0
        )}% note \xB7 ${Number(r.pct_with_assigned_msgs ?? 0)}% messages \xB7 ${n0(
          r.open_deals
        )} open`
      })),
      [G, S, L]
    ),
    sample: ([r]) => sum(r, "open_deals")
  }
};
function bySplit(rows, split) {
  const picked = rows.filter((r) => r.split === split);
  return picked.length ? picked : rows;
}
function monthLabel(mth) {
  const [y, m] = String(mth).split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m) - 1] ?? m} ${y}`;
}
export {
  CHARTS
};
