/* ============================================================
   Trainer Tim — Cloudflare Worker
   API routes, Strava OAuth, token management, KV caching
   ============================================================ */

// --- Configuration ---
const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
const STRAVA_OAUTH_BASE = 'https://www.strava.com/oauth/token';

const CACHE_TTL = {
    athlete: 3600,      // 1 hour
    activities: 300,    // 5 minutes
    activity: 3600,     // 1 hour
    stats: 300          // 5 minutes
};

// --- CORS ---
function corsResponse(body, status = 200, extraHeaders = {}) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Content-Type': 'application/json',
        ...extraHeaders
    };
    return new Response(JSON.stringify(body), { status, headers });
}

function corsError(message, status = 500) {
    return corsResponse({ error: message }, status);
}

// --- KV Helpers ---
async function kvGet(env, key) {
    try {
        return await env.TRAINER_TIM_KV.get(key, { type: 'json' });
    } catch (e) {
        console.error(`KV get error for ${key}:`, e);
        return null;
    }
}

async function kvPut(env, key, value, ttlSeconds) {
    try {
        const options = ttlSeconds ? { expirationTtl: ttlSeconds } : {};
        await env.TRAINER_TIM_KV.put(key, JSON.stringify(value), options);
    } catch (e) {
        console.error(`KV put error for ${key}:`, e);
    }
}

// --- Token Management ---
async function getValidToken(env, athlete) {
    const tokenKey = `athlete:${athlete}:tokens`;
    let tokens = await kvGet(env, tokenKey);

    if (!tokens) {
        throw new Error(`No tokens found for ${athlete}. Please connect your Strava account.`);
    }

    // Check if token is expired or about to expire (within 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (tokens.expires_at && tokens.expires_at <= now + 300) {
        // Refresh the token
        tokens = await refreshToken(env, athlete, tokens.refresh_token);
    }

    return tokens.access_token;
}

async function refreshToken(env, athlete, refreshToken) {
    const clientId = env.STRAVA_CLIENT_ID;
    const clientSecret = env.STRAVA_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('Strava client credentials not configured.');
    }

    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    });

    const res = await fetch(STRAVA_OAUTH_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!res.ok) {
        const errText = await res.text();
        console.error(`Token refresh failed for ${athlete}:`, errText);
        throw new Error(`Failed to refresh Strava token. Please reconnect your account.`);
    }

    const newTokens = await res.json();

    // Store updated tokens
    const tokenKey = `athlete:${athlete}:tokens`;
    await kvPut(env, tokenKey, {
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expires_at: newTokens.expires_at,
        athlete_id: newTokens.athlete?.id
    });

    return newTokens.access_token;
}

// --- Strava API Client ---
async function fetchStrava(env, athlete, path, params = {}) {
    const token = await getValidToken(env, athlete);

    const url = new URL(`${STRAVA_API_BASE}${path}`);
    Object.entries(params).forEach(([k, v]) => {
        if (v != null) url.searchParams.set(k, v);
    });

    const res = await fetch(url.toString(), {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
        }
    });

    // Check rate limits
    const rateLimit = res.headers.get('X-RateLimit-Usage');
    const rateLimitDaily = res.headers.get('X-RateLimit-Limit');
    if (rateLimit) {
        const [shortTerm, daily] = rateLimit.split(',').map(s => s.trim());
        console.log(`Strava rate limit (15min): ${shortTerm}, daily: ${daily || 'unknown'}`);
    }

    if (res.status === 429) {
        throw new Error('Strava rate limit reached. Please wait a few minutes and try again.');
    }

    if (res.status === 401) {
        throw new Error('Strava authorization failed. Please reconnect your account.');
    }

    if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || `Strava API error (${res.status})`);
    }

    return await res.json();
}

// --- API Endpoints ---

// GET /api/athlete
async function handleGetAthlete(env, athlete) {
    const cacheKey = `cache:athlete:${athlete}`;
    const cached = await kvGet(env, cacheKey);
    if (cached) {
        return corsResponse(cached, 200, { 'X-Cache': 'HIT' });
    }

    const data = await fetchStrava(env, athlete, '/athlete');
    await kvPut(env, cacheKey, data, CACHE_TTL.athlete);
    return corsResponse(data, 200, { 'X-Cache': 'MISS' });
}

// GET /api/activities
async function handleGetActivities(env, athlete, page, perPage) {
    const pageNum = Math.max(1, parseInt(page) || 1);
    const perPageNum = Math.min(50, Math.max(1, parseInt(perPage) || 10));
    const cacheKey = `cache:activities:${athlete}:p${pageNum}:n${perPageNum}`;

    const cached = await kvGet(env, cacheKey);
    if (cached) {
        return corsResponse(cached, 200, { 'X-Cache': 'HIT' });
    }

    const data = await fetchStrava(env, athlete, '/athlete/activities', {
        page: pageNum,
        per_page: perPageNum
    });

    await kvPut(env, cacheKey, data, CACHE_TTL.activities);
    return corsResponse(data, 200, { 'X-Cache': 'MISS' });
}

// GET /api/activity/:id
async function handleGetActivity(env, athlete, activityId) {
    const cacheKey = `cache:activity:${athlete}:${activityId}`;

    const cached = await kvGet(env, cacheKey);
    if (cached) {
        return corsResponse(cached, 200, { 'X-Cache': 'HIT' });
    }

    const data = await fetchStrava(env, athlete, `/activities/${activityId}`, {
        include_all_efforts: false
    });

    await kvPut(env, cacheKey, data, CACHE_TTL.activity);
    return corsResponse(data, 200, { 'X-Cache': 'MISS' });
}

// GET /api/stats
async function handleGetStats(env, athlete, period) {
    const validPeriods = ['weekly', 'monthly', 'yearly'];
    const p = validPeriods.includes(period) ? period : 'weekly';
    const cacheKey = `cache:stats:${athlete}:${p}`;

    const cached = await kvGet(env, cacheKey);
    if (cached) {
        return corsResponse(cached, 200, { 'X-Cache': 'HIT' });
    }

    // Fetch recent activities to compute stats
    const activities = await fetchStrava(env, athlete, '/athlete/activities', {
        page: 1,
        per_page: 50
    });

    const stats = computeStats(activities, p);
    await kvPut(env, cacheKey, stats, CACHE_TTL.stats);
    return corsResponse(stats, 200, { 'X-Cache': 'MISS' });
}

// --- Stats Computation ---
function computeStats(activities, period) {
    const now = new Date();
    let cutoff;

    switch (period) {
        case 'weekly':
            cutoff = new Date(now);
            cutoff.setDate(cutoff.getDate() - 7);
            break;
        case 'monthly':
            cutoff = new Date(now);
            cutoff.setMonth(cutoff.getMonth() - 1);
            break;
        case 'yearly':
            cutoff = new Date(now);
            cutoff.setFullYear(cutoff.getFullYear() - 1);
            break;
        default:
            cutoff = new Date(now);
            cutoff.setDate(cutoff.getDate() - 7);
    }

    const filtered = activities.filter(a => {
        const d = new Date(a.start_date_local || a.start_date);
        return d >= cutoff;
    });

    const totalDistance = filtered.reduce((sum, a) => sum + (a.distance || 0), 0);
    const totalElevationGain = filtered.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
    const totalMovingTime = filtered.reduce((sum, a) => sum + (a.moving_time || 0), 0);
    const totalElapsedTime = filtered.reduce((sum, a) => sum + (a.elapsed_time || 0), 0);
    const activityCount = filtered.length;
    const averageSpeed = totalMovingTime > 0 ? totalDistance / totalMovingTime : 0;
    const longestRunDistance = filtered.length > 0
        ? Math.max(...filtered.map(a => a.distance || 0))
        : 0;

    // Compute trend periods
    const periods = computeWeeklyTrend(filtered, period);

    return {
        period,
        total_distance: totalDistance,
        total_elevation_gain: totalElevationGain,
        total_moving_time: totalMovingTime,
        total_elapsed_time: totalElapsedTime,
        activity_count: activityCount,
        average_speed: averageSpeed,
        longest_run_distance: longestRunDistance,
        periods
    };
}

function computeWeeklyTrend(activities, period) {
    // Group activities into sub-periods for the trend chart
    const periods = [];
    const now = new Date();

    let numPeriods, periodMs, labelFn;

    switch (period) {
        case 'weekly':
            numPeriods = 7;
            periodMs = 24 * 60 * 60 * 1000;
            labelFn = (d) => d.toLocaleDateString('en-AU', { weekday: 'short' });
            break;
        case 'monthly':
            numPeriods = 4;
            periodMs = 7 * 24 * 60 * 60 * 1000;
            labelFn = (d, i) => `W${i + 1}`;
            break;
        case 'yearly':
            numPeriods = 12;
            periodMs = 30 * 24 * 60 * 60 * 1000;
            labelFn = (d) => d.toLocaleDateString('en-AU', { month: 'short' });
            break;
        default:
            numPeriods = 7;
            periodMs = 24 * 60 * 60 * 1000;
            labelFn = (d) => d.toLocaleDateString('en-AU', { weekday: 'short' });
    }

    for (let i = numPeriods - 1; i >= 0; i--) {
        const periodStart = new Date(now.getTime() - (i + 1) * periodMs);
        const periodEnd = new Date(now.getTime() - i * periodMs);

        const periodActivities = activities.filter(a => {
            const d = new Date(a.start_date_local || a.start_date);
            return d >= periodStart && d < periodEnd;
        });

        const distance = periodActivities.reduce((sum, a) => sum + (a.distance || 0), 0);

        periods.push({
            label: labelFn(periodStart, numPeriods - 1 - i),
            distance,
            count: periodActivities.length
        });
    }

    return periods;
}

// --- OAuth Callback ---
async function handleAuthCallback(env, code, stateParam, athlete) {
    if (!code) {
        return corsError('Missing authorization code.', 400);
    }
    if (!athlete || !['greg', 'son'].includes(athlete)) {
        return corsError('Invalid athlete parameter.', 400);
    }

    const clientId = env.STRAVA_CLIENT_ID;
    const clientSecret = env.STRAVA_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        return corsError('Strava client credentials not configured.', 500);
    }

    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        grant_type: 'authorization_code'
    });

    try {
        const res = await fetch(STRAVA_OAUTH_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            console.error('OAuth token exchange failed:', errBody);
            return corsError(errBody.message || 'Failed to exchange authorization code.', 400);
        }

        const tokens = await res.json();

        // Store tokens in KV
        const tokenKey = `athlete:${athlete}:tokens`;
        await kvPut(env, tokenKey, {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: tokens.expires_at,
            athlete_id: tokens.athlete?.id
        });

        // Invalidate any cached data for this athlete
        // (We don't need to explicitly delete — new fetches will overwrite)

        return corsResponse({
            success: true,
            athlete: {
                id: tokens.athlete?.id,
                name: `${tokens.athlete?.firstname || ''} ${tokens.athlete?.lastname || ''}`.trim(),
                profile: tokens.athlete?.profile
            }
        });
    } catch (err) {
        console.error('OAuth callback error:', err);
        return corsError('Internal error during authentication.', 500);
    }
}

// --- Request Router ---
async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Accept',
                'Access-Control-Max-Age': '86400'
            }
        });
    }

    // API Routes
    if (path.startsWith('/api/')) {
        const params = url.searchParams;

        try {
            // GET /api/athlete
            if (path === '/api/athlete' && request.method === 'GET') {
                const athlete = params.get('athlete');
                if (!athlete || !['greg', 'son'].includes(athlete)) {
                    return corsError('Invalid athlete parameter. Use ?athlete=greg or ?athlete=son', 400);
                }
                return await handleGetAthlete(env, athlete);
            }

            // GET /api/activities
            if (path === '/api/activities' && request.method === 'GET') {
                const athlete = params.get('athlete');
                if (!athlete || !['greg', 'son'].includes(athlete)) {
                    return corsError('Invalid athlete parameter. Use ?athlete=greg or ?athlete=son', 400);
                }
                const page = params.get('page') || '1';
                const perPage = params.get('per_page') || '10';
                return await handleGetActivities(env, athlete, page, perPage);
            }

            // GET /api/activity/:id
            const activityMatch = path.match(/^\/api\/activity\/(\d+)$/);
            if (activityMatch && request.method === 'GET') {
                const athlete = params.get('athlete');
                if (!athlete || !['greg', 'son'].includes(athlete)) {
                    return corsError('Invalid athlete parameter. Use ?athlete=greg or ?athlete=son', 400);
                }
                const activityId = activityMatch[1];
                return await handleGetActivity(env, athlete, activityId);
            }

            // GET /api/stats
            if (path === '/api/stats' && request.method === 'GET') {
                const athlete = params.get('athlete');
                if (!athlete || !['greg', 'son'].includes(athlete)) {
                    return corsError('Invalid athlete parameter. Use ?athlete=greg or ?athlete=son', 400);
                }
                const period = params.get('period') || 'weekly';
                return await handleGetStats(env, athlete, period);
            }

            // GET /api/auth/callback
            if (path === '/api/auth/callback' && request.method === 'GET') {
                const code = params.get('code');
                const stateParam = params.get('state');
                const athlete = params.get('athlete');
                return await handleAuthCallback(env, code, stateParam, athlete);
            }

            // Unknown API route
            return corsError('Not found', 404);
        } catch (err) {
            console.error('API error:', err);
            return corsError(err.message || 'Internal server error', 500);
        }
    }

    // Static assets — pass through to Pages asset binding
    try {
        return env.ASSETS.fetch(request);
    } catch (e) {
        // If ASSETS binding fails, return 404
        return new Response('Not found', { status: 404 });
    }
}

// --- Worker Entry Point ---
export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env, ctx);
    }
};
