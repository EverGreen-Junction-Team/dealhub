-- 042_tag_views_security_invoker.sql
--
-- Closes Supabase advisor SECURITY DEFINER alerts on contact_tags and
-- opportunity_tags. These views were created in migration 021 before we
-- had the security-invoker pattern established (migration 039 converted
-- the other analytics views but missed these two — they're in a separate
-- migration file so they weren't in the batch).
--
-- Base table tag_history has RLS on with tenant_iso policy. Under
-- SECURITY INVOKER the views run with the caller's privileges, so anon-key
-- reads correctly filter through tag_history's RLS.
--
-- Service role bypasses RLS as it does everywhere else — admin analytics
-- and the daily crons are unaffected.

ALTER VIEW contact_tags     SET (security_invoker = true);
ALTER VIEW opportunity_tags SET (security_invoker = true);

COMMENT ON VIEW contact_tags IS
  'Contact→tag active mapping. SECURITY INVOKER — base-table (tag_history) RLS applies to anon-key reads. Service role bypasses RLS for admin/analytics.';
COMMENT ON VIEW opportunity_tags IS
  'Opportunity→tag active mapping. SECURITY INVOKER — base-table (tag_history) RLS applies to anon-key reads. Service role bypasses RLS for admin/analytics.';
