-- 135_insight_views.sql
--
-- The 27 views behind the Insights tab — the BGD insight set, ported from the
-- InsightsHub prototype so the dashboard reads them through our own API
-- instead of hitting Supabase from the browser.
--
-- ── WHAT CHANGED FROM THE PROTOTYPE ──────────────────────────────────
--
-- The SQL itself is the prototype's, which is the tracker's, verbatim. Four
-- mechanical edits, each verified against a database built from this repo's
-- own migrations before being written here:
--
--   1. THE BRAND DECODE IS GONE. Every view ended in
--        case location_id when 'IFcSg4...' then 'BGD' ... end as brand
--      (or, in two of them, an inner join to a four-row lookup CTE). That
--      hardcodes the sub-accounts: a new location returns NULL brand and its
--      rows silently vanish, and the CTE form drops them by inner join. The
--      views now return raw location_id and the ROUTE applies
--      `WHERE location_id = $1` from the session — the same boundary every
--      other read in this app uses.
--
--   2. security_invoker = true on all 27. Mandatory here (see
--      skillValidator.js): without it a view runs as its owner and ignores
--      RLS. It also means these can later be registered as AI skills.
--
--   3. Named vw_insight_<n>_<n>, in public, matching every other view here.
--
--   4. Nothing else. Where a prototype query was wrong, it is still wrong —
--      fixing it here would make this file disagree with the tracker, which
--      is the one thing the handoff asks it not to do.
--
-- ── FOUR THINGS THAT BIT DURING THE PORT ─────────────────────────────
--
-- Recorded because each produced a view that LOOKED fine:
--
--   * `order by brand` outlives the alias — the view will not create.
--   * `pct_of_brand` is a column NAME, not a reference to the alias. A
--     word-boundary replace renamed it to pct_of_location_id.
--   * 'Email - Enquiries@ (brand inbox)' is DISPLAYED text. Rewriting it
--     corrupts a label a rep reads. String literals must be masked before
--     any identifier rewrite.
--   * The lookup CTE is the LAST in its chain, so removing it leaves a
--     dangling comma before the final select.
--
-- 27 of 27 create, all carry security_invoker, all expose location_id, and
-- none mentions a hardcoded location. Tenant isolation was checked with rows
-- in two locations: each sees only its own.

create or replace view public.vw_insight_1_1
  with (security_invoker = true) as
with closed as (
  select opportunity_id, status, location_id
  from opportunities
  where deleted_at is null and is_ghost = false and status in ('lost','abandoned')
),
final_stage as (
  select opportunity_id, stage_name
  from stage_history where current_stage and not deleted and not ghost_opportunity
),
g as (
  select c.location_id,
         coalesce(initcap(lower(f.stage_name)), '(no stage row)') as stage_name,
         count(*) as closed_without_win,
         count(*) filter (where c.status = 'lost')      as lost,
         count(*) filter (where c.status = 'abandoned') as abandoned
  from closed c left join final_stage f on f.opportunity_id = c.opportunity_id
  group by c.location_id, 2
)
select location_id,
       stage_name, closed_without_win, lost, abandoned,
       round(100.0 * closed_without_win / sum(closed_without_win) over (partition by location_id), 1) as pct_of_brand
from g order by location_id, closed_without_win desc;

create or replace view public.vw_insight_1_3
  with (security_invoker = true) as
with live_deals as (
  select opportunity_id, status, location_id
  from opportunities where deleted_at is null and is_ghost = false
),
stage_order(stage_name, ord) as (values
  ('marketing qualified',1),('initial contact made',2),('sales qualified',3),
  ('waiting on details',4),('quote sent',5),('negotiation',6),('deposit & sales contract',7)
),
deal_max as (
  select s.opportunity_id, d.status, d.location_id, max(o.ord) as max_ord
  from stage_history s
  join live_deals d on d.opportunity_id = s.opportunity_id
  join stage_order o on o.stage_name = lower(s.stage_name)
  where not s.deleted and not s.ghost_opportunity and coalesce(s.closed_reason,'') <> 'correction'
  group by s.opportunity_id, d.status, d.location_id
),
funnel as (
  select m.location_id, o.ord, o.stage_name,
         count(*) filter (where m.max_ord >= o.ord) as reached,
         count(*) filter (where m.max_ord >= o.ord and m.status = 'won')  as won,
         count(*) filter (where m.max_ord >= o.ord and m.status = 'open') as still_open,
         count(*) filter (where m.max_ord =  o.ord and m.status in ('lost','abandoned')) as died_here
  from stage_order o cross join deal_max m
  group by m.location_id, o.ord, o.stage_name
)
select location_id,
       ord, initcap(stage_name) as stage, reached, won, still_open, died_here,
       round(100.0 * lead(reached) over (partition by location_id order by ord) / nullif(reached,0), 1) as pct_to_next,
       round(100.0 * won / nullif(reached,0), 1) as pct_won_from_here
from funnel order by location_id, ord;

create or replace view public.vw_insight_1_4
  with (security_invoker = true) as
with closed as (
  select opportunity_id, status, location_id
  from opportunities
  where deleted_at is null and is_ghost = false and status in ('lost','abandoned')
),
final_stage as (
  select opportunity_id, stage_name
  from stage_history where current_stage and not deleted and not ghost_opportunity
)
select c.location_id,
       coalesce(initcap(lower(f.stage_name)), '(no stage row)') as stage_name,
       count(*) as closed_without_win,
       count(*) filter (where c.status = 'lost')      as lost,
       count(*) filter (where c.status = 'abandoned') as abandoned,
       round(100.0 * count(*) filter (where c.status = 'abandoned') / count(*), 1) as pct_abandoned
from closed c left join final_stage f on f.opportunity_id = c.opportunity_id
group by c.location_id, 2
order by location_id, closed_without_win desc;

create or replace view public.vw_insight_1_5_a
  with (security_invoker = true) as
with closed as (
  select o.opportunity_id, o.status, o.location_id,
         coalesce(initcap(lower(s.stage_name)), '(none)') as stage,
         nullif(o.meddic_9,'') as reason
  from opportunities o
  left join stage_history s on s.opportunity_id = o.opportunity_id and s.current_stage and not s.deleted and not s.ghost_opportunity
  where o.deleted_at is null and o.is_ghost = false and o.status in ('lost','abandoned')
)
select location_id,
       stage, count(*) as deals, count(reason) as reason_filled,
       round(100.0 * count(reason) / count(*), 0) as pct_filled
from closed group by location_id, stage order by location_id, deals desc;

create or replace view public.vw_insight_1_5_b
  with (security_invoker = true) as
with closed as (
  select o.location_id, o.status, lower(nullif(o.meddic_9,'')) as t
  from opportunities o
  where o.deleted_at is null and o.is_ghost = false and o.status in ('lost','abandoned') and nullif(o.meddic_9,'') is not null
),
themed as (
  select *, case
    when t ~ '(never heard|no respon|not respon|didn.t respond|chased|no reply|gone quiet|went quiet|unresponsive)' then 'No response from customer'
    when t ~ '(cheaper|too expensive|expensive|budget|price|cost|out of our|more than other)' then 'Price'
    when t ~ '(went with|chose|decided to go|going with|preferred|another supplier|alternative supplier|local firm|fabco|schuco|timber|other compan)' then 'Went with another supplier / product'
    when t ~ '(minimum order|min\. order|below min|too small|one window|1 aluminium)' then 'Below minimum order'
    when t ~ '(don.t do|cant make|can.t make|not something we|not our|we don.t|outside|out of area|too far)' then 'Out of scope / cannot supply'
    when t ~ '(didn.t remember|didnt remember|spam|not a real|wrong number|test)' then 'Junk / not a real enquiry'
    when t ~ '(project (on hold|cancel|abort|postpon)|no longer|not going ahead|planning|abort)' then 'Project stopped or delayed'
    else 'Other / unclear' end as theme
  from closed
)
select location_id,
       theme, count(*) as deals,
       count(*) filter (where status = 'lost') as lost, count(*) filter (where status = 'abandoned') as abandoned
from themed group by location_id, theme order by location_id, deals desc;

create or replace view public.vw_insight_2_1
  with (security_invoker = true) as
with d as (
  select o.location_id, o.status, o.created_at_ghl, o.monetary_value,
         exists (select 1 from stage_history s
                 where s.opportunity_id = o.opportunity_id and s.current_stage and not s.deleted and not s.ghost_opportunity
                   and lower(s.stage_name) in ('new lead','disqualified')) as at_intake
  from opportunities o
  where o.deleted_at is null and o.is_ghost = false
)
select location_id,
       count(*) as leads,
       count(*) filter (where status = 'won')       as won,
       count(*) filter (where status = 'lost')      as lost,
       count(*) filter (where status = 'abandoned') as abandoned,
       count(*) filter (where status = 'open')      as open,
       count(*) filter (where status = 'lost' and at_intake) as lost_at_intake,
       round(100.0 * count(*) filter (where status = 'won') / count(*), 1) as won_per_lead_pct,
       round(100.0 * count(*) filter (where status = 'won')
             / nullif(count(*) filter (where status in ('won','lost','abandoned')), 0), 1) as won_per_closed_pct,
       round(100.0 * count(*) filter (where status = 'won')
             / nullif(count(*) filter (where status in ('won','lost','abandoned') and not (status = 'lost' and at_intake)), 0), 1) as won_per_closed_excl_junk_pct,
       min(created_at_ghl)::date as first_lead, max(created_at_ghl)::date as last_lead,
       sum(monetary_value) filter (where status = 'won') as won_value
from d group by location_id order by leads desc;

create or replace view public.vw_insight_2_2
  with (security_invoker = true) as
with d as (
  select location_id, status, created_at_ghl, monetary_value, date_trunc('month', created_at_ghl) as mth
  from opportunities where deleted_at is null and is_ghost = false
),
monthly as (
  select location_id, mth, count(*) as leads,
         count(*) filter (where status = 'won') as won,
         sum(monetary_value) filter (where status = 'won') as won_value
  from d
  where mth >= date_trunc('month', now()) - interval '4 months' and mth < date_trunc('month', now())
  group by 1,2
),
overall as (
  select location_id, count(*) as leads, count(*) filter (where status = 'won') as won,
         round(avg(monetary_value) filter (where status = 'won' and monetary_value > 0)) as avg_won_value,
         count(*) filter (where status = 'won' and monetary_value > 0) as won_with_value
  from d group by 1
)
select m.location_id,
       to_char(m.mth, 'YYYY-MM') as mth, m.leads, m.won, m.won_value,
       o.avg_won_value, o.won_with_value,
       round(100.0 * o.won / o.leads, 1) as won_per_lead_pct_all_time
from monthly m join overall o on o.location_id = m.location_id
order by location_id, mth;

create or replace view public.vw_insight_2_4
  with (security_invoker = true) as
with users(user_id, name) as (values
  ('uDQS5uGvQh94iX5y50HS','Charlie Stoyle'), ('94ihRvQZHBVYXvWY0UxY','Charlie Stoyle'), ('dubal5CaysMNDJx4k6Ih','Charlie Stoyle'),
  ('eh9bSjcHEnLall0hSWJi','Liam Griffin'), ('mzC0eKJCiTgWTVJqH8qD','Liam V.Griffin'),
  ('vHikbah2pho52ttBT8vi','Chris Higgs'), ('jADn3ZqU5wZ57UoWIYGh','Chris Higgs'),
  ('Gz8mgWyAOudVtbHVE7P9','Chris Spilsbury (left)'), ('UqNYn69BwMEzol7BKwzI','Ollie Dawe'),
  ('sDCg3T33E5p6w53anGev','Brad Ricardo'), ('oR1IEM4FEJPOqKV1XHA6','Ella Clayden'),
  ('PKM1H7XH94UdBt83pBoY','Enquiries inbox'), ('dEPA0LulVM1NzmxTnuQy','Enquiries inbox'),
  ('IVFiYy3sAEY3tjPLNOnC','Madi (marketing)'), ('KOqRV289cGSPxYlmDO4m','EGJ'), ('aoYdS7Lr4U0shmG8x1dU','EGJ'), ('ip1ntH3jgVwe7SfsRnXh','EGJ')
),
live as (
  select opportunity_id, location_id, status, assigned_to, monetary_value
  from opportunities where deleted_at is null and is_ghost = false
),
so(stage_name, ord) as (values
  ('marketing qualified',1),('initial contact made',2),('sales qualified',3),
  ('waiting on details',4),('quote sent',5),('negotiation',6),('deposit & sales contract',7)
),
dm as (
  select l.opportunity_id, l.location_id, l.status, l.assigned_to, l.monetary_value, max(so.ord) as max_ord
  from live l
  left join stage_history s on s.opportunity_id = l.opportunity_id and not s.deleted and not s.ghost_opportunity and coalesce(s.closed_reason,'') <> 'correction'
  left join so on so.stage_name = lower(s.stage_name)
  group by 1,2,3,4,5
)
select dm.location_id,
       coalesce(u.name, coalesce(dm.assigned_to, '(unassigned)')) as rep_account,
       count(*) as deals,
       count(*) filter (where status = 'won')       as won,
       count(*) filter (where status = 'lost')      as lost,
       count(*) filter (where status = 'abandoned') as abandoned,
       count(*) filter (where status = 'open')      as open,
       count(*) filter (where max_ord >= 5) as reached_quote,
       count(*) filter (where max_ord >= 6) as reached_negotiation,
       round(100.0 * count(*) filter (where status = 'won') / nullif(count(*) filter (where status in ('won','lost','abandoned')), 0), 0) as won_per_closed_pct,
       round(100.0 * count(*) filter (where max_ord >= 5) / count(*), 0) as pct_reach_quote,
       round(100.0 * count(*) filter (where status = 'won') / nullif(count(*) filter (where max_ord >= 5 and status <> 'open'), 0), 0) as won_per_closed_quoted_pct,
       round(avg(monetary_value) filter (where status = 'won')) as avg_won_value
from dm left join users u on u.user_id = dm.assigned_to
group by dm.location_id, coalesce(u.name, coalesce(dm.assigned_to, '(unassigned)'))
having count(*) >= 5
order by location_id, deals desc;

create or replace view public.vw_insight_2_5
  with (security_invoker = true) as
with users(user_id, name) as (values
  ('eh9bSjcHEnLall0hSWJi','Liam Griffin'), ('mzC0eKJCiTgWTVJqH8qD','Liam V.Griffin'),
  ('vHikbah2pho52ttBT8vi','Chris Higgs'), ('jADn3ZqU5wZ57UoWIYGh','Chris Higgs'),
  ('Gz8mgWyAOudVtbHVE7P9','Chris Spilsbury (left)'), ('UqNYn69BwMEzol7BKwzI','Ollie Dawe'),
  ('sDCg3T33E5p6w53anGev','Brad Ricardo'), ('oR1IEM4FEJPOqKV1XHA6','Ella Clayden')
),
so(stage_name, ord) as (values
  ('marketing qualified',1),('initial contact made',2),('sales qualified',3),
  ('waiting on details',4),('quote sent',5),('negotiation',6),('deposit & sales contract',7)
),
dm as (
  select o.opportunity_id, o.location_id, o.status, o.assigned_to, max(so.ord) as max_ord
  from opportunities o
  left join stage_history s on s.opportunity_id = o.opportunity_id and not s.deleted and not s.ghost_opportunity and coalesce(s.closed_reason,'') <> 'correction'
  left join so on so.stage_name = lower(s.stage_name)
  where o.deleted_at is null and o.is_ghost = false and o.status in ('won','lost','abandoned')
  group by 1,2,3,4
)
select dm.location_id,
       u.name as rep_account,
       count(*) as closed,
       count(*) filter (where coalesce(max_ord,0) < 5)  as died_before_quote,
       count(*) filter (where coalesce(max_ord,0) >= 5) as closed_after_quote,
       count(*) filter (where status = 'won') as won,
       round(100.0 * count(*) filter (where coalesce(max_ord,0) >= 5) / count(*), 0) as qualifying_pct,
       round(100.0 * count(*) filter (where status = 'won') / nullif(count(*) filter (where coalesce(max_ord,0) >= 5), 0), 0) as closing_pct
from dm join users u on u.user_id = dm.assigned_to
group by dm.location_id, u.name
having count(*) >= 5
order by location_id, closed desc;

create or replace view public.vw_insight_3_5_a
  with (security_invoker = true) as
-- 3.5 v2 Closed-Won value by lead source — PER SUB-ACCOUNT
-- Two views of the same deals. Read-only.
-- SYSTEM ROUTE: which of the four enquiry-text fields on the contact is filled. Written by GHL when the enquiry arrives. None = no automated route (phone, referral, walk-in, rep-entered).
-- REP-RECORDED SOURCE: opportunities.lead_source_opportunity, the picklist a rep ticks. EVERY value listed, all deals. Stored inconsistently ({"A"}, {"A","B"}, A, A, B) — braces/quotes stripped, split on comma, sorted, joined ' + ' so a two-source deal is one row.
-- Label normalisation: 'Email - Enqui%' → 'Email - Enquiries@ (brand inbox)'; 'Google Search%' → 'Google Search Organic'; bare 'Website' → 'Website (retired option)'.

-- ===== SYSTEM ROUTE: route × paid/free =====
with d as (
  select o.opportunity_id, o.location_id, o.status, o.monetary_value,
         (nullif(o.gclid,'') is not null or nullif(c.gclid,'') is not null
          or nullif(c.gbraid,'') is not null or nullif(c.wbraid,'') is not null) as paid,
         case when nullif(c.leadform_enquiry_text,'')        is not null then 'website form'
              when nullif(c.webchat_inquiry_text,'')         is not null then 'webchat'
              when nullif(c.enquiries_email_inquiry_text,'') is not null then 'enquiries@ inbox'
              when nullif(c.crittall_email_inquiry_text,'')  is not null then 'crittall email upload'
              else '(no intake text)' end as route
  from opportunities o
  left join contacts c on c.contact_id = o.contact_id and c.location_id = o.location_id
  where o.deleted_at is null and o.is_ghost = false
)
select location_id,
       case when paid then 'paid (click id)' else 'free' end as paid_or_free,
       route,
       count(*) as deals,
       count(*) filter (where status = 'won') as won,
       count(*) filter (where status in ('lost','abandoned')) as lost_ab,
       count(*) filter (where status = 'open') as open,
       sum(monetary_value) filter (where status = 'won') as won_value,
       round(100.0 * count(*) filter (where status = 'won') / nullif(count(*) filter (where status <> 'open'), 0), 0) as won_per_closed_pct
from d group by location_id, paid, route order by location_id, paid_or_free, deals desc;

create or replace view public.vw_insight_3_7
  with (security_invoker = true) as
-- 3.7 v2 Time from enquiry to won deal, by lead source — PER SUB-ACCOUNT
-- Won deals only. Days = won_at - created_at_ghl. Two splits: REP-RECORDED SOURCE (every lead_source_opportunity value, normalised as in 3.5) and SYSTEM ROUTE (which enquiry-text field is filled). Read-only.
with norm as (
  select o.*,
         coalesce(nullif(array_to_string(array(
           select case when v ilike 'email - enqui%' then 'Email - Enquiries@ (brand inbox)'
                       when v ilike 'google search%' then 'Google Search Organic'
                       when v = 'Website' then 'Website (retired option)' else v end
           from unnest(string_to_array(regexp_replace(regexp_replace(coalesce(o.lead_source_opportunity,''), '[{}"]', '', 'g'), ',\s*', ',', 'g'), ',')) v
           where v <> '' order by 1), ' + '), ''), '(lead source blank)') as rep_source
  from opportunities o where o.deleted_at is null and o.is_ghost = false
),
d as (
  select n.location_id, extract(epoch from n.won_at - n.created_at_ghl)/86400 as days, n.rep_source,
         case when nullif(c.leadform_enquiry_text,'') is not null then 'website form'
              when nullif(c.webchat_inquiry_text,'') is not null then 'webchat'
              when nullif(c.enquiries_email_inquiry_text,'') is not null then 'enquiries@ inbox'
              when nullif(c.crittall_email_inquiry_text,'') is not null then 'crittall email upload'
              else '(created by hand)' end as route
  from norm n left join contacts c on c.contact_id = n.contact_id and c.location_id = n.location_id
  where n.status='won' and n.won_at is not null
)

select location_id, 'by rep-recorded source' as split, rep_source as grp, count(*) as won,
       round(percentile_cont(0.5) within group (order by days)::numeric,0) as median_days,
       round(min(days)::numeric,0) as min_days, round(max(days)::numeric,0) as max_days,
       count(*) filter (where days<1) as same_day
from d  group by location_id, rep_source
union all
select location_id, 'by system route', route, count(*),
       round(percentile_cont(0.5) within group (order by days)::numeric,0),
       round(min(days)::numeric,0), round(max(days)::numeric,0), count(*) filter (where days<1)
from d  group by location_id, route
order by 1,2, won desc;

create or replace view public.vw_insight_3_8
  with (security_invoker = true) as
-- 3.8 v2 Which sources fail at which stage — PER SUB-ACCOUNT
-- Two splits: SYSTEM ROUTE (which enquiry-text field is filled on the contact) and REP-RECORDED SOURCE (every lead_source_opportunity value, normalised as in 3.5). Failure point = furthest stage the deal reached before closing without a win. Read-only.
with so(stage_name, ord) as (values ('new lead',0),('marketing qualified',1),('initial contact made',2),('sales qualified',3),('waiting on details',4),('quote sent',5),('negotiation',6),('deposit & sales contract',7)),
norm as (
  select o.*,
         coalesce(nullif(array_to_string(array(
           select case when v ilike 'email - enqui%' then 'Email - Enquiries@ (brand inbox)'
                       when v ilike 'google search%' then 'Google Search Organic'
                       when v = 'Website' then 'Website (retired option)' else v end
           from unnest(string_to_array(regexp_replace(regexp_replace(coalesce(o.lead_source_opportunity,''), '[{}"]', '', 'g'), ',\s*', ',', 'g'), ',')) v
           where v <> '' order by 1), ' + '), ''), '(lead source blank)') as rep_source
  from opportunities o where o.deleted_at is null and o.is_ghost = false
),
d as (
  select n.opportunity_id, n.location_id, n.status, n.rep_source,
         case when nullif(c.leadform_enquiry_text,'') is not null then 'website form'
              when nullif(c.webchat_inquiry_text,'') is not null then 'webchat'
              when nullif(c.enquiries_email_inquiry_text,'') is not null then 'enquiries@ inbox'
              when nullif(c.crittall_email_inquiry_text,'') is not null then 'crittall email upload'
              else 'created by hand' end as route
  from norm n left join contacts c on c.contact_id = n.contact_id and c.location_id = n.location_id
),
mx as (
  select d.*, (select max(so.ord) from stage_history s join so on so.stage_name = lower(s.stage_name)
               where s.opportunity_id = d.opportunity_id and not s.deleted and not s.ghost_opportunity and coalesce(s.closed_reason,'') <> 'correction') as max_ord
  from d
),

agg as (
  select location_id, 'by system route' as split, route as grp, count(*) as deals,
    count(*) filter (where status in ('lost','abandoned')) as closed_no_win,
    count(*) filter (where status in ('lost','abandoned') and coalesce(max_ord,0)<=2) as died_pre_qualification,
    count(*) filter (where status in ('lost','abandoned') and coalesce(max_ord,0) in (3,4)) as died_pre_quote,
    count(*) filter (where status in ('lost','abandoned') and coalesce(max_ord,0)=5) as died_at_quote,
    count(*) filter (where status in ('lost','abandoned') and coalesce(max_ord,0)>=6) as died_at_negotiation,
    count(*) filter (where status='won') as won
  from mx  group by location_id, route
  union all
  select location_id, 'by rep-recorded source', rep_source, count(*),
    count(*) filter (where status in ('lost','abandoned')),
    count(*) filter (where status in ('lost','abandoned') and coalesce(max_ord,0)<=2),
    count(*) filter (where status in ('lost','abandoned') and coalesce(max_ord,0) in (3,4)),
    count(*) filter (where status in ('lost','abandoned') and coalesce(max_ord,0)=5),
    count(*) filter (where status in ('lost','abandoned') and coalesce(max_ord,0)>=6),
    count(*) filter (where status='won')
  from mx  group by location_id, rep_source
)
select * from agg order by location_id, split, deals desc;

create or replace view public.vw_insight_4_1
  with (security_invoker = true) as
-- 4.1 Does a fast first reply change the win rate — PER SUB-ACCOUNT
-- Response time = customer's first written message → first written reply from a person, on the contact within the sub-account.
-- vw_opportunity_flat.first_response_minutes is not used (negative on many deals). Read-only.
with closed as (
  select opportunity_id, contact_id, status, location_id
  from opportunities where deleted_at is null and is_ghost = false and status in ('won','lost','abandoned')
),
first_in as (
  select location_id, contact_id, min(message_timestamp) as t0
  from messages where deleted_at is null and message_direction = 'inbound' and coalesce(message_channel,'') not ilike '%ACTIVITY%'
  group by 1,2
),
first_out as (
  select m.location_id, m.contact_id, min(m.message_timestamp) as t1
  from messages m join first_in f on f.contact_id = m.contact_id and f.location_id = m.location_id
  where m.deleted_at is null and m.message_direction = 'outbound' and coalesce(m.sender_type,'') <> 'automation'
    and coalesce(m.message_channel,'') not ilike '%ACTIVITY%' and m.message_timestamp >= f.t0
  group by 1,2
),
resp as (
  select c.*, extract(epoch from o.t1 - f.t0) / 60 as mins
  from closed c
  join first_in  f on f.contact_id = c.contact_id and f.location_id = c.location_id
  left join first_out o on o.contact_id = c.contact_id and o.location_id = c.location_id
),
b as (
  select *, case when mins is null then 'f. never replied in writing'
                 when mins <= 5    then 'a. within 5 min'
                 when mins <= 60   then 'b. 5-60 min'
                 when mins <= 1440 then 'c. 1-24 hours'
                 when mins <= 4320 then 'd. 1-3 days'
                 else 'e. over 3 days' end as bucket
  from resp
)
select location_id,
       bucket, count(*) as deals,
       count(*) filter (where status = 'won') as won,
       count(*) filter (where status = 'lost') as lost,
       count(*) filter (where status = 'abandoned') as abandoned,
       round(100.0 * count(*) filter (where status = 'won') / count(*), 1) as win_rate_pct
from b group by location_id, bucket order by location_id, bucket;

create or replace view public.vw_insight_4_2
  with (security_invoker = true) as
-- 4.2 Response time by rep — PER SUB-ACCOUNT, PER GHL USER ACCOUNT
-- For every written customer message: time to the next written reply from a named user in the same sub-account, and who sent it.
-- Users are NEVER merged across sub-accounts. Decode names from the CRM User Reference (ClickUp 2kyq8nar-6095); keep both in step. Read-only.
with users(user_id, name) as (values
  ('uDQS5uGvQh94iX5y50HS','Charlie Stoyle'), ('94ihRvQZHBVYXvWY0UxY','Charlie Stoyle'), ('dubal5CaysMNDJx4k6Ih','Charlie Stoyle'),
  ('eh9bSjcHEnLall0hSWJi','Liam Griffin'), ('mzC0eKJCiTgWTVJqH8qD','Liam V.Griffin'),
  ('vHikbah2pho52ttBT8vi','Chris Higgs'), ('jADn3ZqU5wZ57UoWIYGh','Chris Higgs'),
  ('Gz8mgWyAOudVtbHVE7P9','Chris Spilsbury (left)'), ('UqNYn69BwMEzol7BKwzI','Ollie Dawe'),
  ('sDCg3T33E5p6w53anGev','Brad Ricardo'), ('oR1IEM4FEJPOqKV1XHA6','Ella Clayden'),
  ('KOqRV289cGSPxYlmDO4m','EGJ'), ('aoYdS7Lr4U0shmG8x1dU','EGJ'), ('ip1ntH3jgVwe7SfsRnXh','EGJ')
),
msgs as (
  select location_id, contact_id, message_timestamp, message_direction, sender_type, sender_user_id
  from messages where deleted_at is null and coalesce(message_channel,'') not ilike '%ACTIVITY%'
),
reply as (
  select i.location_id, o.sender_user_id as out_user, extract(epoch from o.message_timestamp - i.message_timestamp) / 3600 as hours
  from msgs i
  left join lateral (
    select message_timestamp, sender_user_id from msgs o
    where o.contact_id = i.contact_id and o.location_id = i.location_id
      and o.message_direction = 'outbound' and o.sender_type = 'user' and o.message_timestamp > i.message_timestamp
    order by o.message_timestamp limit 1
  ) o on true
  where i.message_direction = 'inbound' and o.message_timestamp is not null
    and o.message_timestamp - i.message_timestamp < interval '30 days'
)
select r.location_id,
       coalesce(u.name, r.out_user) as rep_account, count(*) as replies,
       round(percentile_cont(0.5) within group (order by hours)::numeric, 1) as median_hours,
       round(percentile_cont(0.9) within group (order by hours)::numeric, 1) as p90_hours,
       round(100.0 * count(*) filter (where hours <= 1)  / count(*), 0) as pct_within_1h,
       round(100.0 * count(*) filter (where hours <= 24) / count(*), 0) as pct_within_24h
from reply r left join users u on u.user_id = r.out_user
group by r.location_id, coalesce(u.name, r.out_user)
order by location_id, replies desc;

create or replace view public.vw_insight_4_3_a
  with (security_invoker = true) as
-- 4.3 Open deals the sales team has never replied to — PER SUB-ACCOUNT
-- Matched on contact_id within the sub-account (all messages to that customer), not on Deal Hub assignment. Read-only.

-- Part A: counts by location_id
with open_deals as (
  select o.opportunity_id, o.contact_id, o.location_id, o.created_at_ghl
  from opportunities o where o.deleted_at is null and o.is_ghost = false and o.status = 'open'
),
msg as (
  select location_id, contact_id,
    count(*) filter (where message_direction = 'outbound' and sender_type = 'user') as human_out,
    count(*) filter (where message_direction = 'outbound' and coalesce(sender_type,'') <> 'automation'
                       and coalesce(message_channel,'') not ilike '%ACTIVITY%') as any_out,
    count(*) filter (where message_direction = 'inbound' and coalesce(message_channel,'') not ilike '%ACTIVITY%') as inbound
  from messages where deleted_at is null group by location_id, contact_id
)
select d.location_id,
  count(*) as open_deals,
  count(*) filter (where coalesce(m.any_out,0) = 0) as no_written_reply_ever,
  count(*) filter (where coalesce(m.any_out,0) = 0 and coalesce(m.inbound,0) > 0) as customer_wrote_no_reply,
  count(*) filter (where coalesce(m.any_out,0) = 0 and d.created_at_ghl < now() - interval '7 days') as no_reply_7d_plus,
  count(*) filter (where coalesce(m.human_out,0) = 0) as no_named_user_reply
from open_deals d left join msg m on m.contact_id = d.contact_id and m.location_id = d.location_id
group by d.location_id order by open_deals desc;

create or replace view public.vw_insight_4_4
  with (security_invoker = true) as
-- 4.4 Open deals gone stagnant — days since last touch, by stage — PER SUB-ACCOUNT
-- Last touch = greatest of: last message either way (contact_id), last stage move, last note, last task, deal created. Calls not included. Read-only.
with open_deals as (
  select o.opportunity_id, o.contact_id, o.location_id, o.created_at_ghl, o.monetary_value, o.assigned_to
  from opportunities o where o.deleted_at is null and o.is_ghost = false and o.status = 'open'
),
last_msg as (
  select location_id, contact_id, max(message_timestamp) as t
  from messages where deleted_at is null and coalesce(message_channel,'') not ilike '%ACTIVITY%' group by 1,2
),
last_stage as (
  select opportunity_id, max(entered_at) as t, max(stage_name) filter (where current_stage) as stage_name
  from stage_history where not deleted and not ghost_opportunity group by opportunity_id
),
last_note as (select contact_id, max(created_at_ghl) as t from notes where deleted_at is null group by contact_id),
last_task as (select contact_id, max(coalesce(completed_at, created_at_ghl)) as t from tasks where deleted_at is null group by contact_id),
touch as (
  select d.*, initcap(lower(coalesce(s.stage_name,'(none)'))) as stage,
         greatest(coalesce(m.t,'1970-01-01'), coalesce(s.t,'1970-01-01'), coalesce(n.t,'1970-01-01'), coalesce(k.t,'1970-01-01'), d.created_at_ghl) as last_touch
  from open_deals d
  left join last_msg   m on m.contact_id = d.contact_id and m.location_id = d.location_id
  left join last_stage s on s.opportunity_id = d.opportunity_id
  left join last_note  n on n.contact_id = d.contact_id
  left join last_task  k on k.contact_id = d.contact_id
),
bucketed as (select *, (now()::date - last_touch::date) as days_idle from touch)
select location_id,
       stage, count(*) as open_deals,
       count(*) filter (where days_idle < 14)  as under_14,
       count(*) filter (where days_idle between 14 and 29) as d14_29,
       count(*) filter (where days_idle between 30 and 59) as d30_59,
       count(*) filter (where days_idle >= 60)  as d60_plus,
       round(percentile_cont(0.5) within group (order by days_idle)::numeric, 0) as median_idle_days,
       sum(monetary_value) filter (where days_idle >= 30) as value_idle_30plus
from bucketed group by location_id, stage order by location_id, open_deals desc;

create or replace view public.vw_insight_4_5
  with (security_invoker = true) as
-- 4.5 Messages per won deal vs per lost deal — per sub-account
-- Counted on the customer (contact_id), all written channels, log rows excluded. Read-only.
with closed as (
  select opportunity_id, contact_id, location_id, status
  from opportunities
  where deleted_at is null and is_ghost = false and status in ('won','lost','abandoned')
),
msg as (
  select contact_id,
    count(*) filter (where message_direction = 'inbound') as inbound,
    count(*) filter (where message_direction = 'outbound' and coalesce(sender_type,'') <> 'automation') as outbound_human,
    count(*) filter (where message_direction = 'outbound' and sender_type = 'automation') as outbound_auto
  from messages
  where deleted_at is null and coalesce(message_channel,'') not ilike '%ACTIVITY%'
  group by contact_id
),
j as (
  select c.*, coalesce(m.inbound,0) as inbound, coalesce(m.outbound_human,0) as outbound_human, coalesce(m.outbound_auto,0) as outbound_auto
  from closed c left join msg m on m.contact_id = c.contact_id
)
select location_id, status, count(*) as deals,
       count(*) filter (where inbound > 0) as with_customer_msg,
       round(percentile_cont(0.5) within group (order by inbound)        filter (where inbound > 0)::numeric, 0) as median_inbound,
       round(percentile_cont(0.5) within group (order by outbound_human) filter (where inbound > 0)::numeric, 0) as median_outbound,
       round(avg(inbound)        filter (where inbound > 0), 1) as mean_inbound,
       round(avg(outbound_human) filter (where inbound > 0), 1) as mean_outbound
from j
group by location_id, status
order by location_id, status;

create or replace view public.vw_insight_5_1
  with (security_invoker = true) as
-- 5.1 Stage deals sit in longest before being marked lost or abandoned — PER SUB-ACCOUNT
-- Time in stage capped at the deal's close date (lost_at / abandoned_at): final-stage rows have no left_at. Read-only.
with closed as (
  select opportunity_id, status, location_id, coalesce(lost_at, abandoned_at) as closed_at
  from opportunities
  where deleted_at is null and is_ghost = false and status in ('lost','abandoned')
),
durations as (
  select s.opportunity_id, initcap(lower(s.stage_name)) as stage_name,
         sum(extract(epoch from least(coalesce(s.left_at, c.closed_at), c.closed_at) - s.entered_at)) / 86400.0 as days_in_stage
  from stage_history s join closed c on c.opportunity_id = s.opportunity_id
  where not s.deleted and not s.ghost_opportunity and coalesce(s.closed_reason,'') <> 'correction'
    and s.entered_at is not null and s.entered_at <= c.closed_at
  group by s.opportunity_id, initcap(lower(s.stage_name))
),
longest as (
  select distinct on (opportunity_id) opportunity_id, stage_name, days_in_stage
  from durations order by opportunity_id, days_in_stage desc
)
select c.location_id,
       l.stage_name as longest_stage, count(*) as deals,
       count(*) filter (where c.status = 'lost')      as lost,
       count(*) filter (where c.status = 'abandoned') as abandoned,
       round(percentile_cont(0.5) within group (order by l.days_in_stage)::numeric, 1) as median_days,
       round(percentile_cont(0.9) within group (order by l.days_in_stage)::numeric, 1) as p90_days,
       count(*) filter (where l.days_in_stage < 1) as under_1_day
from longest l join closed c on c.opportunity_id = l.opportunity_id
group by c.location_id, l.stage_name
order by location_id, deals desc;

create or replace view public.vw_insight_6_1
  with (security_invoker = true) as
-- 6.1 Buyer type with lowest drop-off at Deposit Paid — PER SUB-ACCOUNT
-- client_type is a JSON array on opportunities — unnest it. A deal with two buyer types appears on both lines. Read-only.
with so(stage_name, ord) as (values
  ('marketing qualified',1),('initial contact made',2),('sales qualified',3),
  ('waiting on details',4),('quote sent',5),('negotiation',6),('deposit & sales contract',7)
),
d as (
  select o.opportunity_id, o.location_id, o.status, o.monetary_value,
         jsonb_array_elements_text(o.client_type) as ct
  from opportunities o
  where o.deleted_at is null and o.is_ghost = false
    and jsonb_typeof(o.client_type) = 'array' and jsonb_array_length(o.client_type) > 0
),
mx as (
  select d.*,
         (select max(so.ord) from stage_history s join so on so.stage_name = lower(s.stage_name)
          where s.opportunity_id = d.opportunity_id and not s.deleted and not s.ghost_opportunity
            and coalesce(s.closed_reason,'') <> 'correction') as max_ord
  from d
)
select location_id,
       lower(ct) as buyer_type, count(*) as deals,
       count(*) filter (where coalesce(max_ord,0) >= 5) as reached_quote,
       count(*) filter (where coalesce(max_ord,0) >= 7) as reached_deposit,
       count(*) filter (where status = 'won') as won,
       count(*) filter (where status in ('lost','abandoned')) as lost_ab,
       count(*) filter (where status = 'open') as open,
       round(100.0 * count(*) filter (where status = 'won') / nullif(count(*) filter (where status <> 'open'), 0), 0) as won_per_closed_pct,
       sum(monetary_value) filter (where status = 'won') as won_value
from mx group by location_id, lower(ct) having count(*) >= 5 order by location_id, deals desc;

create or replace view public.vw_insight_6_2
  with (security_invoker = true) as
-- 6.2 Buyer type revenue share vs lead share — PER SUB-ACCOUNT
-- Shares are of TYPED deals only. The location_id totals are carried through so the gap is visible. Read-only.
with tot as (
  select location_id, count(*) as all_deals,
         count(*) filter (where status = 'won') as all_won,
         sum(monetary_value) filter (where status = 'won') as all_won_value
  from opportunities where deleted_at is null and is_ghost = false group by location_id
),
d as (
  select o.location_id, o.status, o.monetary_value, jsonb_array_elements_text(o.client_type) as ct
  from opportunities o
  where o.deleted_at is null and o.is_ghost = false
    and jsonb_typeof(o.client_type) = 'array' and jsonb_array_length(o.client_type) > 0
),
g as (
  select location_id, lower(ct) as bt, count(*) as deals,
         count(*) filter (where status = 'won') as won,
         sum(monetary_value) filter (where status = 'won') as won_value
  from d group by location_id, lower(ct)
)
select g.location_id,
       g.bt as buyer_type, g.deals, g.won, g.won_value,
       round(100.0 * g.deals / sum(g.deals) over (partition by g.location_id), 0) as pct_of_typed_leads,
       round(100.0 * g.won_value / nullif(sum(g.won_value) over (partition by g.location_id), 0), 0) as pct_of_typed_won_value,
       t.all_deals, t.all_won_value
from g join tot t on t.location_id = g.location_id
where g.deals >= 5
order by location_id, g.deals desc;

create or replace view public.vw_insight_6_3_a
  with (security_invoker = true) as
-- 6.3 Product type conversion and value — PER SUB-ACCOUNT
-- product_type is a JSON array on opportunities — unnest it. A deal ticked with two products appears on both lines. Read-only.

-- Part A: coverage
select location_id,
       count(*) as deals,
       count(*) filter (where jsonb_typeof(product_type) = 'array'   and jsonb_array_length(product_type) > 0)   as has_product_type,
       count(*) filter (where jsonb_typeof(product_system) = 'array' and jsonb_array_length(product_system) > 0) as has_product_system,
       count(*) filter (where status = 'won') as won,
       count(*) filter (where status = 'won' and jsonb_typeof(product_type) = 'array' and jsonb_array_length(product_type) > 0) as won_with_type
from opportunities where deleted_at is null and is_ghost = false group by location_id order by deals desc;

create or replace view public.vw_insight_6_3_b
  with (security_invoker = true) as
-- Part B: by product
with d as (
  select o.location_id, o.status, o.monetary_value, lower(jsonb_array_elements_text(o.product_type)) as pt
  from opportunities o
  where o.deleted_at is null and o.is_ghost = false
    and jsonb_typeof(o.product_type) = 'array' and jsonb_array_length(o.product_type) > 0
)
select location_id,
       pt as product_type, count(*) as deals,
       count(*) filter (where status = 'won') as won,
       count(*) filter (where status in ('lost','abandoned')) as lost_ab,
       count(*) filter (where status = 'open') as open,
       round(100.0 * count(*) filter (where status = 'won') / nullif(count(*) filter (where status <> 'open'), 0), 0) as won_per_closed_pct,
       sum(monetary_value) filter (where status = 'won') as won_value,
       round(avg(monetary_value) filter (where status = 'won' and monetary_value > 0)) as avg_won_value
from d group by location_id, pt having count(*) >= 5 order by location_id, deals desc;

create or replace view public.vw_insight_8_1
  with (security_invoker = true) as
-- 8.1 Open deals with no task set — PER SUB-ACCOUNT
-- 'No open task' = no task row with status 'open' linked to the deal. Also reports tasks on the contact, tasks ever, and overdue tasks. Read-only.

-- Part A: counts by location_id and stage
with od as (
  select o.opportunity_id, o.location_id, o.contact_id, o.monetary_value,
         coalesce(initcap(lower(s.stage_name)), '(no stage row)') as stage
  from opportunities o
  left join stage_history s on s.opportunity_id = o.opportunity_id and s.current_stage and not s.deleted and not s.ghost_opportunity
  where o.deleted_at is null and o.is_ghost = false and o.status = 'open'
),
t as (
  select opportunity_id,
         count(*) filter (where status = 'open') as open_tasks,
         count(*) as tasks_any,
         min(due_at) filter (where status = 'open') as next_due
  from tasks where deleted_at is null and opportunity_id is not null group by opportunity_id
),
tc as (
  select contact_id, count(*) filter (where status = 'open') as open_tasks_contact
  from tasks where deleted_at is null group by contact_id
)
select d.location_id,
       d.stage, count(*) as open_deals,
       count(*) filter (where coalesce(t.open_tasks,0) = 0) as no_open_task,
       count(*) filter (where coalesce(t.open_tasks,0) = 0 and coalesce(tc.open_tasks_contact,0) = 0) as no_open_task_on_contact_either,
       count(*) filter (where coalesce(t.tasks_any,0) = 0) as never_had_a_task,
       count(*) filter (where t.next_due < now()) as overdue_task,
       sum(d.monetary_value) filter (where coalesce(t.open_tasks,0) = 0) as value_no_task
from od d
left join t  on t.opportunity_id = d.opportunity_id
left join tc on tc.contact_id = d.contact_id
group by d.location_id, d.stage having count(*) >= 5 order by location_id, open_deals desc;

create or replace view public.vw_insight_8_2_b
  with (security_invoker = true) as
-- Part B: open deals by stage
with od as (
  select o.opportunity_id, o.location_id, o.monetary_value,
         coalesce(initcap(lower(s.stage_name)), '(no stage row)') as stage
  from opportunities o
  left join stage_history s on s.opportunity_id = o.opportunity_id and s.current_stage and not s.deleted and not s.ghost_opportunity
  where o.deleted_at is null and o.is_ghost = false and o.status = 'open'
),
n as (
  select opportunity_id, count(*) as notes, sum(length(coalesce(body,''))) as total_len, max(created_at_ghl) as last_note
  from notes where deleted_at is null and opportunity_id is not null group by opportunity_id
)
select d.location_id,
       d.stage, count(*) as open_deals,
       count(*) filter (where coalesce(n.notes,0) = 0) as no_notes,
       count(*) filter (where coalesce(n.total_len,0) between 1 and 99) as thin_notes,
       count(*) filter (where n.last_note < now() - interval '30 days') as note_older_30d,
       sum(d.monetary_value) filter (where coalesce(n.notes,0) = 0) as value_no_notes
from od d left join n on n.opportunity_id = d.opportunity_id
group by d.location_id, d.stage having count(*) >= 5 order by location_id, open_deals desc;

create or replace view public.vw_insight_8_3
  with (security_invoker = true) as
-- 8.3 Deals with most information missing — ranked — PER SUB-ACCOUNT
-- Score 0–6: owner, quoted value, enquiry text, lead source, buyer type, product type. Read-only.
-- NOTE: build the score with CASE WHEN, not boolean::int inside avg() — see caveat 2.
with od as (
  select o.opportunity_id, o.location_id, o.monetary_value, o.assigned_to,
         coalesce(initcap(lower(s.stage_name)), '(no stage row)') as stage,
         (case when o.assigned_to is not null then 1 else 0 end
          + case when o.monetary_value is not null and o.monetary_value > 0 then 1 else 0 end
          + case when nullif(trim(o.inquiry),'') is not null then 1 else 0 end
          + case when nullif(o.lead_source_opportunity,'') is not null then 1 else 0 end
          + case when jsonb_typeof(o.client_type) = 'array'  and jsonb_array_length(o.client_type) > 0 then 1 else 0 end
          + case when jsonb_typeof(o.product_type) = 'array' and jsonb_array_length(o.product_type) > 0 then 1 else 0 end) as score
  from opportunities o
  left join stage_history s on s.opportunity_id = o.opportunity_id and s.current_stage and not s.deleted and not s.ghost_opportunity
  where o.deleted_at is null and o.is_ghost = false and o.status = 'open'
)
-- Part A: field fill and score distribution by location_id
select location_id,
       count(*) as open_deals, round(avg(score), 1) as avg_of_6,
       count(*) filter (where score <= 1) as score_0_1,
       count(*) filter (where score = 2) as score_2,
       count(*) filter (where score = 3) as score_3,
       count(*) filter (where score = 4) as score_4,
       count(*) filter (where score = 5) as score_5,
       count(*) filter (where score = 6) as score_6,
       sum(monetary_value) filter (where score <= 3) as value_score_0_3
from od group by location_id order by open_deals desc;

create or replace view public.vw_insight_8_4
  with (security_invoker = true) as
-- 8.4 Mandatory fields left empty, by rep — PER SUB-ACCOUNT, PER GHL USER ACCOUNT
-- Open deals with an owner. Four fields as a stand-in until Charlie supplies the mandatory list. Read-only.
with users(user_id, name) as (values
  ('uDQS5uGvQh94iX5y50HS','Charlie Stoyle'), ('94ihRvQZHBVYXvWY0UxY','Charlie Stoyle'), ('dubal5CaysMNDJx4k6Ih','Charlie Stoyle'),
  ('eh9bSjcHEnLall0hSWJi','Liam Griffin'), ('mzC0eKJCiTgWTVJqH8qD','Liam V.Griffin'),
  ('vHikbah2pho52ttBT8vi','Chris Higgs'), ('jADn3ZqU5wZ57UoWIYGh','Chris Higgs'),
  ('Gz8mgWyAOudVtbHVE7P9','Chris Spilsbury (left)'), ('UqNYn69BwMEzol7BKwzI','Ollie Dawe'),
  ('sDCg3T33E5p6w53anGev','Brad Ricardo'), ('oR1IEM4FEJPOqKV1XHA6','Ella Clayden'),
  ('KOqRV289cGSPxYlmDO4m','EGJ'), ('aoYdS7Lr4U0shmG8x1dU','EGJ'), ('ip1ntH3jgVwe7SfsRnXh','EGJ')
),
od as (
  select o.location_id, o.assigned_to, o.monetary_value,
         case when o.monetary_value is not null and o.monetary_value > 0 then 1 else 0 end as has_value,
         case when nullif(o.lead_source_opportunity,'') is not null then 1 else 0 end as has_source,
         case when jsonb_typeof(o.client_type) = 'array'  and jsonb_array_length(o.client_type) > 0 then 1 else 0 end as has_buyer,
         case when jsonb_typeof(o.product_type) = 'array' and jsonb_array_length(o.product_type) > 0 then 1 else 0 end as has_product
  from opportunities o
  where o.deleted_at is null and o.is_ghost = false and o.status = 'open' and o.assigned_to is not null
)
select location_id,
       coalesce(u.name, od.assigned_to) as rep_account,
       count(*) as open_deals,
       count(*) - sum(has_value)   as missing_value,
       count(*) - sum(has_source)  as missing_source,
       count(*) - sum(has_buyer)   as missing_buyer,
       count(*) - sum(has_product) as missing_product,
       round(100.0 * sum(has_value + has_source + has_buyer + has_product) / (4 * count(*)), 0) as pct_of_4_filled,
       sum(monetary_value) filter (where has_buyer = 0) as value_missing_buyer
from od left join users u on u.user_id = od.assigned_to
group by location_id, coalesce(u.name, od.assigned_to)
having count(*) >= 5
order by location_id, open_deals desc;

create or replace view public.vw_insight_8_5
  with (security_invoker = true) as
-- 8.5 Reps ranked by how often they follow the rules — PER SUB-ACCOUNT, PER GHL USER ACCOUNT
-- Three habits on open deals: a next action booked, a note written, the customer's messages assigned to the deal.
-- Reported as three columns, never as one combined score (see caveat 3). Read-only.
with users(user_id, name) as (values
  ('uDQS5uGvQh94iX5y50HS','Charlie Stoyle'), ('94ihRvQZHBVYXvWY0UxY','Charlie Stoyle'), ('dubal5CaysMNDJx4k6Ih','Charlie Stoyle'),
  ('eh9bSjcHEnLall0hSWJi','Liam Griffin'), ('mzC0eKJCiTgWTVJqH8qD','Liam V.Griffin'),
  ('vHikbah2pho52ttBT8vi','Chris Higgs'), ('jADn3ZqU5wZ57UoWIYGh','Chris Higgs'),
  ('Gz8mgWyAOudVtbHVE7P9','Chris Spilsbury (left)'), ('UqNYn69BwMEzol7BKwzI','Ollie Dawe'),
  ('sDCg3T33E5p6w53anGev','Brad Ricardo'), ('oR1IEM4FEJPOqKV1XHA6','Ella Clayden'),
  ('KOqRV289cGSPxYlmDO4m','EGJ'), ('aoYdS7Lr4U0shmG8x1dU','EGJ'), ('ip1ntH3jgVwe7SfsRnXh','EGJ')
),
od as (
  select o.opportunity_id, o.location_id, o.assigned_to
  from opportunities o
  where o.deleted_at is null and o.is_ghost = false and o.status = 'open' and o.assigned_to is not null
),
t as (select opportunity_id, count(*) filter (where status = 'open') as open_tasks
      from tasks where deleted_at is null and opportunity_id is not null group by opportunity_id),
n as (select opportunity_id, count(*) as notes
      from notes where deleted_at is null and opportunity_id is not null group by opportunity_id),
m as (select opportunity_id, count(*) as assigned_msgs
      from messages where deleted_at is null and opportunity_id is not null
        and coalesce(message_channel,'') not ilike '%ACTIVITY%' group by opportunity_id),
j as (
  select od.*, coalesce(t.open_tasks,0) as open_tasks, coalesce(n.notes,0) as notes, coalesce(m.assigned_msgs,0) as msgs
  from od
  left join t on t.opportunity_id = od.opportunity_id
  left join n on n.opportunity_id = od.opportunity_id
  left join m on m.opportunity_id = od.opportunity_id
)
select location_id,
       coalesce(u.name, j.assigned_to) as rep_account,
       count(*) as open_deals,
       round(100.0 * count(*) filter (where open_tasks > 0) / count(*), 0) as pct_with_next_action,
       round(100.0 * count(*) filter (where notes > 0)      / count(*), 0) as pct_with_a_note,
       round(100.0 * count(*) filter (where msgs > 0)       / count(*), 0) as pct_with_assigned_msgs
from j left join users u on u.user_id = j.assigned_to
group by location_id, coalesce(u.name, j.assigned_to)
having count(*) >= 5
order by location_id, open_deals desc;
