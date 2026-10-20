// Only finite source labels and numeric campaign IDs cross into the clinic database.
// These are link/referrer indications, not verified advertising conversions.
const allowed = new Set(['unknown','google_ads','google_business','google_organic','meta_ads','instagram_organic','referral','practo','direct']);
exports.source = function(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !allowed.has(input.channel)) return {channel:'unknown',campaign_id:null,evidence:'unknown'};
  return {channel:input.channel,campaign_id:input.channel!=='unknown'&&/^\d{1,30}$/.test(String(input.campaign_id||''))?String(input.campaign_id):null,evidence:input.channel==='unknown'?'unknown':['link_tag','referrer'].includes(input.evidence)?input.evidence:'unknown'};
};
