import React, { useState, useRef } from 'react';
import * as Location from 'expo-location';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity,
  TextInput, Platform, StatusBar, ActivityIndicator,
  Linking, useWindowDimensions, KeyboardAvoidingView,
  SafeAreaView, Animated,
} from 'react-native';

// ─── ENV KEYS ────────────────────────────────────────────────────────────────
const PLACES_KEY  = process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY  || '';
const FSQ_KEY     = process.env.EXPO_PUBLIC_FOURSQUARE_API_KEY || '';
const GEMINI_KEY  = process.env.EXPO_PUBLIC_GEMINI_API_KEY     || '';

// ─── THEME ───────────────────────────────────────────────────────────────────
const C = {
  bg:      '#0a0a0a',
  s1:      '#111111',
  s2:      '#181818',
  s3:      '#202020',
  s4:      '#2a2a2a',
  border:  'rgba(255,255,255,0.08)',
  border2: 'rgba(255,255,255,0.16)',
  text:    '#ffffff',
  muted:   'rgba(255,255,255,0.55)',
  dim:     'rgba(255,255,255,0.28)',
  green:   '#00E676',
  green2:  '#00C853',
  red:     '#FF5252',
  blue:    '#448AFF',
  orange:  '#FF6D00',
  purple:  '#D500F9',
  gold:    '#FFD740',
};

const CARD_COLS = ['#00E676','#FF5252','#448AFF','#FF6D00','#D500F9','#FFD740','#00E5FF','#76FF03'];

// ─── RESPONSIVE ──────────────────────────────────────────────────────────────
function useScale() {
  const { width } = useWindowDimensions();
  const isTablet = width >= 600;
  return { fs: (p, t) => isTablet ? t : p, isTablet };
}

// ─── DATA ─────────────────────────────────────────────────────────────────────
const MEALS      = ['Breakfast','Brunch','Lunch','Dinner','Late Night','Coffee & Snacks'];
const FOOD_STYLES = ['Café','Bakery','Restaurant','Pub','Bar','Food Truck','Roadside Diner','Fine Dining','Takeaway'];
const KEYWORDS   = ['Burgers','Fried Chicken','Pizza','Pie','Fish & Chips','Tacos','Dumplings','Ramen','Pasta','Steak','Seafood','Vegan','Dessert','Coffee','Cocktails','Cheap Eats','BYO','Date Night','Family Friendly'];

// ─── ALGORITHM ───────────────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r, dLng = (lng2 - lng1) * d2r;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*d2r) * Math.cos(lat2*d2r) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function hardFilter(places, cLat, cLng, radiusM) {
  return places.filter(p => {
    const lat = p.geometry?.location?.lat;
    const lng = p.geometry?.location?.lng;
    if (lat == null || lng == null) return false;
    return haversineKm(cLat, cLng, lat, lng) <= radiusM / 1000;
  });
}

function nameSim(a, b) {
  a = a.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  b = b.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (a === b) return 1.0;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const wa = new Set(a.split(/\s+/).filter(w => w.length > 2));
  const wb = new Set(b.split(/\s+/).filter(w => w.length > 2));
  const overlap = [...wa].filter(w => wb.has(w)).length;
  if (!wa.size || !wb.size) return 0;
  return overlap / Math.max(wa.size, wb.size);
}

function stumbleScore(gPlace, fsqMatch) {
  const gRating  = gPlace.rating || 0;
  const gReviews = gPlace.user_ratings_total || 0;
  const gPhotos  = gPlace.photos?.length || 0;
  const gPrice   = gPlace.price_level || 2;

  // Use square root instead of log so low review counts don't kill good new places
  // A place with 4.8 stars and 30 reviews scores better than 4.2 stars and 500 reviews
  const googleScore       = gRating * Math.sqrt(Math.max(gReviews, 1));
  // Normalise so scores stay reasonable — divide by 20
  const normalisedGoogle  = googleScore / 20;
  const photoBonus        = Math.min(gPhotos * 0.15, 3.0);
  // Stronger price-quality bonus — cheap + great is what stumble is all about
  const priceQualityBonus = gRating >= 4.2 ? (5 - gPrice) * 0.6 : 0;
  // High rating bonus — rewards quality regardless of review count
  // This helps newer quality spots like Frangos Kent St (4.2★, recently opened)
  const highRatingBonus   = gRating >= 4.5 ? 3.0 : gRating >= 4.2 ? 1.5 : 0;
  let fsqScore = 0, fsqTips = 0, fsqTastes = [];
  if (fsqMatch) {
    const fsqRating  = (fsqMatch.rating || 0) / 2;
    fsqTips          = fsqMatch.stats?.total_tips || 0;
    const fsqPhotos  = fsqMatch.stats?.total_photos || 0;
    fsqTastes        = fsqMatch.tastes || [];
    fsqScore = (fsqRating * Math.log10(Math.max(fsqTips, 1) + 1) * 1.5) + Math.min(fsqPhotos * 0.05, 2.0);
  }
  const crossBonus        = fsqMatch ? 2.5 : 0;
  const consistencyBonus  = fsqMatch && gRating >= 4.0 && (fsqMatch.rating || 0) / 2 >= 4.0 ? 1.5 : 0;
  const sweetSpotBonus    = gReviews >= 20 && gReviews <= 800 ? 1.0 : 0;
  return {
    total: normalisedGoogle + photoBonus + priceQualityBonus + highRatingBonus + fsqScore + crossBonus + consistencyBonus + sweetSpotBonus,
    fsqTips, fsqTastes, isVerified: !!fsqMatch, fsqRating: fsqMatch?.rating || null,
  };
}

function smartRadius(place, types) {
  const p = place.toLowerCase();
  // Street address = search whole suburb area not just 350m from front door
  if (types.includes('street_address') || types.includes('route') ||
      p.includes(' st') || p.includes(' street') || p.includes(' rd') ||
      p.includes(' ave') || p.includes(' lane')) return 1100;
  if (types.includes('neighborhood') || types.includes('sublocality')) return 900;
  if (types.includes('locality') || types.includes('postal_code')) {
    const big = ['sydney','melbourne','brisbane','perth','adelaide','canberra'];
    return big.some(c => p.includes(c)) ? 1400 : 1100;
  }
  return 1100;
}

// TEXT-FIRST SEARCH — multiple human-style phrases per keyword
// "best burger Sydney CBD" surfaces Bar Luca the way Google Maps would
const KW_TEXT_QUERIES = {
  'Burgers':        ['best burger', 'burger joint', 'smash burger', 'chicken burger', 'charcoal chicken burger', 'portuguese chicken'],
  'Fried Chicken':  ['best fried chicken', 'charcoal chicken', 'portuguese chicken', 'crispy fried chicken'],
  'Pizza':          ['best pizza', 'pizza restaurant', 'wood fired pizza', 'neapolitan pizza'],
  'Pie':            ['best pie', 'pie shop', 'meat pie', 'bakery pies'],
  'Fish & Chips':   ['best fish and chips', 'fish and chip shop', 'seafood takeaway'],
  'Tacos':          ['best tacos', 'mexican restaurant', 'taqueria'],
  'Dumplings':      ['best dumplings', 'dumpling house', 'dim sum', 'yum cha'],
  'Ramen':          ['best ramen', 'ramen restaurant', 'japanese noodles', 'tonkotsu ramen'],
  'Pasta':          ['best pasta', 'italian restaurant', 'pasta restaurant', 'trattoria'],
  'Steak':          ['best steak', 'steakhouse', 'steak restaurant', 'grill'],
  'Seafood':        ['best seafood', 'seafood restaurant', 'fish restaurant', 'oyster bar'],
  'Vegan':          ['best vegan restaurant', 'plant based restaurant', 'vegan cafe'],
  'Dessert':        ['best dessert', 'dessert cafe', 'patisserie', 'cake shop'],
  'Coffee':         ['best coffee', 'specialty coffee', 'best cafe', 'espresso bar'],
  'Cocktails':      ['best cocktails', 'cocktail bar', 'craft cocktails'],
  'Cheap Eats':     ['cheap eats', 'best value restaurant', 'affordable eats'],
  'BYO':            ['BYO restaurant', 'bring your own restaurant'],
  'Date Night':     ['best date night restaurant', 'romantic restaurant', 'fine dining'],
  'Family Friendly':['family restaurant', 'family friendly cafe', 'kids friendly restaurant'],
};

const MEAL_TEXT_QUERIES = {
  'Breakfast':       ['best breakfast', 'breakfast cafe', 'morning cafe', 'best brunch'],
  'Brunch':          ['best brunch', 'brunch cafe', 'weekend brunch'],
  'Lunch':           ['best lunch', 'lunch spot', 'lunch cafe', 'lunch restaurant'],
  'Dinner':          ['best dinner', 'dinner restaurant', 'evening restaurant'],
  'Coffee & Snacks': ['best coffee', 'best cafe', 'specialty coffee'],
  'Late Night':      ['late night food', 'late night restaurant', 'open late'],
};

// Google Place types to EXCLUDE based on keywords/meal
const KW_EXCLUDE_TYPES = {
  'Family Friendly': ['bar','night_club','liquor_store'],
  'Breakfast':       ['bar','night_club','liquor_store'],
  'Brunch':          ['bar','night_club','liquor_store'],
  'Coffee & Snacks': ['bar','night_club','liquor_store'],
  'Burgers':         ['night_club','liquor_store'],
  'Pizza':           ['night_club','liquor_store'],
  'Vegan':           ['night_club','liquor_store'],
};

// Name-based exclusion — catches bowling clubs, RSLs, leagues clubs etc
// UNLESS they have a food-specific word in their name (bistro, restaurant, cafe, kitchen)
const EXCLUDE_NAME_KEYWORDS = [
  'bowling club', 'bowling alley', 'rsl club', 'leagues club', 'bowls club',
  'golf club', 'sports club', 'rugby club', 'cricket club', 'football club',
  'soccer club', 'tennis club', 'netball club',
];

const FOOD_OVERRIDE_KEYWORDS = [
  'bistro', 'restaurant', 'cafe', 'kitchen', 'dining', 'eatery', 'grill', 'brasserie'
];

function isExcludedVenue(place, meal, keywords) {
  const name = (place.name || '').toLowerCase();
  const isClub = EXCLUDE_NAME_KEYWORDS.some(k => name.includes(k));
  if (!isClub) return false;
  // If the name also contains a food keyword, keep it (e.g. "RSL Bistro", "Surf Club Restaurant")
  const hasFood = FOOD_OVERRIDE_KEYWORDS.some(k => name.includes(k));
  return !hasFood;
}

function getExcludeTypes(meal, keywords) {
  const excluded = new Set();
  if (meal && KW_EXCLUDE_TYPES[meal]) KW_EXCLUDE_TYPES[meal].forEach(t => excluded.add(t));
  (keywords || []).forEach(k => {
    if (KW_EXCLUDE_TYPES[k]) KW_EXCLUDE_TYPES[k].forEach(t => excluded.add(t));
  });
  return excluded;
}

function buildTextQueries(meal, foodStyles, keywords, locationName) {
  const loc = locationName ? locationName.replace(/,.*$/, '').trim() : '';
  const queries = [];
  const seen = new Set();

  function addQuery(q) {
    const full = loc ? q + ' ' + loc : q;
    if (!seen.has(full)) { seen.add(full); queries.push(full); }
  }

  // Keywords first — most specific signal
  if (keywords && keywords.length) {
    keywords.forEach(function(k) {
      const kq = KW_TEXT_QUERIES[k] || [];
      kq.forEach(function(q) { addQuery(q); });
    });
  }

  // Meal queries
  if (meal) {
    const mq = MEAL_TEXT_QUERIES[meal] || [];
    mq.forEach(function(q) { addQuery(q); });
  }

  // Food styles
  if (foodStyles && foodStyles.length) {
    foodStyles.forEach(function(s) { addQuery('best ' + s.toLowerCase()); });
  }

  // Always add generic location quality searches to catch hidden gems
  if (loc) {
    addQuery('best cafe ' + loc);
    addQuery('best restaurant ' + loc);
    addQuery('hidden gem ' + loc);
  } else {
    addQuery('best cafe');
    addQuery('best restaurant');
  }

  return queries.slice(0, 6);
}

// ─── API CALLS ────────────────────────────────────────────────────────────────
async function geocode(place) {
  // Append Australia if no country hint — improves accuracy for AU addresses
  const query = place.includes('Australia') || place.match(/,\s*[A-Z]{2,3}$/) ? place : `${place}, Australia`;
  const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${PLACES_KEY}`);
  const d = await r.json();
  if (!d.results?.length) throw new Error(`Could not find: ${place}`);
  const res = d.results[0];
  return { lat: res.geometry.location.lat, lng: res.geometry.location.lng, types: res.types };
}

async function googleSearch(lat, lng, textQueries, radius) {
  const base = 'https://maps.googleapis.com/maps/api/place';

  // TEXT-FIRST APPROACH — search the way a human would
  // "best burger Bridge St Sydney" surfaces Bar Luca
  // "best breakfast Umina Beach" surfaces Ronto
  const textSearches = textQueries.map(q =>
    fetch(`${base}/textsearch/json?query=${encodeURIComponent(q)}&location=${lat},${lng}&radius=${radius}&key=${PLACES_KEY}`)
      .then(r => r.json())
  );

  // Nearby searches as safety net — catches anything text search misses
  // Include ALL food-relevant types including bar (Bar Luca) and bakery
  const nearbySearches = [
    fetch(`${base}/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=restaurant&rankby=prominence&key=${PLACES_KEY}`).then(r => r.json()),
    fetch(`${base}/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=cafe&rankby=prominence&key=${PLACES_KEY}`).then(r => r.json()),
    fetch(`${base}/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=bar&rankby=prominence&key=${PLACES_KEY}`).then(r => r.json()),
    fetch(`${base}/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=bakery&rankby=prominence&key=${PLACES_KEY}`).then(r => r.json()),
  ];

  const results = await Promise.all([...textSearches, ...nearbySearches]);
  const all = results.flatMap(d => d.results || []);
  // Text search results come first — they get priority in dedup
  const seen = new Set();
  return all.filter(p => { if (seen.has(p.place_id)) return false; seen.add(p.place_id); return true; });
}

async function googleDetails(placeId) {
  const r = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,vicinity,rating,user_ratings_total,price_level,editorial_summary,website,url,photos&key=${PLACES_KEY}`);
  const d = await r.json();
  return d.result || {};
}

async function foursquareSearch(lat, lng, query, radius) {
  try {
    const params = new URLSearchParams({ ll: `${lat},${lng}`, radius, query, limit: 40, fields: 'fsq_id,name,location,rating,stats,tastes,price,categories' });
    const r = await fetch(`https://api.foursquare.com/v3/places/search?${params}`, {
      headers: { Authorization: FSQ_KEY, Accept: 'application/json' }
    });
    if (!r.ok) return [];
    const d = await r.json();
    return d.results || [];
  } catch { return []; }
}

async function geminiDescribe(places, location, meal, keywords, foodStyles) {
  const kwList = [...(keywords || []), ...(foodStyles || [])].filter(Boolean);
  const mealLine = meal ? `CRITICAL RULE: You MUST ONLY include places that actually serve ${meal}. Any place that does not serve ${meal} must be completely removed from your JSON array.` : '';
  const kwLine = kwList.length
    ? `CRITICAL RULE: The user specifically wants ${kwList.join(' OR ')}. 
You MUST ONLY include places that directly serve or specialise in these items.
EXCLUDE: bars that don't serve food, venues that don't match the cuisine, anything unrelated.
EXAMPLES OF WHAT TO EXCLUDE:
- Searching "Burgers" → EXCLUDE Greek restaurants, Italian restaurants, bars, any place that doesn't serve burgers
- Searching "Pizza" → EXCLUDE bars, Asian restaurants, anything not pizza-focused  
- Searching "Family Friendly" → EXCLUDE bars, nightclubs, cocktail bars, adult venues
If fewer than 3 places match, only return the ones that do match — DO NOT pad with unrelated places.` : '';

  const list = places.map((p, i) => {
    const fsq = p.fsqTips > 0 ? `, Foursquare: ${p.fsqTips} tips` : '';
    const tag = p.isVerified ? ' [VERIFIED]' : '';
    return `${i+1}. ${p.name}${tag} — ${p.area} (Google: ${p.rating}★ ${p.reviewCount} reviews${fsq})`;
  }).join('\n');

  const prompt = `You are a local food scout. These are real verified spots in ${location}:

${list}

${mealLine}
${kwLine}

Write a profile for each SUITABLE place only. Skip unsuitable ones entirely.

Return ONLY a raw JSON array. No markdown. No backticks. Start with [ end with ].

Each object needs: name, area, category, rating (string), reviewCount (string), foursquareTips (string or ""), tastes (string, tags joined with · or ""), priceRange ("$"/"$$"/"$$$"), isVerified (bool), description (2-3 sentences local voice), mustTry (string), vibe (3-5 words), insiderTip (string), emoji (one emoji)`;

  const models = ['gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 3000 } })
      });
      const d = await r.json();
      if (!r.ok || d.error) continue;
      let text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
      text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      if (!text) continue;
      const s = text.indexOf('['), e = text.lastIndexOf(']');
      if (s === -1 || e === -1) continue;
      return JSON.parse(text.slice(s, e + 1));
    } catch { continue; }
  }
  throw new Error('Could not get descriptions. Try again.');
}

async function doSearch(location, meal, foodStyles, keywords) {
  const coords = await geocode(location);
  const radius = smartRadius(location, coords.types);
  const textQueries = buildTextQueries(meal, foodStyles, keywords, location);
  const fsqQuery = (keywords && keywords.length ? keywords[0] : meal) || 'cafe restaurant';
  const excludeTypes = getExcludeTypes(meal, keywords);

  // TEXT-FIRST: run all human-style queries in parallel
  const [googleRaw, fsqRaw] = await Promise.all([
    googleSearch(coords.lat, coords.lng, textQueries, radius),
    foursquareSearch(coords.lat, coords.lng, fsqQuery, radius),
  ]);

  let googleInRange = hardFilter(googleRaw, coords.lat, coords.lng, radius);
  const fsqInRange  = (fsqRaw || []).filter(p => {
    const lat = p.geocodes?.main?.latitude;
    const lng = p.geocodes?.main?.longitude;
    if (!lat || !lng) return false;
    return haversineKm(coords.lat, coords.lng, lat, lng) <= radius / 1000;
  });

  // Widen progressively until we have enough results
  if (googleInRange.length < 5) {
    const wider = await googleSearch(coords.lat, coords.lng, textQueries, Math.round(radius * 1.5));
    const widenedInRange = hardFilter(wider, coords.lat, coords.lng, Math.round(radius * 1.5));
    if (widenedInRange.length > googleInRange.length) googleInRange = widenedInRange;
  }
  if (googleInRange.length < 5) {
    const wider2 = await googleSearch(coords.lat, coords.lng, textQueries, Math.round(radius * 2.5));
    const widenedInRange2 = hardFilter(wider2, coords.lat, coords.lng, Math.round(radius * 2.5));
    if (widenedInRange2.length > googleInRange.length) googleInRange = widenedInRange2;
  }

  // Hard exclude unwanted venue types (bars for Family Friendly, night clubs for Breakfast etc)
  let googleFiltered = googleInRange.filter(p => {
    if ((p.rating || 0) < 3.8 || (p.user_ratings_total || 0) < 3) return false;
    if (isExcludedVenue(p, meal, keywords)) return false;
    if (excludeTypes.size > 0 && p.types) {
      if (p.types.some(t => excludeTypes.has(t))) return false;
    }
    return true;
  });
  // If fewer than 5 after strict filter, relax rating to 3.5
  if (googleFiltered.length < 5) {
    googleFiltered = googleInRange.filter(p => {
      if ((p.rating || 0) < 3.5 || (p.user_ratings_total || 0) < 3) return false;
      if (isExcludedVenue(p, meal, keywords)) return false;
      return true;
    });
  }

  const enriched = googleFiltered.map(gPlace => {
    let bestFsq = null, bestSim = 0;
    for (const fsq of fsqInRange) {
      const sim = nameSim(gPlace.name, fsq.name);
      if (sim > bestSim && sim >= 0.5) { bestSim = sim; bestFsq = fsq; }
    }
    const score = stumbleScore(gPlace, bestFsq);
    return { ...gPlace, ...score, bestFsq };
  });

  enriched.sort((a, b) => b.total - a.total);

  const withDetails = await Promise.all(enriched.slice(0, 10).map(async p => {
    const d = await googleDetails(p.place_id);
    return {
      place_id: p.place_id,
      name: p.name,
      area: d.vicinity || p.vicinity || location,
      rating: p.rating,
      reviewCount: p.user_ratings_total,
      priceLevel: d.price_level || p.price_level || 2,
      website: d.website || '',
      mapsUrl: d.url || `https://www.google.com/maps/place/?q=place_id:${p.place_id}`,
      fsqTips: p.fsqTips,
      fsqTastes: p.fsqTastes,
      isVerified: p.isVerified,
      stumbleScore: p.total,
    };
  }));

  return await geminiDescribe(withDetails, location, meal, keywords, foodStyles);
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────
function Pill({ label, active, color, onPress, S }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[s.pill, active && { borderColor: color, backgroundColor: color + '18' }]}
    >
      <Text style={[s.pillTxt, { fontSize: S.fs(12, 15) }, active && { color, fontWeight: '700' }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function GemCard({ item, index, S }) {
  const color = CARD_COLS[index % CARD_COLS.length];
  const [tipOpen, setTipOpen] = useState(false);

  const priceLabel = { 1: '$', 2: '$$', 3: '$$$', 4: '$$$$' }[item.priceLevel] || item.priceRange || '$$';

  const openMaps = async () => {
    try {
      // Use https maps search URL — always works on Android without manifest changes
      const query = encodeURIComponent((item.name || '') + ' ' + (item.area || ''));
      const url = `https://www.google.com/maps/search/?api=1&query=${query}`;
      await Linking.openURL(url);
    } catch (e) {
      console.log('Maps open error:', e);
    }
  };

  return (
    <View style={[s.card, { borderColor: C.border }]}>
      {/* Coloured stripe */}
      <View style={[s.cardStripe, { backgroundColor: color }]} />

      <View style={s.cardContent}>
        {/* Header */}
        <View style={s.cardHeader}>
          <View style={{ flex: 1 }}>
            <View style={s.cardTags}>
              <View style={[s.catBadge, { backgroundColor: color }]}>
                <Text style={[s.catBadgeTxt, { fontSize: S.fs(9, 11) }]}>{item.category?.toUpperCase()}</Text>
              </View>
              <Text style={[s.priceTag, { fontSize: S.fs(12, 14) }]}>{priceLabel}</Text>
              {item.rating ? (
                <View style={s.ratingRow}>
                  <Text style={[s.starIcon, { fontSize: S.fs(10, 12) }]}>★</Text>
                  <Text style={[s.ratingTxt, { fontSize: S.fs(12, 14) }]}>{item.rating}</Text>
                </View>
              ) : null}
              {item.reviewCount ? <Text style={[s.reviewCt, { fontSize: S.fs(10, 12) }]}>{item.reviewCount} reviews</Text> : null}
              {item.foursquareTips ? <Text style={[s.fsqTag, { fontSize: S.fs(10, 12) }]}>⬡ {item.foursquareTips}</Text> : null}
            </View>

            <Text style={[s.cardName, { fontSize: S.fs(18, 22), color: C.text }]}>{item.name}</Text>
            <Text style={[s.cardArea, { fontSize: S.fs(12, 14), color }]}>📍 {item.area}</Text>

            {item.isVerified && (
              <View style={[s.verifiedBadge, { marginTop: 6 }]}>
                <Text style={[s.verifiedTxt, { fontSize: S.fs(10, 12) }]}>✓ cross-verified</Text>
              </View>
            )}
          </View>

          <View style={[s.emojiBox, { backgroundColor: color + '18', borderColor: color + '40' }]}>
            <Text style={{ fontSize: S.fs(24, 30) }}>{item.emoji}</Text>
          </View>
        </View>

        {/* Description */}
        <Text style={[s.cardDesc, { fontSize: S.fs(13, 16) }]}>{item.description}</Text>

        {/* Tastes */}
        {!!item.tastes && (
          <View style={s.tastesRow}>
            {item.tastes.split('·').map(t => t.trim()).filter(Boolean).map((t, i) => (
              <View key={i} style={s.tasteTag}>
                <Text style={[s.tasteTxt, { fontSize: S.fs(10, 12) }]}>{t}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Info grid */}
        <View style={s.infoGrid}>
          <View style={s.infoCell}>
            <Text style={[s.infoCellLabel, { fontSize: S.fs(9, 11) }]}>MUST ORDER</Text>
            <Text style={[s.infoCellVal, { fontSize: S.fs(13, 15), fontStyle: 'italic' }]}>{item.mustTry}</Text>
          </View>
          <View style={s.infoCell}>
            <Text style={[s.infoCellLabel, { fontSize: S.fs(9, 11) }]}>VIBE</Text>
            <Text style={[s.infoCellVal, { fontSize: S.fs(13, 15) }]}>{item.vibe}</Text>
          </View>
        </View>

        {/* Insider tip */}
        <TouchableOpacity
          style={[s.tipBtn, tipOpen && { borderColor: color + '50' }]}
          onPress={() => setTipOpen(o => !o)}
        >
          <Text style={[s.tipBtnTxt, { fontSize: S.fs(12, 14) }, tipOpen && { color }]}>💬 insider tip</Text>
          <Text style={[s.tipArrow, tipOpen && { color }]}>{tipOpen ? '▲' : '▼'}</Text>
        </TouchableOpacity>

        {tipOpen && (
          <View style={[s.tipBody, { borderColor: color + '30', backgroundColor: color + '0a' }]}>
            <Text style={[s.tipBodyTxt, { fontSize: S.fs(13, 15) }]}>{item.insiderTip}</Text>
          </View>
        )}

        {/* Action buttons */}
        <View style={s.cardBtns}>
          <TouchableOpacity
            style={[s.actionBtn, s.mapsBtn]}
            onPress={() => Linking.openURL(item.mapsUrl)}
          >
            <Text style={[s.actionBtnTxt, { fontSize: S.fs(12, 14), color: '#6aa0ff' }]}>📍 maps</Text>
          </TouchableOpacity>
          {!!item.website && (
            <TouchableOpacity
              style={[s.actionBtn, s.webBtn]}
              onPress={() => Linking.openURL(item.website)}
            >
              <Text style={[s.actionBtnTxt, { fontSize: S.fs(12, 14), color: C.green }]}>🌐 website</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const S = useScale();
  const scrollRef = useRef(null);

  const [location, setLocation]     = useState('');
  const [locating, setLocating]      = useState(false);
  const [selMeal, setSelMeal]       = useState('');
  const [selStyles, setSelStyles]   = useState([]);
  const [selKws, setSelKws]         = useState([]);
  const [loading, setLoading]       = useState(false);
  const [results, setResults]       = useState(null);
  const [error, setError]           = useState('');
  const [loadStep, setLoadStep]     = useState(0);

  const LOAD_STEPS = [
    'searching google places…',
    'cross-referencing foursquare…',
    'calculating stumble scores…',
    'writing descriptions…',
  ];

  const canSearch = location.trim().length > 0;

  function toggleStyle(s) {
    setSelStyles(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);
  }
  function toggleKw(k) {
    setSelKws(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k]);
  }

  async function getMyLocation() {
    setLocating(true);
    setError('');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setError('Location permission denied. Type your location instead.');
        setLocating(false);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = pos.coords;

      // Reverse geocode to get suburb name
      const geo = await Location.reverseGeocodeAsync({ latitude, longitude });
      if (geo && geo.length > 0) {
        const g = geo[0];
        const streetNum = g.streetNumber || '';
        const street    = g.street || '';
        // Use city (actual suburb name) not district/subregion which returns council names
        const suburb    = g.city || g.subregion || '';
        const state     = g.region || '';

        let label = '';
        if (streetNum && street && suburb) {
          label = `${streetNum} ${street}, ${suburb}`;
        } else if (street && suburb) {
          label = `${street}, ${suburb}`;
        } else if (suburb && state) {
          label = `${suburb}, ${state}`;
        } else if (suburb) {
          label = suburb;
        } else {
          // Raw coords — Google geocodes these perfectly
          label = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        }
        setLocation(label);
      } else {
        setLocation(`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
      }
    } catch (e) {
      setError('Could not get location. Type it instead.');
    } finally {
      setLocating(false);
    }
  }

  async function search() {
    if (!canSearch || loading) return;
    setLoading(true);
    setError('');
    setResults(null);
    setLoadStep(0);

    const stepTimer1 = setTimeout(() => setLoadStep(1), 2000);
    const stepTimer2 = setTimeout(() => setLoadStep(2), 4000);
    const stepTimer3 = setTimeout(() => setLoadStep(3), 6000);

    try {
      const gems = await doSearch(location.trim(), selMeal, selStyles, selKws);
      setResults(gems);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 300);
    } catch (e) {
      setError(e.message || 'Something went wrong. Try again.');
    } finally {
      clearTimeout(stepTimer1); clearTimeout(stepTimer2); clearTimeout(stepTimer3);
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* ── HEADER ── */}
      <View style={s.hdr}>
        <Text style={[s.logo, { fontSize: S.fs(36, 46) }]}>stumble</Text>
        <View style={s.hdrBadge}>
          <View style={s.hdrDot} />
          <Text style={[s.hdrBadgeTxt, { fontSize: S.fs(9, 11) }]}>LIVE RECS</Text>
        </View>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={[s.scrollContent, { paddingBottom: 60 }]}
          keyboardShouldPersistTaps="handled"
        >

          {/* ── HERO ── */}
          <View style={s.hero}>
            <View style={s.heroKicker}>
              <View style={s.kickerLine} />
              <Text style={[s.kickerTxt, { fontSize: S.fs(10, 12) }]}>food discovery · ranked by data</Text>
            </View>
            <Text style={[s.h1, { fontSize: S.fs(36, 52) }]}>
              find the places{'\n'}
              <Text style={{ color: C.green }}>worth going to.</Text>
            </Text>
            <Text style={[s.heroSub, { fontSize: S.fs(13, 15) }]}>
              the stumble score cross-references Google & Foursquare to rank real local gems — not just the most reviewed places.
            </Text>
          </View>

          {/* ── LOCATION INPUT ── */}
          <View style={s.section}>
            <Text style={[s.secLabel, { fontSize: S.fs(10, 12) }]}>WHERE?</Text>

            {/* Geo locate button */}
            <TouchableOpacity
              style={[s.geoBtn, locating && { opacity: 0.6 }]}
              onPress={getMyLocation}
              disabled={locating}
              activeOpacity={0.8}
            >
              {locating ? (
                <ActivityIndicator color={C.green} size="small" />
              ) : (
                <Text style={{ fontSize: S.fs(14, 16) }}>📍</Text>
              )}
              <Text style={[s.geoBtnTxt, { fontSize: S.fs(13, 15) }]}>
                {locating ? 'finding your location…' : 'use my current location'}
              </Text>
            </TouchableOpacity>

            {/* Divider */}
            <View style={s.divider}>
              <View style={s.dividerLine} />
              <Text style={[s.dividerTxt, { fontSize: S.fs(10, 12) }]}>or search an area</Text>
              <View style={s.dividerLine} />
            </View>

            {/* Manual input */}
            <View style={[s.inputWrap, { borderColor: location ? C.green : C.border2 }]}>
              <Text style={{ fontSize: S.fs(14, 16), marginRight: 8, opacity: 0.4 }}>🔍</Text>
              <TextInput
                style={[s.input, { fontSize: S.fs(15, 18) }]}
                placeholder="suburb, city or street…"
                placeholderTextColor={C.dim}
                value={location}
                onChangeText={setLocation}
                returnKeyType="search"
                onSubmitEditing={search}
              />
              {!!location && (
                <TouchableOpacity onPress={() => setLocation('')} style={{ padding: 4 }}>
                  <Text style={{ color: C.dim, fontSize: 16 }}>✕</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* ── MEAL ── */}
          <View style={s.section}>
            <Text style={[s.secLabel, { fontSize: S.fs(10, 12) }]}>MEAL <Text style={s.optional}>— optional</Text></Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.pillsRow}>
              {MEALS.map(m => (
                <Pill key={m} label={m} active={selMeal === m} color={C.green} S={S}
                  onPress={() => setSelMeal(p => p === m ? '' : m)} />
              ))}
            </ScrollView>
          </View>

          {/* ── FOOD STYLE ── */}
          <View style={s.section}>
            <Text style={[s.secLabel, { fontSize: S.fs(10, 12) }]}>FOOD STYLE <Text style={s.optional}>— optional</Text></Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.pillsRow}>
              {FOOD_STYLES.map(fs => (
                <Pill key={fs} label={fs} active={selStyles.includes(fs)} color={C.blue} S={S}
                  onPress={() => toggleStyle(fs)} />
              ))}
            </ScrollView>
          </View>

          {/* ── KEYWORDS ── */}
          <View style={s.section}>
            <Text style={[s.secLabel, { fontSize: S.fs(10, 12) }]}>I'M AFTER… <Text style={s.optional}>— pick any</Text></Text>
            <View style={s.pillsWrap}>
              {KEYWORDS.map(k => (
                <Pill key={k} label={k} active={selKws.includes(k)} color={C.orange} S={S}
                  onPress={() => toggleKw(k)} />
              ))}
            </View>
          </View>

          {/* ── SEARCH BUTTON ── */}
          <TouchableOpacity
            style={[s.searchBtn, !canSearch && s.searchBtnDisabled]}
            onPress={search}
            disabled={!canSearch || loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color="#000" size="small" />
            ) : (
              <Text style={[s.searchBtnTxt, { fontSize: S.fs(15, 18) }]}>stumble onto something good</Text>
            )}
          </TouchableOpacity>

          {!canSearch && (
            <Text style={[s.hint, { fontSize: S.fs(11, 13) }]}>// enter a location to search</Text>
          )}

          {/* ── LOADING STEPS ── */}
          {loading && (
            <View style={s.loadBox}>
              {LOAD_STEPS.map((step, i) => (
                <View key={i} style={s.loadStep}>
                  <Text style={[
                    s.loadDot,
                    { fontSize: S.fs(10, 12) },
                    i < loadStep && { color: C.green },
                    i === loadStep && { color: C.text },
                  ]}>
                    {i < loadStep ? '✓' : i === loadStep ? '›' : '·'}
                  </Text>
                  <Text style={[
                    s.loadTxt,
                    { fontSize: S.fs(11, 13) },
                    i < loadStep && { color: C.green },
                    i === loadStep && { color: C.text },
                  ]}>{step}</Text>
                </View>
              ))}
            </View>
          )}

          {/* ── ERROR ── */}
          {!!error && (
            <View style={s.errorBox}>
              <Text style={[s.errorTxt, { fontSize: S.fs(12, 14) }]}>{error}</Text>
            </View>
          )}

          {/* ── RESULTS ── */}
          {results && results.length > 0 && (
            <View style={s.results}>
              <View style={s.resultsHd}>
                <Text style={[s.resultsTitle, { fontSize: S.fs(22, 28) }]}>
                  gems near{' '}
                  <Text style={{ color: C.green, fontStyle: 'italic' }}>{location}</Text>
                </Text>
                <View style={s.resultsBadges}>
                  <View style={s.badge}>
                    <Text style={[s.badgeTxt, { fontSize: S.fs(10, 12) }]}>{results.length} spots ranked</Text>
                  </View>
                  {results.filter(r => r.isVerified).length > 0 && (
                    <View style={[s.badge, s.badgeVerified]}>
                      <Text style={[s.badgeTxt, { fontSize: S.fs(10, 12), color: C.green }]}>
                        ✓ {results.filter(r => r.isVerified).length} cross-verified
                      </Text>
                    </View>
                  )}
                </View>
              </View>

              {results.map((item, i) => (
                <GemCard key={i} item={item} index={i} S={S} />
              ))}
            </View>
          )}

          {results && results.length === 0 && (
            <View style={s.emptyBox}>
              <Text style={{ fontSize: 40, marginBottom: 12 }}>🔍</Text>
              <Text style={[s.emptyTxt, { fontSize: S.fs(15, 18) }]}>No gems found nearby</Text>
              <Text style={[s.emptyHint, { fontSize: S.fs(12, 14) }]}>Try a nearby suburb or remove some filters</Text>
            </View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: C.bg },
  scrollContent:{ paddingHorizontal: 16, paddingTop: 0, paddingBottom: 40 },

  // Geo button
  geoBtn:       { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(0,230,118,0.08)', borderWidth: 1, borderColor: 'rgba(0,230,118,0.25)', borderRadius: 10, paddingVertical: 14, paddingHorizontal: 16, marginBottom: 12 },
  geoBtnTxt:    { color: C.green, fontWeight: '700', flex: 1 },
  divider:      { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  dividerLine:  { flex: 1, height: 1, backgroundColor: C.border },
  dividerTxt:   { color: C.dim, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },

  // Header
  hdr:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.bg },
  logo:         { fontWeight: '900', color: C.text, letterSpacing: -1 },
  hdrBadge:     { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: 'rgba(0,230,118,0.08)', borderWidth: 1, borderColor: 'rgba(0,230,118,0.2)', borderRadius: 4 },
  hdrDot:       { width: 5, height: 5, borderRadius: 3, backgroundColor: C.green },
  hdrBadgeTxt:  { color: 'rgba(0,230,118,0.75)', fontWeight: '700', letterSpacing: 1 },

  // Hero
  hero:         { paddingVertical: 28, paddingHorizontal: 2 },
  heroKicker:   { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  kickerLine:   { width: 24, height: 2, backgroundColor: C.green, borderRadius: 1 },
  kickerTxt:    { color: C.dim, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' },
  h1:           { fontWeight: '800', color: C.text, letterSpacing: -1.5, lineHeight: undefined, marginBottom: 8 },
  heroSub:      { color: C.muted, fontWeight: '400', marginTop: 4 },

  // Form
  section:      { marginBottom: 20 },
  secLabel:     { fontWeight: '700', color: C.dim, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 },
  secHint:      { color: 'rgba(255,255,255,0.18)', marginBottom: 10 },
  optional:     { fontWeight: '400', color: 'rgba(255,255,255,0.18)', textTransform: 'none', letterSpacing: 0 },

  inputWrap:    { flexDirection: 'row', alignItems: 'center', backgroundColor: C.s1, borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 2 },
  input:        { flex: 1, color: C.text, paddingVertical: 12 },

  pillsRow:     { gap: 6, paddingVertical: 2 },
  pillsWrap:    { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill:         { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: 'transparent' },
  pillTxt:      { color: C.dim, fontWeight: '500' },

  // Search button
  searchBtn:    { backgroundColor: C.green, borderRadius: 10, paddingVertical: 15, alignItems: 'center', marginBottom: 6 },
  searchBtnDisabled: { backgroundColor: C.s2 },
  searchBtnTxt: { fontWeight: '800', color: '#000', letterSpacing: 0.5, textTransform: 'uppercase' },
  hint:         { textAlign: 'center', color: C.dim, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },

  // Loading
  loadBox:      { backgroundColor: C.s1, borderRadius: 10, padding: 16, marginTop: 12, borderWidth: 1, borderColor: C.border },
  loadStep:     { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  loadDot:      { color: C.dim, fontWeight: '700', width: 14 },
  loadTxt:      { color: C.dim, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },

  // Error
  errorBox:     { backgroundColor: 'rgba(255,82,82,0.07)', borderWidth: 1, borderColor: 'rgba(255,82,82,0.2)', borderRadius: 10, padding: 14, marginTop: 10 },
  errorTxt:     { color: '#ff7070', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },

  // Results
  results:      { marginTop: 24 },
  resultsHd:    { marginBottom: 16 },
  resultsTitle: { fontWeight: '800', color: C.text, letterSpacing: -0.5, marginBottom: 10 },
  resultsBadges:{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  badge:        { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderColor: C.border },
  badgeVerified:{ borderColor: 'rgba(0,230,118,0.3)', backgroundColor: 'rgba(0,230,118,0.06)' },
  badgeTxt:     { color: C.dim, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },

  // Card
  card:         { borderRadius: 12, overflow: 'hidden', borderWidth: 1, marginBottom: 12, backgroundColor: C.s1, flexDirection: 'row' },
  cardStripe:   { width: 4 },
  cardContent:  { flex: 1, padding: 14 },
  cardHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  cardTags:     { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 },
  catBadge:     { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3 },
  catBadgeTxt:  { color: '#000', fontWeight: '800', letterSpacing: 0.5 },
  priceTag:     { color: C.dim, fontWeight: '600' },
  ratingRow:    { flexDirection: 'row', alignItems: 'center', gap: 2 },
  starIcon:     { color: C.gold },
  ratingTxt:    { color: C.text, fontWeight: '700' },
  reviewCt:     { color: C.dim, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  fsqTag:       { color: 'rgba(255,109,0,0.75)', backgroundColor: 'rgba(255,109,0,0.09)', borderWidth: 1, borderColor: 'rgba(255,109,0,0.18)', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 3 },
  verifiedBadge:{ alignSelf: 'flex-start', paddingHorizontal: 7, paddingVertical: 2, backgroundColor: 'rgba(0,230,118,0.08)', borderWidth: 1, borderColor: 'rgba(0,230,118,0.25)', borderRadius: 3 },
  verifiedTxt:  { color: C.green, fontWeight: '700', letterSpacing: 0.3 },
  cardName:     { fontWeight: '800', letterSpacing: -0.5, marginBottom: 2 },
  cardArea:     { fontWeight: '600' },
  emojiBox:     { width: 48, height: 48, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cardDesc:     { color: C.muted, lineHeight: 20, marginBottom: 10 },
  tastesRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 10 },
  tasteTag:     { backgroundColor: C.s3, borderWidth: 1, borderColor: C.border, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3 },
  tasteTxt:     { color: C.dim, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  infoGrid:     { flexDirection: 'row', gap: 8, marginBottom: 10 },
  infoCell:     { flex: 1, backgroundColor: C.s2, borderRadius: 8, padding: 10, borderWidth: 1, borderColor: C.border },
  infoCellLabel:{ color: C.dim, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 },
  infoCellVal:  { color: C.text, fontWeight: '500' },
  tipBtn:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 },
  tipBtnTxt:    { color: C.dim, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  tipArrow:     { color: C.dim, fontSize: 10 },
  tipBody:      { marginTop: 6, padding: 12, borderRadius: 8, borderWidth: 1 },
  tipBodyTxt:   { color: C.muted, lineHeight: 20 },
  cardBtns:     { flexDirection: 'row', gap: 8, marginTop: 10 },
  actionBtn:    { flex: 1, paddingVertical: 9, borderRadius: 8, borderWidth: 1, alignItems: 'center' },
  mapsBtn:      { borderColor: 'rgba(68,138,255,0.2)', backgroundColor: 'rgba(68,138,255,0.06)' },
  webBtn:       { borderColor: 'rgba(0,230,118,0.2)', backgroundColor: 'rgba(0,230,118,0.06)' },
  actionBtnTxt: { fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },

  // Empty
  emptyBox:     { alignItems: 'center', paddingVertical: 40 },
  emptyTxt:     { color: C.text, fontWeight: '700', marginBottom: 8 },
  emptyHint:    { color: C.dim, textAlign: 'center' },
});