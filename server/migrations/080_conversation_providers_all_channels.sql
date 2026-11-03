-- 080_conversation_providers_all_channels.sql
--
-- Two bugs kept the provider catalogue at a fraction of its real size, and
-- they compounded: the sync only ever ASKED for SMS and Email, and this
-- table would have REJECTED anything else if it had.
--
-- A live location returned six providers in one channel group alone —
-- WhatsApp QR, iMessage, SMS Android (type SMS) and Android Voice, iMessage
-- Voice, WhatsApp Voice (type Call). The three Call rows could never be
-- stored: CHECK (type IN ('SMS','Email')) fails the INSERT outright. So the
-- app showed five providers not because five exist, but because the rest
-- were structurally unstorable.
--
-- Widened to GHL's full conversation-channel set rather than just the two
-- extra types we happen to have seen. The list mirrors GHL's native channel
-- catalogue (SMS, RCS, Email, WhatsApp, IG, FB, TikTok, Live_Chat) plus
-- Call, which the live response above confirms is a real provider type.
--
-- Deliberately a CHECK and not an enum: GHL adds channels (RCS and TikTok
-- are both recent), and a CHECK is one ALTER to widen, whereas an enum needs
-- a type migration. 'Unknown' is the escape hatch so a channel GHL ships
-- tomorrow lands as a row we can see rather than a failed sync we can't.

ALTER TABLE conversation_providers
  DROP CONSTRAINT IF EXISTS conversation_providers_type_check;

ALTER TABLE conversation_providers
  ADD CONSTRAINT conversation_providers_type_check
  CHECK (type IN (
    'SMS', 'RCS', 'Email', 'WhatsApp', 'IG', 'FB',
    'TIKTOK', 'Live_Chat', 'Call', 'Unknown'
  ));

COMMENT ON COLUMN conversation_providers.type IS
  'GHL conversation channel this provider serves. Widened in 080 from (SMS,Email) — the old constraint silently made Call/WhatsApp/IG/FB/TikTok/RCS/Live_Chat providers unstorable. Unknown is the forward-compatibility escape hatch for a channel GHL ships before we widen again.';

-- A location can run native SMS *and* a custom provider literally named
-- "SMS" — GHL allows it, and our first screenshot of a real account shows
-- exactly this shape (a provider named "WhatsApp QR" alongside native
-- WhatsApp). The UI has to disambiguate those two, so it needs to find
-- same-name providers within a channel cheaply.
CREATE INDEX IF NOT EXISTS conversation_providers_name_lookup_idx
  ON conversation_providers (location_id, type, lower(name))
  WHERE is_deleted = false;
