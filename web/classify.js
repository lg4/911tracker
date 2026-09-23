// Incident category classification, extracted from index.html into its own loadable
// script so classify() can be unit-tested in node (see test/classify.test.js). Loaded as
// a plain browser <script src="./classify.js"> before the main inline script — the same
// pattern as ./config.js and ./csvExport.js. Attaches CATS / classify to globalThis.
(function (root) {
  // T8: raw feed types are far too varied and numerous to show as chips individually,
  // so classify each incident into one of these for filtering and heat coloring.
  const CATS = [
    { key: 'police', label: 'Police', color: '#4361ee' },
    { key: 'fire', label: 'Fire', color: '#e63946' },
    { key: 'ems', label: 'EMS', color: '#2a9d8f' },
    // T29: civil/welfare assistance calls that match none of the service keywords
    // ("ASSIST", "VTL COMPLAINT", "MVA-UNKNOWN", "RUNAWAY", …) — previously ~44 rows
    // of the 67-row Other bucket; uninterpretable CAD noise stays in other.
    { key: 'civil', label: 'Civil', color: '#f4a261' },
    { key: 'other', label: 'Other', color: '#9aa0b4' },
  ];
  // T14 / T31: numeric CAD dispatch codes (06D02-BREATHING PROBLEMS, 31D04-UNCONSCIOUS/
  // FAINTING, 33C07-TRANSFER, …) all follow the XX?YY shape and are EMS responses. The
  // third char is any letter in practice — the feed's alphabet runs A/B/C/D/O (e.g.
  // 16A01-EYE PROBLEMS, 26O06-SICK PERSON), not just B/C/D, so a narrower [BCD] class let
  // real medical rows fall through to other. No police/fire type uses this numeric prefix
  // shape in the feed, so matching on it can't mis-bucket those.
  const EMS_CODE_RX = /^\d{2}[A-Z]\d{2}\b/i;
  const CATEGORY_RX = {
    // T29: elevator entrapments are handled by the FD like any other technical rescue.
    fire: /\b(FIRE|BURN(?:ING)?|SMOKE|CARBON MONOXIDE|HAZMAT|CHEMICAL|ALARM|ELEVATOR RESCUE)\b|MVA-FD/i,
    // No bare ASSIST here: it is tested before police and would sink police-support
    // types ("POLICE ASSIST", "OFFICER ASSIST") into EMS. A standalone "ASSIST" row
    // falls through to civil — safer than mis-bucketing a support call as EMS.
    ems: /\b(EMS|MEDICAL|AMBULANCE|TRANSFER|SICK|INJUR\w*|HEART\b|STROKE|LACERATION|HEMORRHAGE|CHEST PAIN|FALL(?:EN)?|OVERDOSE|UNRESPONSIVE|UNCONSCIOUS|FAINTING|RESPIRAT\w*|BREATH(?:ING)?|CARDIAC|SEIZURE|CONVULSI\w*|DIABETIC|BP READ)\b|MVA-MED/i,
    police: /\b(POLICE|OFFICER|DOMESTIC|TRESPASS\S*|SUSPICIOUS|MISSING PERSON|CRIMINAL|CRIM\b|WELFARE|THEFT|ROBBERY|ASSAULT|FIGHT\b|DISORDERLY|SHOOTING|REPORT\w*|DRUG\S*|DISPUTE|LARCENY|HARASSMENT|FRAUD|BURGLARY|LOCKOUT|NOISE COMPLAINT|SHOTS FIRED|VEHICLE STOLEN|ORDER OF PROTECTION|PROPERTY (?:FOUND|LOST)|TRAFFIC HAZARD|DISABLED VEHICLE|PREMISE CHECK|INVESTIGAT\w*|JUVENILE|NEIGHBOR PROBLEM|ANIMAL)\b|\bPD\b|MVA-PD/i,
    // T29: tested AFTER police so "POLICE ASSIST" / "NOISE COMPLAINT"-style rows keep
    // their current buckets; only the residual civil/welfare-assistance set lands here.
    // F{1,2}O{1,2}UND tolerates feed typos ("FOOUND PERSON").
    civil: /\b(ASSIST(?:ANCE)?|VTL|RUNAWAY|F{1,2}O{1,2}UND PERSON|TRAFFIC COMPLAINT|MVA-UNKNOWN|MVA-PI|STATUS CHECK)\b/i,
  };
  function classify(f) {
    const type = (f.properties.type ?? '').toUpperCase();
    const text = `${type} ${f.properties.title ?? ''}`.toUpperCase();
    if (CATEGORY_RX.fire.test(text)) return 'fire';
    if (EMS_CODE_RX.test(type) || CATEGORY_RX.ems.test(text)) return 'ems';
    if (CATEGORY_RX.police.test(text)) return 'police';
    if (CATEGORY_RX.civil.test(text)) return 'civil';
    return 'other';
  }
  root.CATS = CATS;
  root.classify = classify;
})(typeof globalThis !== 'undefined' ? globalThis : this);
