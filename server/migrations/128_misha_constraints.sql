-- 128_misha_constraints.sql — sequence counters, PKs, uniques, indexes, FK.
--
-- Runs last, after 127 has loaded every row, because:
--   * the FK replies.customer_requirement_id -> requirements.id would fail if
--     replies were present before requirements;
--   * building indexes once over a full table is cheaper than maintaining them
--     through 7,000 inserts.
--
-- setval() values are misha's, carried over verbatim. They sit ABOVE the max
-- id in several tables because rows were deleted upstream — that gap is real,
-- not an import error:
--   deal_extracts 3933/3926 | requirements 1447/1347 | replies 1329/1169
--   questions 162/50 | phrases 200/50   <- these two were truncated to a
--   50-row legacy sample; ~70% of their rows are gone.
--
-- CONSEQUENCE worth knowing before building anything on this: replies.
-- customer_question_id has NO foreign key (only customer_requirement_id does),
-- and ~70% of questions rows were deleted upstream. Measured on this exact
-- data: of the 371 replies that carry a customer_question_id, 353 (95%) point
-- at a question id that no longer exists. An INNER JOIN from replies to
-- questions therefore returns 18 rows and raises no error — a silently biased
-- sample, not a failure. Use a LEFT JOIN, or avoid the pair entirely and read
-- deal_extracts, the only table here with both a location index and a
-- location-scoped unique key.


--
-- Name: deal_extracts_id_seq; Type: SEQUENCE SET; Schema: misha; Owner: -
--

SELECT pg_catalog.setval('misha.deal_extracts_id_seq', 3933, true);


--
-- Name: phrases_id_seq; Type: SEQUENCE SET; Schema: misha; Owner: -
--

SELECT pg_catalog.setval('misha.phrases_id_seq', 200, true);


--
-- Name: questions_id_seq; Type: SEQUENCE SET; Schema: misha; Owner: -
--

SELECT pg_catalog.setval('misha.questions_id_seq', 162, true);


--
-- Name: replies_id_seq; Type: SEQUENCE SET; Schema: misha; Owner: -
--

SELECT pg_catalog.setval('misha.replies_id_seq', 1329, true);


--
-- Name: requirement_offer_id_seq; Type: SEQUENCE SET; Schema: misha; Owner: -
--

SELECT pg_catalog.setval('misha.requirement_offer_id_seq', 1, false);


--
-- Name: requirements_id_seq; Type: SEQUENCE SET; Schema: misha; Owner: -
--

SELECT pg_catalog.setval('misha.requirements_id_seq', 1447, true);



--
-- Name: deal_extracts deal_extracts_location_id_message_id_fact_type_label_key; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.deal_extracts
    ADD CONSTRAINT deal_extracts_location_id_message_id_fact_type_label_key UNIQUE (location_id, message_id, fact_type, label);


--
-- Name: deal_extracts deal_extracts_pkey; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.deal_extracts
    ADD CONSTRAINT deal_extracts_pkey PRIMARY KEY (id);


--
-- Name: phrases phrases_loc_msg_phrase_uniq; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.phrases
    ADD CONSTRAINT phrases_loc_msg_phrase_uniq UNIQUE (location_id, message_id, phrase);


--
-- Name: phrases phrases_pkey; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.phrases
    ADD CONSTRAINT phrases_pkey PRIMARY KEY (id);


--
-- Name: question_theme_map question_theme_map_pkey; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.question_theme_map
    ADD CONSTRAINT question_theme_map_pkey PRIMARY KEY (location_id, question_label);


--
-- Name: questions questions_loc_msg_q_uniq; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.questions
    ADD CONSTRAINT questions_loc_msg_q_uniq UNIQUE (location_id, message_id, question_text);


--
-- Name: questions questions_pkey; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.questions
    ADD CONSTRAINT questions_pkey PRIMARY KEY (id);


--
-- Name: replies replies_pkey; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.replies
    ADD CONSTRAINT replies_pkey PRIMARY KEY (id);


--
-- Name: requirement_offer requirement_offer_location_id_requirement_label_key; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.requirement_offer
    ADD CONSTRAINT requirement_offer_location_id_requirement_label_key UNIQUE (location_id, requirement_label);


--
-- Name: requirement_offer requirement_offer_pkey; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.requirement_offer
    ADD CONSTRAINT requirement_offer_pkey PRIMARY KEY (id);


--
-- Name: requirement_theme_map requirement_theme_map_pkey; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.requirement_theme_map
    ADD CONSTRAINT requirement_theme_map_pkey PRIMARY KEY (location_id, requirement_label);


--
-- Name: requirements requirements_loc_msg_label_uniq; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.requirements
    ADD CONSTRAINT requirements_loc_msg_label_uniq UNIQUE (location_id, message_id, requirement_label);


--
-- Name: requirements requirements_pkey; Type: CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.requirements
    ADD CONSTRAINT requirements_pkey PRIMARY KEY (id);


--
-- Name: idx_deal_extracts_fact_type; Type: INDEX; Schema: misha; Owner: -
--

CREATE INDEX idx_deal_extracts_fact_type ON misha.deal_extracts USING btree (fact_type);


--
-- Name: idx_deal_extracts_location; Type: INDEX; Schema: misha; Owner: -
--

CREATE INDEX idx_deal_extracts_location ON misha.deal_extracts USING btree (location_id);


--
-- Name: idx_deal_extracts_opportunity; Type: INDEX; Schema: misha; Owner: -
--

CREATE INDEX idx_deal_extracts_opportunity ON misha.deal_extracts USING btree (opportunity_id);


--
-- Name: idx_deal_extracts_speaker; Type: INDEX; Schema: misha; Owner: -
--

CREATE INDEX idx_deal_extracts_speaker ON misha.deal_extracts USING btree (speaker);


--
-- Name: replies replies_customer_requirement_id_fkey; Type: FK CONSTRAINT; Schema: misha; Owner: -
--

ALTER TABLE ONLY misha.replies
    ADD CONSTRAINT replies_customer_requirement_id_fkey FOREIGN KEY (customer_requirement_id) REFERENCES misha.requirements(id);


--
-- PostgreSQL database dump complete
--


