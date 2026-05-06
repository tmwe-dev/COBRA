// lib/booking-parser.js — Booking state parser (flight, hotel, train)
// Extracts params from user messages, merges follow-ups, builds URLs

// ── City → IATA mapping ──
const CITY_IATA = {
  'milano': 'MXP', 'malpensa': 'MXP', 'linate': 'LIN', 'roma': 'FCO', 'fiumicino': 'FCO',
  'napoli': 'NAP', 'torino': 'TRN', 'venezia': 'VCE', 'bologna': 'BLQ', 'firenze': 'FLR',
  'palermo': 'PMO', 'catania': 'CTA', 'bari': 'BRI', 'bergamo': 'BGY', 'orio': 'BGY',
  'pisa': 'PSA', 'genova': 'GOA', 'verona': 'VRN', 'cagliari': 'CAG', 'olbia': 'OLB',
  'bangkok': 'BKK', 'londra': 'LHR', 'london': 'LHR', 'parigi': 'CDG', 'paris': 'CDG',
  'new york': 'JFK', 'newyork': 'JFK', 'los angeles': 'LAX', 'tokyo': 'NRT', 'dubai': 'DXB',
  'amsterdam': 'AMS', 'barcellona': 'BCN', 'madrid': 'MAD', 'berlino': 'BER', 'monaco': 'MUC',
  'istanbul': 'IST', 'atene': 'ATH', 'lisbona': 'LIS', 'vienna': 'VIE', 'praga': 'PRG',
  'zurigo': 'ZRH', 'ginevra': 'GVA', 'bruxelles': 'BRU', 'singapore': 'SIN', 'hong kong': 'HKG',
  'sydney': 'SYD', 'miami': 'MIA', 'chicago': 'ORD', 'san francisco': 'SFO', 'toronto': 'YYZ',
  'mosca': 'SVO', 'cairo': 'CAI', 'mumbai': 'BOM', 'delhi': 'DEL', 'pechino': 'PEK',
  'shanghai': 'PVG', 'seoul': 'ICN', 'kuala lumpur': 'KUL', 'bali': 'DPS', 'maldive': 'MLE',
  'tenerife': 'TFS', 'ibiza': 'IBZ', 'mykonos': 'JMK', 'santorini': 'JTR', 'creta': 'HER',
  'sharm': 'SSH', 'marrakech': 'RAK', 'zanzibar': 'ZNZ', 'nairobi': 'NBO',
};

// ── Cabin mapping for Google Flights ──
const CABIN_MAP = { 'economy': 1, 'premium': 2, 'business': 3, 'first': 4, 'prima': 4 };

/**
 * Extract booking params from a user message (first turn)
 * Returns null if message is not a booking request
 */
function extractBookingParams(text) {
  const t = text.toLowerCase();
  const IS_FLIGHT = /\b(volo|voli|flight|flights|aereo|aerei|prenota.*volo|bigliett.*aere)\b/i;
  if (!IS_FLIGHT.test(t)) return null;

  let origin = null, originRaw = null, destination = null, destinationRaw = null, cabin = 'economy';

  // "da X a Y" / "da X per Y" / "X-Y" / "X → Y"
  const routePatterns = [
    /\bda\s+(\w[\w\s]{1,20}?)\s+(?:a|per|verso)\s+(\w[\w\s]{1,20}?)(?:\s+in\s+|\s*$|\s*,)/i,
    /\bfrom\s+(\w[\w\s]{1,20}?)\s+to\s+(\w[\w\s]{1,20}?)(?:\s+in\s+|\s*$|\s*,)/i,
    /\b(?:su|per|verso|to)\s+(\w[\w\s]{1,20}?)(?:\s+da\s+(\w[\w\s]{1,20}?))?/i,
  ];

  for (const re of routePatterns) {
    const m = t.match(re);
    if (m) {
      if (re === routePatterns[2]) {
        // "su bangkok da milano" — destination first
        destinationRaw = m[1].trim();
        if (m[2]) originRaw = m[2].trim();
      } else {
        originRaw = m[1].trim();
        destinationRaw = m[2].trim();
      }
      break;
    }
  }

  if (originRaw) origin = resolveIATA(originRaw);
  if (destinationRaw) destination = resolveIATA(destinationRaw);

  // Cabin class
  if (/\bbusiness\b/i.test(t)) cabin = 'business';
  else if (/\bfirst\s*class|prima\s*classe\b/i.test(t)) cabin = 'first';
  else if (/\bpremium\b/i.test(t)) cabin = 'premium';

  if (!destination) return null;

  return {
    type: 'flight', origin, originRaw, destination, destinationRaw, cabin,
    departureDate: extractDepartureDate(t),
    returnDate: null,
    tripType: extractTripType(t),
    passengers: extractPassengers(t),
  };
}

function resolveIATA(cityName) {
  const normalized = cityName.toLowerCase().trim();
  if (CITY_IATA[normalized]) return CITY_IATA[normalized];
  // Partial match
  for (const [key, code] of Object.entries(CITY_IATA)) {
    if (normalized.includes(key) || key.includes(normalized)) return code;
  }
  // If it looks like an IATA code already (3 uppercase letters)
  if (/^[A-Z]{3}$/i.test(cityName.trim())) return cityName.trim().toUpperCase();
  return null;
}

// ── Date extraction ──
function extractDepartureDate(text, now = new Date()) {
  const t = text.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

  // Explicit date: 15/06, 15-06-2026, 2026-06-15
  const explicitDate = t.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
  if (explicitDate) {
    let day = parseInt(explicitDate[1]);
    let month = parseInt(explicitDate[2]);
    let year = explicitDate[3] ? parseInt(explicitDate[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    if (day > 12 && month <= 12) { /* day/month format, ok */ }
    else if (month > 12) { [day, month] = [month, day]; }
    const d = new Date(year, month - 1, day);
    if (d < now) d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  }

  // "domani" / "dopodomani"
  if (/\bdomani\b/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }
  if (/\bdopodomani\b/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 2); return d.toISOString().slice(0, 10); }

  // "mercoledi prossimo" / "lunedi" etc.
  const weekdays = { lunedi: 1, martedi: 2, mercoledi: 3, giovedi: 4, venerdi: 5, sabato: 6, domenica: 0 };
  const hasProssimo = /\bprossim/i.test(t);
  for (const [name, day] of Object.entries(weekdays)) {
    if (t.includes(name)) {
      return nextWeekdayISO(now, day, hasProssimo);
    }
  }

  // Italian month names: "15 giugno", "giugno 15"
  const months = { gennaio: 0, febbraio: 1, marzo: 2, aprile: 3, maggio: 4, giugno: 5, luglio: 6, agosto: 7, settembre: 8, ottobre: 9, novembre: 10, dicembre: 11 };
  for (const [mName, mIdx] of Object.entries(months)) {
    const re = new RegExp(`(\\d{1,2})\\s+${mName}|${mName}\\s+(\\d{1,2})`, 'i');
    const m = t.match(re);
    if (m) {
      const day = parseInt(m[1] || m[2]);
      const d = new Date(now.getFullYear(), mIdx, day);
      if (d < now) d.setFullYear(d.getFullYear() + 1);
      return d.toISOString().slice(0, 10);
    }
  }

  return null;
}

function nextWeekdayISO(now, targetDay, isProssimo) {
  const d = new Date(now);
  const currentDay = d.getDay();
  let delta = targetDay - currentDay;

  if (isProssimo) {
    // "prossimo" = always next week
    if (delta <= 0) delta += 7;
    if (delta < 7) delta += 0; // already next occurrence
    // If tomorrow is the target and user said "prossimo", skip to next week
    if (delta === 1 && isProssimo) {
      // "mercoledi prossimo" said on martedi = could be tomorrow or next week
      // For travel booking: prefer next week (safer)
      delta += 7;
    }
  } else {
    // Without "prossimo", next occurrence
    if (delta <= 0) delta += 7;
  }

  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ── Trip type ──
function extractTripType(text) {
  if (/\b(sola andata|solo andata|one[- ]?way)\b/i.test(text)) return 'one_way';
  if (/\b(andata e ritorno|round[- ]?trip|a\/r)\b/i.test(text)) return 'round_trip';
  return null;
}

// ── Passengers ──
function extractPassengers(text) {
  if (/\b(solo io|soltanto io|io solo|just me|only me)\b/i.test(text)) return 1;
  if (/\b(io e (?:mia |il mio )?(?:moglie|marito|compagn[oa]|partner))\b/i.test(text)) return 2;
  const m = text.match(/\b(\d+)\s*(passegger|person[ae]|adulti|adulto|pax|bigliett)/i);
  if (m) return parseInt(m[1]);
  return null;
}

// ── Missing fields ──
function getMissingFlightFields(params) {
  const missing = [];
  if (!params.departureDate) missing.push('data di partenza');
  if (!params.tripType) missing.push('solo andata o andata e ritorno');
  if (!params.passengers) missing.push('numero passeggeri');
  if (!params.origin) missing.push('aeroporto di partenza');
  if (!params.destination) missing.push('destinazione');
  return missing;
}

// ── Merge follow-up ──
function mergeFlightFollowup(existing, text) {
  return {
    ...existing,
    departureDate: extractDepartureDate(text) || existing.departureDate,
    returnDate: existing.returnDate, // TODO: extract return date
    tripType: extractTripType(text) || existing.tripType,
    passengers: extractPassengers(text) || existing.passengers,
    // Re-extract origin/destination in case user corrects
    origin: resolveIATA(text) || existing.origin,
    destination: existing.destination,
  };
}

// ── Build Google Flights URL ──
function buildFlightUrl(params) {
  // Google Flights URL format:
  // https://www.google.com/travel/flights?q=Flights+to+BKK+from+MXP+on+2026-05-13+one+way+business
  // Or the direct booking path:
  const origin = params.origin || 'MXP';
  const dest = params.destination || '';
  const date = params.departureDate || '';
  const cabinCode = CABIN_MAP[params.cabin] || 1;
  const pax = params.passengers || 1;

  // Build clean URL
  let url = `https://www.google.com/travel/flights?hl=it&curr=EUR`;
  url += `&tfs=CBwQ`;  // base param

  // Simpler: use the search query format which Google Flights understands
  const tripLabel = params.tripType === 'one_way' ? 'one way' : 'round trip';
  const cabinLabel = params.cabin || 'economy';
  url = `https://www.google.com/travel/flights?q=Flights+to+${dest}+from+${origin}+on+${date}+${tripLabel.replace(/ /g, '+')}+${cabinLabel}&curr=EUR&hl=it`;

  return url;
}

module.exports = {
  extractBookingParams, extractDepartureDate, extractTripType, extractPassengers,
  mergeFlightFollowup, getMissingFlightFields, buildFlightUrl, resolveIATA,
  CITY_IATA, CABIN_MAP,
};
