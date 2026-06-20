/* ============================================================
   Trainer Tim — Frontend Application
   State management, API client, rendering, OAuth flow
   ============================================================ */

// --- DOM Helpers ---
const $ = (sel, ctx) => (ctx || document).querySelector(sel);
const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

// --- State ---
const state = {
    athletes: {
        greg: { name: 'Greg', initial: 'G', stravaId: null },
        son: { name: 'Son', initial: 'S', stravaId: null }
    },
    currentAthlete: 'greg',
    connected: { greg: false, son: false },
    athleteData: { greg: null, son: null },
    activities: { greg: [], son: [] },
    stats: { greg: { weekly: null, monthly: null, yearly: null }, son: { weekly: null, monthly: null, yearly: null } },
    currentView: 'dashboard',
    activityPage: { greg: 1, son: 1 },
    hasMore: { greg: true, son: true },
    activityTypeFilter: 'all',
    statsPeriod: 'weekly',
    autoRefreshInterval: null,
    leafletMap: null,
    leafletLayer: null
};

// --- Utility Functions ---
function formatDistance(meters) {
    if (meters == null || isNaN(meters)) return '—';
    const km = meters / 1000;
    return km >= 10 ? `${km.toFixed(0)} km` : `${km.toFixed(1)} km`;
}

function formatDuration(seconds) {
    if (seconds == null || isNaN(seconds)) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
    return `${m}m`;
}

function formatPace(metersPerSecond) {
    if (metersPerSecond == null || isNaN(metersPerSecond) || metersPerSecond <= 0) return '—';
    const secPerKm = 1000 / metersPerSecond;
    const min = Math.floor(secPerKm / 60);
    const sec = Math.floor(secPerKm % 60);
    return `${min}:${sec.toString().padStart(2, '0')} /km`;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateFull(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function decodePolyline(encoded, precision) {
    // Strava polyline decoder (precision 5)
    precision = precision || 5;
    const factor = Math.pow(10, precision);
    let index = 0, lat = 0, lng = 0;
    const coordinates = [];
    let shift = 0, result = 0;
    let byte = null;

    while (index < encoded.length) {
        shift = 0;
        result = 0;
        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        const deltaLat = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lat += deltaLat;

        shift = 0;
        result = 0;
        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        const deltaLng = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lng += deltaLng;

        coordinates.push([lat / factor, lng / factor]);
    }
    return coordinates;
}

function getActivityIcon(type) {
    const icons = {
        Run: '🏃',
        TrailRun: '⛰️',
        Walk: '🚶',
        Hike: '🥾',
        Ride: '🚴',
        VirtualRide: '🚴',
        Swim: '🏊',
        Workout: '💪',
        Yoga: '🧘'
    };
    return icons[type] || '🏃';
}

function getActivityTypeLabel(type) {
    const labels = {
        Run: 'Run',
        TrailRun: 'Trail Run',
        Walk: 'Walk',
        Hike: 'Hike',
        Ride: 'Ride',
        VirtualRide: 'Virtual Ride',
        Swim: 'Swim',
        Workout: 'Workout',
        Yoga: 'Yoga'
    };
    return labels[type] || type || 'Activity';
}

// --- API Client ---
const API_BASE = '/api';

async function apiFetch(path, options = {}) {
    const url = `${API_BASE}${path}`;
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json', ...options.headers },
            ...options
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
            throw new Error(err.message || err.error || `Request failed (${res.status})`);
        }
        return await res.json();
    } catch (err) {
        if (err.name === 'TypeError' && err.message.includes('fetch')) {
            throw new Error('Network error — check your connection');
        }
        throw err;
    }
}

function getAthleteParam() {
    return `athlete=${state.currentAthlete}`;
}

async function fetchAthlete() {
    return apiFetch(`/athlete?${getAthleteParam()}`);
}

async function fetchActivities(page = 1, perPage = 10) {
    return apiFetch(`/activities?${getAthleteParam()}&page=${page}&per_page=${perPage}`);
}

async function fetchActivityDetail(id) {
    return apiFetch(`/activity/${id}?${getAthleteParam()}`);
}

async function fetchStats(period) {
    return apiFetch(`/stats?${getAthleteParam()}&period=${period}`);
}

// --- LocalStorage Caching ---
function cacheKey(type) {
    return `trainer-tim:${state.currentAthlete}:${type}`;
}

function saveToCache(type, data) {
    try {
        const entry = { data, timestamp: Date.now() };
        localStorage.setItem(cacheKey(type), JSON.stringify(entry));
    } catch (e) {
        // localStorage full or unavailable — silently skip
    }
}

function loadFromCache(type, maxAgeMs = 30 * 60 * 1000) {
    try {
        const raw = localStorage.getItem(cacheKey(type));
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (Date.now() - entry.timestamp > maxAgeMs) {
            localStorage.removeItem(cacheKey(type));
            return null;
        }
        return entry;
    } catch (e) {
        return null;
    }
}

function showCachedBadge(show) {
    const badge = $('#cachedBadge');
    if (show) {
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// --- Error Handling ---
function showError(viewName, message) {
    const spinner = $(`#${viewName}Spinner`);
    const error = $(`#${viewName}Error`);
    if (spinner) spinner.classList.add('hidden');
    if (error) {
        error.classList.remove('hidden');
        $('.error-message', error).textContent = message;
    }
}

function hideError(viewName) {
    const error = $(`#${viewName}Error`);
    if (error) error.classList.add('hidden');
}

// --- View Routing ---
function switchView(viewName) {
    state.currentView = viewName;

    // Update nav tabs
    $$('.nav-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === viewName);
    });

    // Show/hide views
    $$('.view').forEach(v => v.classList.add('hidden'));
    const targetView = $(`#${viewName}View`);
    if (targetView) targetView.classList.remove('hidden');

    // Load data for the view
    if (viewName === 'dashboard') loadDashboard();
    else if (viewName === 'activities') loadActivities();
    else if (viewName === 'stats') loadStats();
}

// --- Profile Switching ---
function switchProfile(athlete) {
    if (state.currentAthlete === athlete) return;
    state.currentAthlete = athlete;

    // Update profile buttons
    $$('.profile-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.athlete === athlete);
    });

    // Check connection status
    checkConnectionStatus();

    // Reload current view
    if (state.currentView === 'dashboard') loadDashboard();
    else if (state.currentView === 'activities') loadActivities();
    else if (state.currentView === 'stats') loadStats();
}

function checkConnectionStatus() {
    const athlete = state.currentAthlete;
    const connected = state.connected[athlete];
    const prompt = $('#connectPrompt');
    const views = $$('.view');

    if (!connected) {
        prompt.style.display = '';
        views.forEach(v => v.classList.add('hidden'));
    } else {
        prompt.style.display = 'none';
        switchView(state.currentView);
    }
}

// --- OAuth Flow ---
function initiateStravaConnect() {
    const athlete = state.currentAthlete;
    const clientId = 'REPLACE_WITH_STRAVA_CLIENT_ID'; // Replaced at deploy time via worker vars
    const redirectUri = `${window.location.origin}/api/auth/callback`;
    const scope = 'read,activity:read_all';
    const stateParam = `${athlete}:${Date.now()}`;

    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&approval_prompt=auto&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(stateParam)}`;

    window.location.href = authUrl;
}

async function handleAuthCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const stateParam = params.get('state');

    if (!code || !stateParam) return false;

    const [athlete] = stateParam.split(':');
    if (!athlete || !state.athletes[athlete]) return false;

    try {
        const res = await apiFetch(`/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}&athlete=${encodeURIComponent(athlete)}`);
        if (res.success) {
            state.connected[athlete] = true;
            // Clean URL
            window.history.replaceState({}, document.title, window.location.pathname);
            // Switch to this athlete
            if (state.currentAthlete !== athlete) {
                state.currentAthlete = athlete;
                $$('.profile-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.athlete === athlete);
                });
            }
            checkConnectionStatus();
            return true;
        }
    } catch (err) {
        console.error('Auth callback error:', err);
        showError('dashboard', `Failed to connect: ${err.message}`);
    }
    return false;
}

// --- Dashboard ---
async function loadDashboard() {
    const spinner = $('#dashboardSpinner');
    const error = $('#dashboardError');
    const grid = $('#statCardsGrid');
    const list = $('#recentActivities');

    hideError('dashboard');
    spinner.classList.remove('hidden');
    grid.innerHTML = '';
    list.innerHTML = '';

    // Try cache first
    const cachedAthlete = loadFromCache('athlete');
    const cachedActivities = loadFromCache('activities');

    if (cachedAthlete && cachedActivities) {
        renderDashboardStats(cachedAthlete.data, cachedActivities.data);
        renderRecentActivities(cachedActivities.data.slice(0, 5));
        showCachedBadge(true);
        spinner.classList.add('hidden');
    }

    try {
        const [athlete, activities] = await Promise.all([
            fetchAthlete(),
            fetchActivities(1, 5)
        ]);

        state.athleteData[state.currentAthlete] = athlete;
        state.activities[state.currentAthlete] = activities;
        state.activityPage[state.currentAthlete] = 1;
        state.hasMore[state.currentAthlete] = activities.length >= 5;

        saveToCache('athlete', athlete);
        saveToCache('activities', activities);

        renderDashboardStats(athlete, activities);
        renderRecentActivities(activities);
        showCachedBadge(false);
    } catch (err) {
        if (!cachedAthlete) {
            showError('dashboard', err.message);
        }
        // If we had cached data, keep showing it with badge
    } finally {
        spinner.classList.add('hidden');
    }
}

function renderDashboardStats(athlete, activities) {
    const grid = $('#statCardsGrid');
    grid.innerHTML = '';

    // Compute stats from recent activities
    const recentActivities = activities.slice(0, 5);
    const totalDistance = recentActivities.reduce((sum, a) => sum + (a.distance || 0), 0);
    const totalElevation = recentActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
    const totalTime = recentActivities.reduce((sum, a) => sum + (a.moving_time || 0), 0);
    const avgPace = totalTime > 0 && totalDistance > 0 ? totalDistance / totalTime : 0;
    const vertPerKm = totalDistance > 0 ? (totalElevation / (totalDistance / 1000)) : 0;
    const longestRun = recentActivities.length > 0
        ? Math.max(...recentActivities.map(a => a.distance || 0))
        : 0;

    // Trend indicators (simplified — compare to previous week)
    const prevWeekDist = (athlete?.recent_run_totals?.distance || 0) / 1000;
    const thisWeekDist = totalDistance / 1000;
    const trendDist = thisWeekDist > prevWeekDist ? 'up' : thisWeekDist < prevWeekDist ? 'down' : 'neutral';

    const cards = [
        {
            icon: '📏', value: formatDistance(totalDistance), label: 'Weekly Distance',
            trend: trendDist === 'up' ? '↑ Trending up' : trendDist === 'down' ? '↓ Below average' : '→ Steady',
            trendClass: trendDist
        },
        {
            icon: '⛰️', value: `${totalElevation.toFixed(0)} m`, label: 'Elevation Gain',
            trend: totalElevation > 500 ? '↑ Solid vert' : '→ Flat week',
            trendClass: totalElevation > 500 ? 'up' : 'neutral'
        },
        {
            icon: '⏱️', value: formatDuration(totalTime), label: 'Time Running',
            trend: totalTime > 10800 ? '↑ Big week' : '→ Steady',
            trendClass: totalTime > 10800 ? 'up' : 'neutral'
        },
        {
            icon: '⚡', value: formatPace(avgPace), label: 'Avg Pace',
            trend: avgPace > 3.5 ? '↑ Quick' : '→ Easy',
            trendClass: avgPace > 3.5 ? 'up' : 'neutral'
        },
        {
            icon: '📐', value: `${vertPerKm.toFixed(0)} m/km`, label: 'Vert per KM',
            trend: vertPerKm > 30 ? '↑ Hilly' : '→ Rolling',
            trendClass: vertPerKm > 30 ? 'up' : 'neutral'
        },
        {
            icon: '🏆', value: formatDistance(longestRun), label: 'Longest Run',
            trend: longestRun > 15000 ? '↑ Epic' : '→ Solid',
            trendClass: longestRun > 15000 ? 'up' : 'neutral'
        }
    ];

    cards.forEach(card => {
        const el = document.createElement('div');
        el.className = 'stat-card';
        el.innerHTML = `
            <div class="stat-card-icon">${card.icon}</div>
            <div class="stat-card-value">${card.value}</div>
            <div class="stat-card-label">${card.label}</div>
            <div class="stat-card-trend ${card.trendClass}">${card.trend}</div>
        `;
        grid.appendChild(el);
    });
}

function renderRecentActivities(activities) {
    const list = $('#recentActivities');
    list.innerHTML = '';

    if (!activities || activities.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>No recent activities. Time to hit the trails! 🏃⛰️</p></div>';
        return;
    }

    activities.forEach(activity => {
        const el = createActivityItem(activity);
        list.appendChild(el);
    });
}

function createActivityItem(activity) {
    const el = document.createElement('div');
    el.className = 'activity-item';
    el.dataset.activityId = activity.id;
    el.innerHTML = `
        <div class="activity-type-icon">${getActivityIcon(activity.type)}</div>
        <div class="activity-info">
            <div class="activity-name">${activity.name || 'Untitled Activity'}</div>
            <div class="activity-date">${formatDate(activity.start_date_local || activity.start_date)}</div>
        </div>
        <div class="activity-stats-row">
            <div class="activity-stat">
                <div class="activity-stat-value">${formatDistance(activity.distance)}</div>
                <div class="activity-stat-label">Dist</div>
            </div>
            <div class="activity-stat">
                <div class="activity-stat-value">${activity.total_elevation_gain != null ? `${activity.total_elevation_gain.toFixed(0)}m` : '—'}</div>
                <div class="activity-stat-label">Vert</div>
            </div>
            <div class="activity-stat">
                <div class="activity-stat-value">${formatPace(activity.average_speed || (activity.distance / activity.moving_time))}</div>
                <div class="activity-stat-label">Pace</div>
            </div>
            <div class="activity-stat">
                <div class="activity-stat-value">${formatDuration(activity.moving_time)}</div>
                <div class="activity-stat-label">Time</div>
            </div>
        </div>
        <div class="activity-chevron">▶</div>
    `;

    el.addEventListener('click', () => openActivityDetail(activity.id));
    return el;
}

// --- Activity Detail Modal ---
async function openActivityDetail(activityId) {
    const modal = $('#activityModal');
    const body = $('#modalBody');

    modal.classList.remove('hidden');
    body.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner"></div>
            <p>Loading activity details…</p>
        </div>
    `;

    // Destroy previous map
    if (state.leafletMap) {
        state.leafletMap.remove();
        state.leafletMap = null;
        state.leafletLayer = null;
    }

    try {
        const activity = await fetchActivityDetail(activityId);
        renderActivityDetail(activity);
    } catch (err) {
        body.innerHTML = `
            <div class="error-banner">
                <p class="error-message">${err.message}</p>
                <button class="btn-retry" onclick="openActivityDetail(${activityId})">Retry</button>
            </div>
        `;
    }
}

function renderActivityDetail(activity) {
    const body = $('#modalBody');

    const pace = activity.average_speed || (activity.distance / activity.moving_time);
    const maxSpeed = activity.max_speed || 0;
    const elevGain = activity.total_elevation_gain || 0;
    const elevHigh = activity.elev_high || 0;
    const elevLow = activity.elev_low || 0;
    const calories = activity.calories || activity.kilojoules ? (activity.kilojoules / 4.184).toFixed(0) : 0;
    const avgHr = activity.average_heartrate || 0;
    const maxHr = activity.max_heartrate || 0;
    const sufferScore = activity.suffer_score || 0;

    const achievements = [];
    if (activity.achievement_count > 0) achievements.push(`${activity.achievement_count} achievements`);
    if (activity.pr_count > 0) achievements.push(`${activity.pr_count} PRs`);
    if (elevGain > 500) achievements.push('500m+ Vert');
    if (activity.distance > 21097) achievements.push('Half Marathon+');
    if (activity.distance > 42195) achievements.push('Marathon! 🏅');

    body.innerHTML = `
        <div class="modal-activity-header">
            <div class="modal-activity-name">${activity.name || 'Untitled Activity'}</div>
            <div class="modal-activity-date">${formatDateFull(activity.start_date_local || activity.start_date)} &middot; ${getActivityTypeLabel(activity.type)}</div>
        </div>

        <div class="modal-stats-grid">
            <div class="modal-stat">
                <div class="modal-stat-value">${formatDistance(activity.distance)}</div>
                <div class="modal-stat-label">Distance</div>
            </div>
            <div class="modal-stat">
                <div class="modal-stat-value">${formatDuration(activity.moving_time)}</div>
                <div class="modal-stat-label">Moving Time</div>
            </div>
            <div class="modal-stat">
                <div class="modal-stat-value">${formatDuration(activity.elapsed_time)}</div>
                <div class="modal-stat-label">Elapsed</div>
            </div>
            <div class="modal-stat">
                <div class="modal-stat-value">${formatPace(pace)}</div>
                <div class="modal-stat-label">Avg Pace</div>
            </div>
            <div class="modal-stat">
                <div class="modal-stat-value">${elevGain.toFixed(0)} m</div>
                <div class="modal-stat-label">Elev Gain</div>
            </div>
            <div class="modal-stat">
                <div class="modal-stat-value">${elevHigh.toFixed(0)} m</div>
                <div class="modal-stat-label">Max Elev</div>
            </div>
            ${calories ? `
            <div class="modal-stat">
                <div class="modal-stat-value">${calories}</div>
                <div class="modal-stat-label">Calories</div>
            </div>` : ''}
            ${avgHr ? `
            <div class="modal-stat">
                <div class="modal-stat-value">${avgHr} bpm</div>
                <div class="modal-stat-label">Avg HR</div>
            </div>` : ''}
            ${maxHr ? `
            <div class="modal-stat">
                <div class="modal-stat-value">${maxHr} bpm</div>
                <div class="modal-stat-label">Max HR</div>
            </div>` : ''}
            ${sufferScore ? `
            <div class="modal-stat">
                <div class="modal-stat-value">${sufferScore}</div>
                <div class="modal-stat-label">Suffer Score</div>
            </div>` : ''}
        </div>

        ${achievements.length > 0 ? `
        <div class="modal-achievements">
            ${achievements.map(a => `<span class="achievement-badge">${a}</span>`).join('')}
        </div>` : ''}

        ${activity.description ? `
        <div class="modal-description">${activity.description}</div>` : ''}

        ${activity.map?.summary_polyline ? `
        <div class="modal-map-container" id="modalMap"></div>` : ''}

        ${activity.laps && activity.laps.length > 0 ? `
        <div class="modal-elevation-container">
            <h3>Lap Splits</h3>
            <div class="activity-list" style="margin-top:8px;">
                ${activity.laps.map((lap, i) => `
                    <div class="activity-item" style="cursor:default;">
                        <div class="activity-type-icon">${i + 1}</div>
                        <div class="activity-info">
                            <div class="activity-name">Lap ${i + 1}</div>
                        </div>
                        <div class="activity-stats-row">
                            <div class="activity-stat">
                                <div class="activity-stat-value">${formatDistance(lap.distance)}</div>
                                <div class="activity-stat-label">Dist</div>
                            </div>
                            <div class="activity-stat">
                                <div class="activity-stat-value">${formatDuration(lap.moving_time || lap.elapsed_time)}</div>
                                <div class="activity-stat-label">Time</div>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>` : ''}
    `;

    // Render map if polyline exists
    if (activity.map?.summary_polyline) {
        setTimeout(() => renderActivityMap(activity.map.summary_polyline), 100);
    }
}

function renderActivityMap(polyline) {
    const container = $('#modalMap');
    if (!container) return;

    const coords = decodePolyline(polyline);
    if (coords.length === 0) return;

    state.leafletMap = L.map(container).fitBounds(coords, { padding: [20, 20] });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(state.leafletMap);

    state.leafletLayer = L.polyline(coords, {
        color: '#FC4C02',
        weight: 3,
        opacity: 0.8,
        lineJoin: 'round'
    }).addTo(state.leafletMap);
}

function closeModal() {
    const modal = $('#activityModal');
    modal.classList.add('hidden');
    if (state.leafletMap) {
        state.leafletMap.remove();
        state.leafletMap = null;
        state.leafletLayer = null;
    }
}

// --- Activities View ---
async function loadActivities(reset = true) {
    const spinner = $('#activitiesSpinner');
    const error = $('#activitiesError');
    const list = $('#allActivities');
    const empty = $('#activitiesEmpty');
    const loadMore = $('#loadMoreContainer');

    hideError('activities');
    empty.classList.add('hidden');

    if (reset) {
        state.activityPage[state.currentAthlete] = 1;
        state.hasMore[state.currentAthlete] = true;
        list.innerHTML = '';
        spinner.classList.remove('hidden');
    }

    try {
        const activities = await fetchActivities(state.activityPage[state.currentAthlete], 10);
        const filtered = filterActivities(activities);

        if (reset) {
            state.activities[state.currentAthlete] = activities;
            list.innerHTML = '';
        } else {
            state.activities[state.currentAthlete] = [
                ...state.activities[state.currentAthlete],
                ...activities
            ];
        }

        state.hasMore[state.currentAthlete] = activities.length >= 10;

        if (filtered.length === 0 && reset) {
            empty.classList.remove('hidden');
            loadMore.classList.add('hidden');
        } else {
            filtered.forEach(activity => {
                list.appendChild(createActivityItem(activity));
            });
            loadMore.classList.toggle('hidden', !state.hasMore[state.currentAthlete]);
        }
    } catch (err) {
        showError('activities', err.message);
    } finally {
        spinner.classList.add('hidden');
    }
}

function filterActivities(activities) {
    if (state.activityTypeFilter === 'all') return activities;
    return activities.filter(a => a.type === state.activityTypeFilter);
}

function loadMoreActivities() {
    state.activityPage[state.currentAthlete]++;
    loadActivities(false);
}

// --- Stats View ---
async function loadStats() {
    const spinner = $('#statsSpinner');
    const error = $('#statsError');
    const grid = $('#statsCardsGrid');

    hideError('stats');
    spinner.classList.remove('hidden');
    grid.innerHTML = '';

    try {
        const stats = await fetchStats(state.statsPeriod);
        state.stats[state.currentAthlete][state.statsPeriod] = stats;
        renderStatsCards(stats);
        renderTrendChart(stats);
    } catch (err) {
        showError('stats', err.message);
    } finally {
        spinner.classList.add('hidden');
    }
}

function renderStatsCards(stats) {
    const grid = $('#statsCardsGrid');
    grid.innerHTML = '';

    const cards = [
        { icon: '📏', value: formatDistance(stats.total_distance), label: 'Total Distance' },
        { icon: '⛰️', value: `${(stats.total_elevation_gain || 0).toFixed(0)} m`, label: 'Total Vert' },
        { icon: '⏱️', value: formatDuration(stats.total_moving_time), label: 'Total Time' },
        { icon: '🔢', value: stats.activity_count || 0, label: 'Activities' },
        { icon: '⚡', value: formatPace(stats.average_speed), label: 'Avg Pace' },
        { icon: '🏆', value: formatDistance(stats.longest_run_distance), label: 'Longest Run' }
    ];

    cards.forEach(card => {
        const el = document.createElement('div');
        el.className = 'stat-card';
        el.innerHTML = `
            <div class="stat-card-icon">${card.icon}</div>
            <div class="stat-card-value">${card.value}</div>
            <div class="stat-card-label">${card.label}</div>
        `;
        grid.appendChild(el);
    });
}

function renderTrendChart(stats) {
    const canvas = $('#trendChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    // Set actual canvas size accounting for device pixel ratio
    const displayWidth = canvas.parentElement.clientWidth - 48;
    const displayHeight = 300;
    canvas.style.width = displayWidth + 'px';
    canvas.style.height = displayHeight + 'px';
    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    ctx.scale(dpr, dpr);

    const w = displayWidth;
    const h = displayHeight;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Data
    const periods = stats.periods || [];
    const distances = periods.map(p => (p.distance || 0) / 1000);
    const labels = periods.map(p => p.label || '');

    if (periods.length === 0) {
        ctx.fillStyle = '#4A5568';
        ctx.font = '14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Not enough data to show trends yet. Keep running!', w / 2, h / 2);
        return;
    }

    const maxDist = Math.max(...distances, 1);
    const padding = { top: 30, right: 20, bottom: 50, left: 50 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;
    const barWidth = Math.min(40, (chartW / periods.length) * 0.7);
    const barGap = (chartW - barWidth * periods.length) / (periods.length + 1);

    // Grid lines
    ctx.strokeStyle = '#E8D5B7';
    ctx.lineWidth = 1;
    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
        const y = padding.top + (chartH / gridLines) * i;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(w - padding.right, y);
        ctx.stroke();

        // Y-axis labels
        const val = maxDist - (maxDist / gridLines) * i;
        ctx.fillStyle = '#4A5568';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${val.toFixed(0)} km`, padding.left - 8, y + 4);
    }

    // Bars
    periods.forEach((period, i) => {
        const x = padding.left + barGap + i * (barWidth + barGap);
        const barH = (distances[i] / maxDist) * chartH;
        const y = padding.top + chartH - barH;

        // Gradient bar
        const gradient = ctx.createLinearGradient(x, y, x, padding.top + chartH);
        gradient.addColorStop(0, '#40916C');
        gradient.addColorStop(1, '#1B4332');
        ctx.fillStyle = gradient;

        // Rounded top corners
        const radius = 4;
        ctx.beginPath();
        ctx.moveTo(x, padding.top + chartH);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.lineTo(x + barWidth - radius, y);
        ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
        ctx.lineTo(x + barWidth, padding.top + chartH);
        ctx.closePath();
        ctx.fill();

        // Value on top
        ctx.fillStyle = '#1B4332';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${distances[i].toFixed(1)}`, x + barWidth / 2, y - 6);

        // X-axis label
        ctx.fillStyle = '#4A5568';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(labels[i], x + barWidth / 2, padding.top + chartH + 18);
    });

    // Axes
    ctx.strokeStyle = '#2D3748';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + chartH);
    ctx.lineTo(w - padding.right, padding.top + chartH);
    ctx.stroke();
}

// --- Auto-Refresh ---
function startAutoRefresh() {
    if (state.autoRefreshInterval) clearInterval(state.autoRefreshInterval);
    state.autoRefreshInterval = setInterval(() => {
        if (state.connected[state.currentAthlete]) {
            if (state.currentView === 'dashboard') loadDashboard();
            else if (state.currentView === 'stats') loadStats();
        }
    }, 5 * 60 * 1000); // Every 5 minutes
}

// --- Event Bindings ---
function bindEvents() {
    // Nav tabs
    $$('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    // Profile switcher
    $$('.profile-btn').forEach(btn => {
        btn.addEventListener('click', () => switchProfile(btn.dataset.athlete));
    });

    // Connect button
    $('#btnConnect').addEventListener('click', initiateStravaConnect);

    // Modal close
    $('#modalClose').addEventListener('click', closeModal);
    $('#activityModal').addEventListener('click', (e) => {
        if (e.target === $('#activityModal')) closeModal();
    });

    // Load more
    $('#btnLoadMore').addEventListener('click', loadMoreActivities);

    // Activity type filter
    $('#activityTypeFilter').addEventListener('change', (e) => {
        state.activityTypeFilter = e.target.value;
        loadActivities(true);
    });

    // Stats period tabs
    $$('.period-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            state.statsPeriod = tab.dataset.period;
            $$('.period-tab').forEach(t => t.classList.toggle('active', t === tab));
            loadStats();
        });
    });

    // Retry buttons
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('btn-retry')) {
            const viewName = e.target.closest('.error-banner')?.id?.replace('Error', '');
            if (viewName === 'dashboard') loadDashboard();
            else if (viewName === 'activities') loadActivities();
            else if (viewName === 'stats') loadStats();
        }
    });

    // Keyboard: Escape to close modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('#activityModal').classList.contains('hidden')) {
            closeModal();
        }
    });

    // Handle window resize for chart
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (state.currentView === 'stats') {
                const stats = state.stats[state.currentAthlete][state.statsPeriod];
                if (stats) renderTrendChart(stats);
            }
        }, 250);
    });
}

// --- Initialization ---
async function init() {
    bindEvents();

    // Check for OAuth callback
    const handled = await handleAuthCallback();

    // Check connection status from cache
    const cachedAthlete = loadFromCache('athlete', 24 * 60 * 60 * 1000);
    if (cachedAthlete) {
        state.connected[state.currentAthlete] = true;
        state.athleteData[state.currentAthlete] = cachedAthlete.data;
    }

    // If we just handled a callback, connection is already set
    if (!handled) {
        // Try to verify connection by fetching athlete
        try {
            const athlete = await fetchAthlete();
            state.connected[state.currentAthlete] = true;
            state.athleteData[state.currentAthlete] = athlete;
            saveToCache('athlete', athlete);
        } catch (err) {
            // Not connected — show connect prompt
            state.connected[state.currentAthlete] = false;
        }
    }

    checkConnectionStatus();
    startAutoRefresh();
}

// --- Boot ---
document.addEventListener('DOMContentLoaded', init);
