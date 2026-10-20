/* First-party, tab-scoped booking source. No patient data, URLs or advertising click IDs are retained. */
(function (root) {
  'use strict';
  const KEY = 'crispr_booking_source_v1', TTL = 30 * 24 * 60 * 60 * 1000;
  const channels = ['unknown','google_ads','google_business','google_organic','meta_ads','instagram_organic','referral','practo','direct'];
  function sanitize(input) {
    if (!input || typeof input !== 'object' || !channels.includes(input.channel)) return {channel:'unknown',campaign_id:null,evidence:'unknown'};
    const channel = input.channel;
    return {channel,campaign_id:channel!=='unknown'&&/^\d{1,30}$/.test(String(input.campaign_id||''))?String(input.campaign_id):null,evidence:channel==='unknown'?'unknown':['link_tag','referrer'].includes(input.evidence)?input.evidence:'unknown'};
  }
  function classify(address, referrer) {
    let u;try{u=new URL(address);}catch{return sanitize(null);}
    const source=(u.searchParams.get('utm_source')||'').toLowerCase(),medium=(u.searchParams.get('utm_medium')||'').toLowerCase(),campaign=(u.searchParams.get('utm_campaign')||'').toLowerCase();
    const id=u.searchParams.get('campaign_id')||u.searchParams.get('utm_id');let channel='unknown',evidence='link_tag';
    if(u.searchParams.has('gclid')||u.searchParams.has('gbraid')||u.searchParams.has('wbraid')||source==='google_ads'||source==='google'&&['cpc','ppc','paid'].includes(medium))channel='google_ads';
    else if(source==='google_business'||source==='google_business_profile'||source==='google'&&['gbp','gmb','business_profile'].includes(campaign))channel='google_business';
    else if(source==='meta_ads'||['facebook','instagram','meta'].includes(source)&&['cpc','paid','paid_social'].includes(medium))channel='meta_ads';
    else if(source==='instagram_organic'||source==='instagram')channel='instagram_organic';
    else if(source==='practo')channel='practo';
    else if(source==='google'&&medium==='organic')channel='google_organic';
    else {try{const r=new URL(referrer);if(r.hostname!==u.hostname){evidence='referrer';if(/(^|\.)google\.(com|co\.in)$/.test(r.hostname))channel='google_organic';else if(/(^|\.)instagram\.com$/.test(r.hostname))channel='instagram_organic';else if(/(^|\.)practo\.com$/.test(r.hostname))channel='practo';}}catch{}}
    return sanitize({channel,campaign_id:id,evidence});
  }
  function capture(address,referrer,storage,now) {
    const found=classify(address,referrer);let prior=null;
    try{const item=JSON.parse(storage.getItem(KEY)||'null');if(item&&Number.isFinite(item.at)&&item.at<=now&&now-item.at<TTL)prior=sanitize(item.source);}catch{}
    const source=found.channel!=='unknown'?found:prior||found;
    try{storage.setItem(KEY,JSON.stringify({at:found.channel!=='unknown'?now:prior?JSON.parse(storage.getItem(KEY)).at:now,source}));}catch{}
    return source;
  }
  const api={classify,sanitize,capture};
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(!root||!root.location)return;
  let source=sanitize(null);function refresh(referrer){source=capture(root.location.href,referrer||'',root.sessionStorage,Date.now());}
  // Storage may be disabled; source capture must never prevent a booking.
  try{refresh(root.document.referrer);}catch{source=classify(root.location.href,root.document.referrer);}
  const allowed=['booking_started','booking_verified','booking_completed','booking_failed','booking_rescheduled'];
  root.CrisprMarketing={source:()=>({...source}),event:(name)=>{if(allowed.includes(name)&&typeof root.gtag==='function')root.gtag('event',name,{event_category:'booking',transport_type:'beacon'});}};
  root.document.addEventListener('astro:page-load',()=>{try{refresh();}catch{}});
})(typeof window!=='undefined'?window:null);
