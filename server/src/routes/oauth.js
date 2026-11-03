import express from 'express';
import { exchangeCodeForToken, upsertInstall } from '../services/ghlClient.js';
import { upsertAgencyInstall, syncAgencyLocations } from '../services/agencyInstall.js';
import { logger } from '../utils/logger.js';
import { rawQuery } from '../db.js';

export const oauthRouter = express.Router();

// Install flow:
//   1. Agency clicks "Install" in the GHL Marketplace
//   2. GHL redirects browser → ${PUBLIC_BASE_URL}/oauth/callback?code=...
//   3. We exchange the code for an access+refresh token pair (ghlClient)
//   4. We upsert an installs row (T₀ anchor set on first install)
//   5. Webhook subscriptions are declared at the app level in GHL's
//      developer dashboard, so events start flowing automatically.
//
// Note: there is intentionally NO `/oauth/uninstall` route. GHL delivers
// UNINSTALL events through the main webhook URL (`/webhooks/ghl`) where
// the RSA signature IS verified — handled by routes/webhooks.js when the
// event type === 'UNINSTALL'. Exposing a second unauthenticated endpoint
// would let anyone with a locationId clear tokens; we don't want that.
// The page a person sees after clicking Install. It used to be one line of
// unstyled text with raw counts in it — "0 sub-account(s) enabled" read as a
// failure for an install that had worked. This says what happened, in
// words, on a page that looks intended.
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function installPage({ title, lead, body = [] }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#252c38}
  .card{max-width:520px;margin:24px;padding:32px 36px;background:#fff;border:1px solid #e2e6ec;border-radius:14px;
        box-shadow:0 8px 24px rgba(16,24,40,.08)}
  .ok{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;
      background:#e6f4ee;color:#1f7a5c;font-size:22px;margin-bottom:14px}
  h1{margin:0 0 6px;font-size:20px;font-weight:600}
  .lead{margin:0 0 14px;font-size:16px;font-weight:500;color:#0f7f8b}
  p{margin:0 0 10px;font-size:14px;line-height:1.55;color:#4b515c}
</style></head><body><div class="card"><div class="ok">&#10003;</div>
<h1>${esc(title)}</h1><p class="lead">${esc(lead)}</p>${body.map((b) => `<p>${esc(b)}</p>`).join('')}
</div></body></html>`;
}

oauthRouter.get('/callback', async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).send('Missing authorization code from GHL.');
    }

    const tokens = await exchangeCodeForToken(String(code));
    // AGENCY INSTALL: a Company token with no locationId. Record it, then
    // mint a sub-account token for every location the agency enabled the
    // app on. Locations ticked later arrive as INSTALL webhooks (routes/
    // webhooks.js) and are minted there.
    if (!tokens.locationId && tokens.companyId
        && String(tokens.userType || '').toLowerCase() === 'company') {
      await upsertAgencyInstall(tokens);
      let synced = { wanted: 0, minted: 0, kept: 0, removed: 0, failed: [] };
      let listFailed = false;
      try { synced = await syncAgencyLocations(tokens.companyId); }
      catch (err) {
        listFailed = true;
        logger.warn({ err, status: err.response?.status, body: err.response?.data, companyId: tokens.companyId },
          'oauth: agency install recorded, location sync failed');
      }
      // What we actually HOLD for this agency, which is the honest number:
      // the sub-accounts GHL announces by INSTALL webhook are minted within
      // seconds of the install and may already be here, whether or not the
      // list call above worked.
      const { rows: held } = await rawQuery(
        `SELECT location_id FROM installs
          WHERE company_id = $1 AND uninstalled_at IS NULL AND reauth_required_at IS NULL`,
        [tokens.companyId]
      );
      logger.info({ companyId: tokens.companyId, ...synced, listFailed, held: held.length }, 'oauth: agency install recorded');
      return res.type('html').send(installPage({
        title: 'Deal Hub is installed for your agency',
        lead: held.length
          ? `${held.length} sub-account${held.length === 1 ? ' is' : 's are'} connected.`
          : 'Your selected sub-accounts are being connected now.',
        body: [
          'Each sub-account you selected is connected automatically within a few seconds of installing, ' +
          'and any you add later is connected the same way.',
          synced.failed.length
            ? `${synced.failed.length} sub-account${synced.failed.length === 1 ? '' : 's'} could not be connected yet; it will be retried, and the server log names ${synced.failed.length === 1 ? 'it' : 'them'}.`
            : null,
          'Deal Hub appears in each connected sub-account\'s sidebar. You can close this window.'
        ].filter(Boolean)
      }));
    }
    if (!tokens.locationId) {
      // NEVER log `tokens` — it holds accessToken and refreshToken, and
      // pino's redact paths cover HEADERS only ('*.headers.authorization'),
      // so a top-level token field is written in clear. This line was putting
      // live OAuth credentials into the application log on every
      // company-level install attempt.
      logger.warn(
        { companyId: tokens.companyId || null, userType: tokens.userType || null },
        'oauth: install lacks locationId — company-level install rejected'
      );
      return res.status(400).send(
        'This app currently supports sub-account (Location) installs only. ' +
        'Please install from inside the target sub-account.'
      );
    }

    const install = await upsertInstall(tokens);
    logger.info(
      { locationId: install.location_id, companyId: install.company_id },
      'oauth: install recorded'
    );

    res.type('html').send(installPage({
      title: 'Deal Hub is installed',
      lead: 'This sub-account is connected.',
      body: ['Deal Hub now appears in the sidebar, and the deal history for this sub-account is being collected. You can close this window.']
    }));
  } catch (err) {
    next(err);
  }
});
