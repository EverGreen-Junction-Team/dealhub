-- 126_misha_schema.sql — create the `misha` schema and its 8 tables.
--
-- Source: misha's schema export (misha_schema_export/01_schema.sql), re-wrapped
-- as a tracked migration. Touches ONLY the `misha` schema; nothing in `public`
-- is created, altered or dropped.
--
-- Deviations from the raw export, all deliberate:
--   * `SET transaction_timeout` dropped — Postgres 17 only; errors on PG 15/16.
--   * `SELECT set_config('search_path','')` dropped — the migration runner
--     executes every file inside one transaction, and blanking search_path
--     there would break later statements. Every object below is schema-
--     qualified, so an empty search_path bought us nothing anyway.
--   * CREATE SCHEMA -> CREATE SCHEMA IF NOT EXISTS, and each CREATE TABLE /
--     SEQUENCE -> IF NOT EXISTS, so a partial failure can be retried. The
--     runner already rolls back on error; this guards a re-run after a manual
--     partial load.
--
-- NOTE on misha.deal_why_sentence (created at the end of this file): it carries
-- a hardcoded location_id -> brand CASE and has no security_invoker, so it can
-- NOT back an AI skill. It is retained only because the export defines it.
-- Any skill must read a new `public` view with an explicit location_id filter.

-- ============================================================================
-- misha schema export — full recreate script
-- ============================================================================
-- What this does: creates the "misha" schema in whatever database you point
-- it at, then creates all 8 tables and 1 view exactly as they exist in the
-- Misha analytics database, and loads them with all current data.
--
-- Tables created (with row counts as of this export):
--   deal_extracts          3,926 rows  (raw extraction facts)
--   replies                1,169 rows
--   requirements           1,347 rows
--   questions                  50 rows  (legacy pilot table, frozen)
--   phrases                    50 rows  (legacy pilot table, frozen)
--   requirement_offer           0 rows  (not yet classified, genuinely empty)
--   requirement_theme_map   1,328 rows  (lookup: free-text label -> theme)
--   question_theme_map        596 rows  (lookup: free-text label -> theme)
--
-- View created:
--   deal_why_sentence  (built from deal_extracts + replies, both included
--                        above, so it will work immediately after this runs)
--
-- How to run (psql):
--   psql "<your connection string>" -f misha_schema_export.sql
--
-- NOT safe to re-run as-is: CREATE SCHEMA / CREATE TABLE will error out if a
-- schema called "misha" already exists in the target database. That is
-- intentional — it stops rather than silently overwriting anything. If you
-- need to reload from scratch, drop the old one first:
--   DROP SCHEMA misha CASCADE;
--
-- IMPORTANT: run this against a database/schema you intend to populate with
-- this data. It only touches the "misha" schema — it does not read from or
-- write to any other schema (opportunities, messages, stage_history, etc.
-- are not touched).
-- ============================================================================


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: misha; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS misha;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: deal_extracts; Type: TABLE; Schema: misha; Owner: -
--

CREATE TABLE IF NOT EXISTS misha.deal_extracts (
    id bigint NOT NULL,
    location_id text NOT NULL,
    opportunity_id text NOT NULL,
    message_id text NOT NULL,
    fact_type text NOT NULL,
    speaker text NOT NULL,
    label text NOT NULL,
    quote text NOT NULL,
    quoted_at timestamp with time zone,
    our_term text,
    rep_ask_outcome text,
    rep_ask_evidence_message_id text,
    client_type text,
    product_system text,
    product_type text,
    lead_source_opportunity text,
    first_contact_method text,
    tags text[],
    deal_status text,
    furthest_stage text,
    stage_at_message text,
    stage_match_method text,
    contact_id text,
    deal_has_multiple_contacts boolean,
    pii_stripped boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text DEFAULT 'misha'::text NOT NULL,
    CONSTRAINT deal_extracts_fact_type_check CHECK ((fact_type = ANY (ARRAY['customer_phrase'::text, 'customer_question'::text, 'customer_requirement'::text, 'rep_question'::text, 'rep_product_words'::text, 'rep_ask'::text]))),
    CONSTRAINT deal_extracts_rep_ask_outcome_check CHECK ((rep_ask_outcome = ANY (ARRAY['done'::text, 'not_done'::text, 'unknown'::text]))),
    CONSTRAINT deal_extracts_speaker_check CHECK ((speaker = ANY (ARRAY['customer'::text, 'rep'::text]))),
    CONSTRAINT deal_extracts_stage_match_method_check CHECK ((stage_match_method = ANY (ARRAY['stage_history_id'::text, 'timestamp_match'::text])))
);


--
-- Name: deal_extracts_id_seq; Type: SEQUENCE; Schema: misha; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS misha.deal_extracts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deal_extracts_id_seq; Type: SEQUENCE OWNED BY; Schema: misha; Owner: -
--

ALTER SEQUENCE misha.deal_extracts_id_seq OWNED BY misha.deal_extracts.id;


--
-- Name: replies; Type: TABLE; Schema: misha; Owner: -
--

CREATE TABLE IF NOT EXISTS misha.replies (
    id bigint NOT NULL,
    location_id text NOT NULL,
    opportunity_id text NOT NULL,
    customer_question_id bigint,
    customer_requirement_id bigint,
    rep_reply text NOT NULL,
    rep_reply_message_id text,
    rep_reply_at timestamp with time zone,
    deal_moved_stage_after boolean,
    stage_moved_to text,
    days_to_move numeric,
    client_type text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text DEFAULT 'misha'::text NOT NULL
);


--
-- Name: deal_why_sentence; Type: VIEW; Schema: misha; Owner: -
--

CREATE VIEW misha.deal_why_sentence AS
 WITH deal AS (
         SELECT DISTINCT ON (deal_extracts.location_id, deal_extracts.opportunity_id) deal_extracts.location_id,
            deal_extracts.opportunity_id,
            deal_extracts.client_type,
            deal_extracts.lead_source_opportunity,
            deal_extracts.first_contact_method,
            deal_extracts.product_system,
            deal_extracts.product_type,
            deal_extracts.deal_status,
            deal_extracts.furthest_stage
           FROM misha.deal_extracts
          ORDER BY deal_extracts.location_id, deal_extracts.opportunity_id, deal_extracts.quoted_at
        ), first_fact AS (
         SELECT DISTINCT ON (deal_extracts.location_id, deal_extracts.opportunity_id, deal_extracts.fact_type) deal_extracts.location_id,
            deal_extracts.opportunity_id,
            deal_extracts.fact_type,
            deal_extracts.label,
            deal_extracts.quote,
            deal_extracts.quoted_at
           FROM misha.deal_extracts
          WHERE (deal_extracts.speaker = 'customer'::text)
          ORDER BY deal_extracts.location_id, deal_extracts.opportunity_id, deal_extracts.fact_type, deal_extracts.quoted_at
        ), first_reply AS (
         SELECT DISTINCT ON (replies.location_id, replies.opportunity_id) replies.location_id,
            replies.opportunity_id,
            regexp_replace(replies.rep_reply, '\s*Sent from .*$'::text, ''::text, 'i'::text) AS rep_reply,
            replies.deal_moved_stage_after,
            replies.stage_moved_to
           FROM misha.replies
          ORDER BY replies.location_id, replies.opportunity_id, replies.rep_reply_at
        )
 SELECT d.location_id,
        CASE d.location_id
            WHEN 'IFcSg4YvuVlx56msjbdf'::text THEN 'BGD'::text
            WHEN 'kHcvavc8fEeqkEPTK2T8'::text THEN 'Veritas'::text
            WHEN 'E0nGtwuWd1cmeoc6ilD1'::text THEN 'Omnia'::text
            ELSE NULL::text
        END AS client,
    d.opportunity_id,
    d.client_type,
    NULLIF(array_to_string(
        CASE
            WHEN (d.lead_source_opportunity ~~ '{%'::text) THEN (d.lead_source_opportunity)::text[]
            ELSE ARRAY[d.lead_source_opportunity]
        END, ', '::text), ''::text) AS lead_source,
    d.first_contact_method,
    d.product_system,
    d.product_type,
    ph.label AS phrase,
    q.label AS question,
    rq.label AS requirement,
    r.rep_reply,
    r.deal_moved_stage_after,
    r.stage_moved_to,
    d.deal_status,
    d.furthest_stage,
    ((ph.label IS NOT NULL) AND (q.label IS NOT NULL) AND (rq.label IS NOT NULL)) AS is_complete,
    regexp_replace(concat_ws(' '::text, ((
        CASE
            WHEN (COALESCE(NULLIF(d.client_type, 'blank'::text), 'customer'::text) ~* '^[aeiou]'::text) THEN 'An '::text
            ELSE 'A '::text
        END || COALESCE(NULLIF(d.client_type, 'blank'::text), 'customer of unknown type'::text)) || ','::text),
        CASE
            WHEN ((d.lead_source_opportunity IS NOT NULL) AND (d.lead_source_opportunity <> 'blank'::text)) THEN (('came from '::text || array_to_string(
            CASE
                WHEN (d.lead_source_opportunity ~~ '{%'::text) THEN (d.lead_source_opportunity)::text[]
                ELSE ARRAY[d.lead_source_opportunity]
            END, ', '::text)) || ','::text)
            ELSE NULL::text
        END,
        CASE
            WHEN ((d.first_contact_method IS NOT NULL) AND (d.first_contact_method <> 'blank'::text)) THEN (('first contacted us by '::text || d.first_contact_method) || ','::text)
            ELSE NULL::text
        END,
        CASE
            WHEN ((d.product_system IS NOT NULL) AND (d.product_system <> 'blank'::text)) THEN ((('asked about '::text || d.product_system) ||
            CASE
                WHEN ((d.product_type IS NOT NULL) AND (d.product_type <> 'blank'::text)) THEN ((' ('::text || d.product_type) || ')'::text)
                ELSE ''::text
            END) || ','::text)
            ELSE NULL::text
        END,
        CASE
            WHEN (ph.label IS NOT NULL) THEN (('said "'::text || ph.label) || '",'::text)
            ELSE NULL::text
        END,
        CASE
            WHEN (q.label IS NOT NULL) THEN (('asked "'::text || q.label) || '",'::text)
            ELSE NULL::text
        END,
        CASE
            WHEN (rq.label IS NOT NULL) THEN (('and asked for "'::text || rq.label) || '";'::text)
            ELSE NULL::text
        END,
        CASE
            WHEN (r.rep_reply IS NOT NULL) THEN ((('we said "'::text || "left"(regexp_replace(r.rep_reply, '\s+'::text, ' '::text, 'g'::text), 160)) ||
            CASE
                WHEN (length(r.rep_reply) > 160) THEN '…'::text
                ELSE ''::text
            END) || '"'::text)
            ELSE NULL::text
        END, (('— and the deal was '::text || d.deal_status) || '.'::text)), '[,;]\s*(—)'::text, ' \1'::text) AS why_sentence
   FROM ((((deal d
     LEFT JOIN first_fact ph ON (((ph.location_id = d.location_id) AND (ph.opportunity_id = d.opportunity_id) AND (ph.fact_type = 'customer_phrase'::text))))
     LEFT JOIN first_fact q ON (((q.location_id = d.location_id) AND (q.opportunity_id = d.opportunity_id) AND (q.fact_type = 'customer_question'::text))))
     LEFT JOIN first_fact rq ON (((rq.location_id = d.location_id) AND (rq.opportunity_id = d.opportunity_id) AND (rq.fact_type = 'customer_requirement'::text))))
     LEFT JOIN first_reply r ON (((r.location_id = d.location_id) AND (r.opportunity_id = d.opportunity_id))));


--
-- Name: phrases; Type: TABLE; Schema: misha; Owner: -
--

CREATE TABLE IF NOT EXISTS misha.phrases (
    id bigint NOT NULL,
    location_id text NOT NULL,
    opportunity_id text,
    message_id text,
    phrase text NOT NULL,
    our_term text,
    source text DEFAULT 'message'::text NOT NULL,
    quote text NOT NULL,
    quoted_at timestamp with time zone,
    deal_status text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text DEFAULT 'misha'::text NOT NULL
);


--
-- Name: phrases_id_seq; Type: SEQUENCE; Schema: misha; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS misha.phrases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phrases_id_seq; Type: SEQUENCE OWNED BY; Schema: misha; Owner: -
--

ALTER SEQUENCE misha.phrases_id_seq OWNED BY misha.phrases.id;


--
-- Name: question_theme_map; Type: TABLE; Schema: misha; Owner: -
--

CREATE TABLE IF NOT EXISTS misha.question_theme_map (
    location_id text NOT NULL,
    question_label text NOT NULL,
    theme text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text DEFAULT 'misha_full_run'::text NOT NULL
);


--
-- Name: questions; Type: TABLE; Schema: misha; Owner: -
--

CREATE TABLE IF NOT EXISTS misha.questions (
    id bigint NOT NULL,
    location_id text NOT NULL,
    opportunity_id text NOT NULL,
    message_id text,
    question_text text NOT NULL,
    quote text NOT NULL,
    quoted_at timestamp with time zone,
    rep_reply text,
    rep_reply_message_id text,
    was_answered boolean,
    deal_status text,
    client_type text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text DEFAULT 'misha'::text NOT NULL
);


--
-- Name: questions_id_seq; Type: SEQUENCE; Schema: misha; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS misha.questions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: questions_id_seq; Type: SEQUENCE OWNED BY; Schema: misha; Owner: -
--

ALTER SEQUENCE misha.questions_id_seq OWNED BY misha.questions.id;


--
-- Name: replies_id_seq; Type: SEQUENCE; Schema: misha; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS misha.replies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: replies_id_seq; Type: SEQUENCE OWNED BY; Schema: misha; Owner: -
--

ALTER SEQUENCE misha.replies_id_seq OWNED BY misha.replies.id;


--
-- Name: requirement_offer; Type: TABLE; Schema: misha; Owner: -
--

CREATE TABLE IF NOT EXISTS misha.requirement_offer (
    id bigint NOT NULL,
    location_id text NOT NULL,
    requirement_label text NOT NULL,
    offered text DEFAULT 'Not yet classified'::text NOT NULL,
    which_systems text,
    classified_by text,
    classified_date date,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: requirement_offer_id_seq; Type: SEQUENCE; Schema: misha; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS misha.requirement_offer_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: requirement_offer_id_seq; Type: SEQUENCE OWNED BY; Schema: misha; Owner: -
--

ALTER SEQUENCE misha.requirement_offer_id_seq OWNED BY misha.requirement_offer.id;


--
-- Name: requirement_theme_map; Type: TABLE; Schema: misha; Owner: -
--

CREATE TABLE IF NOT EXISTS misha.requirement_theme_map (
    location_id text NOT NULL,
    requirement_label text NOT NULL,
    theme text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text DEFAULT 'misha_full_run'::text NOT NULL
);


--
-- Name: requirements; Type: TABLE; Schema: misha; Owner: -
--

CREATE TABLE IF NOT EXISTS misha.requirements (
    id bigint NOT NULL,
    location_id text NOT NULL,
    opportunity_id text NOT NULL,
    message_id text,
    requirement_label text NOT NULL,
    quote text NOT NULL,
    quoted_at timestamp with time zone,
    is_objection boolean DEFAULT false NOT NULL,
    is_price_limit boolean DEFAULT false NOT NULL,
    price_limit_amount numeric,
    rep_reply text,
    rep_reply_message_id text,
    deal_status text,
    stage_at_time text,
    client_type text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text DEFAULT 'misha'::text NOT NULL
);


--
-- Name: requirements_id_seq; Type: SEQUENCE; Schema: misha; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS misha.requirements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: requirements_id_seq; Type: SEQUENCE OWNED BY; Schema: misha; Owner: -
--

ALTER SEQUENCE misha.requirements_id_seq OWNED BY misha.requirements.id;


--
-- Name: deal_extracts id; Type: DEFAULT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.deal_extracts ALTER COLUMN id SET DEFAULT nextval('misha.deal_extracts_id_seq'::regclass);


--
-- Name: phrases id; Type: DEFAULT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.phrases ALTER COLUMN id SET DEFAULT nextval('misha.phrases_id_seq'::regclass);


--
-- Name: questions id; Type: DEFAULT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.questions ALTER COLUMN id SET DEFAULT nextval('misha.questions_id_seq'::regclass);


--
-- Name: replies id; Type: DEFAULT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.replies ALTER COLUMN id SET DEFAULT nextval('misha.replies_id_seq'::regclass);


--
-- Name: requirement_offer id; Type: DEFAULT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.requirement_offer ALTER COLUMN id SET DEFAULT nextval('misha.requirement_offer_id_seq'::regclass);


--
-- Name: requirements id; Type: DEFAULT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.requirements ALTER COLUMN id SET DEFAULT nextval('misha.requirements_id_seq'::regclass);


