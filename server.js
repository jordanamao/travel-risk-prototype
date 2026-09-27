const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

loadEnv();

const PORT = Number(process.env.PORT || 5177);
const PUBLIC_DIR = path.join(__dirname, "public");
const USER_AGENT = "travel-risk-prototype/1.0 (candidate assessment prototype)";
const KNOWN_LOCATIONS = {
  "new york, ny": { label: "New York, NY, United States", lat: 40.7128, lon: -74.0060 },
  "san francisco, ca": { label: "San Francisco, CA, United States", lat: 37.7749, lon: -122.4194 },
  "seattle, wa": { label: "Seattle, WA, United States", lat: 47.6062, lon: -122.3321 },
  "dallas, tx": { label: "Dallas, TX, United States", lat: 32.7767, lon: -96.7970 },
  "chicago, il": { label: "Chicago, IL, United States", lat: 41.8781, lon: -87.6298 },
  "los angeles, ca": { label: "Los Angeles, CA, United States", lat: 34.0522, lon: -118.2437 },
  "atlanta, ga": { label: "Atlanta, GA, United States", lat: 33.7490, lon: -84.3880 },
  "boston, ma": { label: "Boston, MA, United States", lat: 42.3601, lon: -71.0589 },
  "denver, co": { label: "Denver, CO, United States", lat: 39.7392, lon: -104.9903 },
  "miami, fl": { label: "Miami, FL, United States", lat: 25.7617, lon: -80.1918 },
  "washington, dc": { label: "Washington, DC, United States", lat: 38.9072, lon: -77.0369 },
  "houston, tx": { label: "Houston, TX, United States", lat: 29.7604, lon: -95.3698 },
  "phoenix, az": { label: "Phoenix, AZ, United States", lat: 33.4484, lon: -112.0740 },
  "las vegas, nv": { label: "Las Vegas, NV, United States", lat: 36.1699, lon: -115.1398 },
  "orlando, fl": { label: "Orlando, FL, United States", lat: 28.5383, lon: -81.3792 },
  "philadelphia, pa": { label: "Philadelphia, PA, United States", lat: 39.9526, lon: -75.1652 },
  "minneapolis, mn": { label: "Minneapolis, MN, United States", lat: 44.9778, lon: -93.2650 },
  "charlotte, nc": { label: "Charlotte, NC, United States", lat: 35.2271, lon: -80.8431 },
  "portland, or": { label: "Portland, OR, United States", lat: 45.5152, lon: -122.6784 },
  "austin, tx": { label: "Austin, TX, United States", lat: 30.2672, lon: -97.7431 }
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/analyze") {
      await handleAnalyze(url, res);
      return;
    }

    serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    const message = error.message.includes("429")
      ? "External geocoding service is rate-limiting requests. Try a listed city or wait a moment before retrying."
      : "Unexpected server error";
    sendJson(res, 500, {
      error: message,
      details: error.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`Travel Risk Prototype running at http://localhost:${PORT}`);
});

async function handleAnalyze(url, res) {
  const origin = clean(url.searchParams.get("origin"));
  const destination = clean(url.searchParams.get("destination"));
  const date = clean(url.searchParams.get("date"));
  const mode = clean(url.searchParams.get("mode")) || "flight";
  const originAirport = cleanAirport(url.searchParams.get("originAirport"));
  const destinationAirport = cleanAirport(url.searchParams.get("destinationAirport"));

  if (!origin || !destination || !date) {
    sendJson(res, 400, {
      error: "origin, destination, and date are required"
    });
    return;
  }

  const dateValidation = validateTravelDate(date);
  if (!dateValidation.valid) {
    sendJson(res, 400, {
      error: dateValidation.message
    });
    return;
  }

  const originGeo = await geocode(origin);
  const destinationGeo = await geocode(destination);
  const midpoint = {
    label: "Route midpoint",
    lat: (originGeo.lat + destinationGeo.lat) / 2,
    lon: (originGeo.lon + destinationGeo.lon) / 2
  };

  const [originWeather, destinationWeather, midpointWeather, originNws, destinationNws, aviation] =
    await Promise.all([
      safeBundle(
        () => getOpenMeteo(originGeo, date, "Origin forecast"),
        "Open-Meteo Forecast API",
        "Origin forecast",
        originGeo.label
      ),
      safeBundle(
        () => getOpenMeteo(destinationGeo, date, "Destination forecast"),
        "Open-Meteo Forecast API",
        "Destination forecast",
        destinationGeo.label
      ),
      safeBundle(
        () => getOpenMeteo(midpoint, date, "Route midpoint forecast"),
        "Open-Meteo Forecast API",
        "Route midpoint forecast",
        midpoint.label
      ),
      safeBundle(
        () => getNwsBundle(originGeo, "Origin NWS"),
        "National Weather Service API",
        "Origin NWS",
        originGeo.label
      ),
      safeBundle(
        () => getNwsBundle(destinationGeo, "Destination NWS"),
        "National Weather Service API",
        "Destination NWS",
        destinationGeo.label
      ),
      safeBundle(
        () => getAviationBundle(originGeo, destinationGeo, { originAirport, destinationAirport }),
        "Aviation Weather Center API",
        "Airport weather",
        `${originGeo.label} and ${destinationGeo.label}`
      )
    ]);

  const evidence = [
    ...originWeather.evidence,
    ...destinationWeather.evidence,
    ...midpointWeather.evidence,
    ...originNws.evidence,
    ...destinationNws.evidence,
    ...aviation.evidence
  ];

  const signals = [
    ...originWeather.signals,
    ...destinationWeather.signals,
    ...midpointWeather.signals,
    ...originNws.signals,
    ...destinationNws.signals,
    ...aviation.signals
  ];

  const score = scoreSignals(signals, mode);
  const synthesis = await synthesizeWithAi({
    origin: originGeo,
    destination: destinationGeo,
    date,
    mode,
    score,
    signals,
    evidence
  });

  sendJson(res, 200, {
    input: { origin, destination, date, mode, originAirport, destinationAirport },
    route: {
      origin: originGeo,
      destination: destinationGeo,
      midpoint
    },
    score,
    summary: synthesis.summary,
    recommendation: synthesis.recommendation,
    uncertainty: synthesis.uncertainty,
    ai: synthesis.ai,
    signals,
    evidence,
    sources: [
      {
        name: "OpenStreetMap Nominatim",
        purpose: "Geocodes user-entered route locations",
        url: "https://nominatim.openstreetmap.org/"
      },
      {
        name: "Open-Meteo Forecast API",
        purpose: "Hourly and daily weather forecast for origin, midpoint, and destination",
        url: "https://open-meteo.com/"
      },
      {
        name: "National Weather Service API",
        purpose: "Active alerts and official point forecasts",
        url: "https://www.weather.gov/documentation/services-web-api"
      },
      {
        name: "Aviation Weather Center API",
        purpose: "METAR airport weather observations near the route endpoints",
        url: "https://aviationweather.gov/data/api/"
      }
    ]
  });
}

async function geocode(query) {
  const known = KNOWN_LOCATIONS[query.toLowerCase()];
  if (known) {
    return {
      ...known,
      source: "Built-in city coordinates"
    };
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("limit", "1");

  const data = await fetchJson(url);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Could not geocode location: ${query}`);
  }

  const item = data[0];
  return {
    label: item.display_name,
    lat: Number(item.lat),
    lon: Number(item.lon),
    source: "OpenStreetMap Nominatim"
  };
}

async function safeBundle(loader, source, label, location) {
  try {
    return await loader();
  } catch (error) {
    return {
      evidence: [
        {
          source,
          label,
          severity: "unknown",
          headline: `${label} data unavailable`,
          details: {
            location,
            reason: error.message
          },
          url: ""
        }
      ],
      signals: []
    };
  }
}

async function getOpenMeteo(point, date, label) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(point.lat));
  url.searchParams.set("longitude", String(point.lon));
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", date);
  url.searchParams.set("end_date", date);
  url.searchParams.set(
    "hourly",
    "temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,visibility"
  );
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max"
  );

  const data = await fetchJson(url);
  const daily = data.daily || {};
  const evidence = [];
  const signals = [];

  const precipProbability = firstNumber(daily.precipitation_probability_max);
  const precipSum = firstNumber(daily.precipitation_sum);
  const windMax = firstNumber(daily.wind_speed_10m_max);
  const gustMax = firstNumber(daily.wind_gusts_10m_max);
  const tempMax = firstNumber(daily.temperature_2m_max);
  const tempMin = firstNumber(daily.temperature_2m_min);

  evidence.push({
    source: "Open-Meteo Forecast API",
    label,
    severity: severityFromWeather(precipProbability, precipSum, windMax, gustMax),
    headline: `${label}: ${displayValue(tempMin)}-${displayValue(tempMax)} C, ${displayValue(precipProbability, 0)}% precipitation risk, ${displayValue(precipSum)} mm precipitation, max wind ${displayValue(windMax)} km/h`,
    details: {
      location: point.label,
      date,
      precipitationProbabilityPercent: precipProbability,
      precipitationMm: precipSum,
      maxWindKmh: windMax,
      maxGustKmh: gustMax,
      maxTempC: tempMax,
      minTempC: tempMin
    },
    url: String(url)
  });

  if ((precipProbability || 0) >= 60 || (precipSum || 0) >= 10) {
    signals.push({
      type: "weather",
      severity: (precipProbability || 0) >= 80 || (precipSum || 0) >= 25 ? "high" : "medium",
      message: `${label} has elevated precipitation risk.`,
      evidence: "Open-Meteo daily forecast"
    });
  }
  if ((windMax || 0) >= 40 || (gustMax || 0) >= 55) {
    signals.push({
      type: "wind",
      severity: (windMax || 0) >= 55 || (gustMax || 0) >= 75 ? "high" : "medium",
      message: `${label} has potentially disruptive wind.`,
      evidence: "Open-Meteo wind forecast"
    });
  }

  return { evidence, signals };
}

async function getNwsBundle(point, label) {
  const evidence = [];
  const signals = [];

  try {
    const pointUrl = `https://api.weather.gov/points/${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
    const pointData = await fetchJson(pointUrl);
    const forecastUrl = pointData && pointData.properties ? pointData.properties.forecast : null;
    const forecast = forecastUrl ? await fetchJson(forecastUrl) : null;
    const periods = forecast && forecast.properties && forecast.properties.periods ? forecast.properties.periods : [];
    const nextPeriods = periods.slice(0, 4).map((period) => ({
      name: period.name,
      shortForecast: period.shortForecast,
      detailedForecast: period.detailedForecast,
      windSpeed: period.windSpeed,
      probabilityOfPrecipitation: period.probabilityOfPrecipitation ? period.probabilityOfPrecipitation.value : null
    }));

    if (nextPeriods.length) {
      evidence.push({
        source: "National Weather Service API",
        label: `${label} forecast`,
        severity: "info",
        headline: `${label}: ${nextPeriods[0].shortForecast}`,
        details: nextPeriods,
        url: forecastUrl
      });
    }

    const alertsUrl = new URL("https://api.weather.gov/alerts/active");
    alertsUrl.searchParams.set("point", `${point.lat},${point.lon}`);
    const alerts = await fetchJson(alertsUrl);
    const features = alerts && alerts.features ? alerts.features : [];

    for (const alert of features.slice(0, 5)) {
      const props = alert.properties || {};
      const severity = nwsSeverity(props.severity, props.urgency);
      evidence.push({
        source: "National Weather Service API",
        label: `${label} alert`,
        severity,
        headline: props.headline || props.event || "Active weather alert",
        details: {
          event: props.event,
          severity: props.severity,
          urgency: props.urgency,
          areas: props.areaDesc,
          instruction: props.instruction
        },
        url: props.uri || String(alertsUrl)
      });
      if (!isStaleNwsAlert(props)) {
        signals.push({
          type: "official-alert",
          severity,
          message: `${label} has active NWS alert: ${props.event || props.headline}`,
          evidence: props.headline || props.event
        });
      }
    }
  } catch (error) {
    evidence.push({
      source: "National Weather Service API",
      label,
      severity: "unknown",
      headline: `NWS data unavailable for ${point.label}`,
      details: { error: error.message },
      url: "https://api.weather.gov/"
    });
  }

  return { evidence, signals };
}

async function getAviationBundle(origin, destination, preferences = {}) {
  const originData = await getNearestMetars(origin, "Origin airport weather", preferences.originAirport);
  const destData = await getNearestMetars(destination, "Destination airport weather", preferences.destinationAirport);
  return {
    evidence: [...originData.evidence, ...destData.evidence],
    signals: [...originData.signals, ...destData.signals]
  };
}

async function getNearestMetars(point, label, preferredIcao) {
  const evidence = [];
  const signals = [];
  const latDelta = 1.5;
  const lonDelta = 1.5;
  const bbox = [
    point.lat - latDelta,
    point.lon - lonDelta,
    point.lat + latDelta,
    point.lon + lonDelta
  ].join(",");
  const url = new URL("https://aviationweather.gov/api/data/metar");
  url.searchParams.set("bbox", bbox);
  url.searchParams.set("format", "json");

  try {
    const data = await fetchJson(url);
    const rows = Array.isArray(data) ? data : [];
    let nearest = rows
      .filter((row) => Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon)))
      .map((row) => ({
        ...row,
        distanceKm: haversineKm(point.lat, point.lon, Number(row.lat), Number(row.lon))
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 3);

    if (preferredIcao) {
      const preferred = rows
        .filter((row) =>
          String(row.icaoId || "").toUpperCase() === preferredIcao &&
          Number.isFinite(Number(row.lat)) &&
          Number.isFinite(Number(row.lon))
        )
        .map((row) => ({
          ...row,
          distanceKm: haversineKm(point.lat, point.lon, Number(row.lat), Number(row.lon))
        }));
      if (preferred.length) nearest = preferred.slice(0, 1);
    }

    for (const metar of nearest) {
      const severity = severityFromFlightCategory(metar.fltCat, metar.wspd, metar.wgst, metar.visib);
      evidence.push({
        source: "Aviation Weather Center API",
        label,
        severity,
        headline: `${metar.icaoId || "Airport"} ${metar.fltCat || "weather"}: ${metar.rawOb || "METAR observation"}`,
        details: {
          station: metar.icaoId,
          name: metar.name,
          flightCategory: metar.fltCat,
          windKt: metar.wspd,
          gustKt: metar.wgst,
          visibilitySm: metar.visib,
          weather: metar.wxString,
          distanceKm: Math.round(metar.distanceKm)
        },
        url: String(url)
      });

      if (["medium", "high"].includes(severity)) {
        signals.push({
          type: "aviation-weather",
          severity,
          message: `${label} near ${metar.icaoId}: ${metar.fltCat || "weather"} conditions.`,
          evidence: metar.rawOb || `${metar.icaoId} METAR`
        });
      }
    }

    if (!nearest.length) {
      evidence.push({
        source: "Aviation Weather Center API",
        label,
        severity: "unknown",
        headline: `No nearby METAR stations returned for ${point.label}`,
        details: { bbox },
        url: String(url)
      });
    }
  } catch (error) {
    evidence.push({
      source: "Aviation Weather Center API",
      label,
      severity: "unknown",
      headline: `Aviation weather unavailable near ${point.label}`,
      details: { error: error.message },
      url: String(url)
    });
  }

  return { evidence, signals };
}

function scoreSignals(signals, mode) {
  const weights = { low: 1, info: 0, unknown: 0, medium: 3, high: 6 };
  let points = 0;
  for (const signal of signals) {
    const basePoints = weights[signal.severity] || 0;
    const modeBonus = mode === "flight" && signal.type === "aviation-weather" ? 1 : 0;
    signal.points = basePoints + modeBonus;
    points += signal.points;
  }

  const level = points >= 10 ? "High" : points >= 5 ? "Medium" : "Low";
  const confidence = signals.length >= 4 ? "medium-high" : signals.length >= 2 ? "medium" : "low-medium";
  return { points, level, confidence };
}

async function synthesizeWithAi(context) {
  if (process.env.OPENAI_API_KEY) {
    try {
      const response = await postJson("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-6-astra",
          instructions:
            "You are a travel operations risk analyst. Summarize travel disruption risk using only the supplied evidence. Be concise, mention uncertainty, and recommend practical action.",
          input: JSON.stringify({
            route: {
              origin: context.origin.label,
              destination: context.destination.label,
              date: context.date,
              mode: context.mode
            },
            score: context.score,
            signals: context.signals,
            evidence: context.evidence.map((item) => ({
              source: item.source,
              severity: item.severity,
              headline: item.headline
            }))
          }),
          max_output_tokens: 350,
          text: {
            format: {
              type: "json_schema",
              name: "travel_risk_summary",
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  summary: { type: "string" },
                  recommendation: { type: "string" },
                  uncertainty: { type: "string" }
                },
                required: ["summary", "recommendation", "uncertainty"]
              }
            }
          }
        })
      });

      const data = response;
      const text = data.output_text || extractOutputText(data);
      const parsed = JSON.parse(text);
      return { ...parsed, ai: { used: true, provider: "OpenAI Responses API" } };
    } catch (error) {
      return { ...localSynthesis(context), ai: { used: false, provider: "local fallback", error: error.message } };
    }
  }

  return { ...localSynthesis(context), ai: { used: false, provider: "local fallback", reason: "OPENAI_API_KEY not set" } };
}

function localSynthesis(context) {
  const topSignals = [...context.signals].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const top = topSignals.slice(0, 3);
  const driverText = readableDriverText(top);

  const recommendation =
    context.score.level === "High"
      ? "Consider alternate timing or routing, monitor official alerts closely, and confirm flight or road status before departure."
      : context.score.level === "Medium"
      ? "Proceed with caution, build in extra time, and recheck conditions closer to departure."
      : "Trip risk appears manageable based on currently available evidence; still recheck conditions before leaving.";

  return {
    summary: top.length
      ? `${context.score.level} disruption risk, driven by ${driverText}.`
      : `${context.score.level} disruption risk. No major risk signals were found in the current data sources.`,
    recommendation,
    uncertainty:
      "This prototype combines live weather and aviation signals. It does not include airline-specific operations, booked flight status, road closures, or private corporate policies."
  };
}

function readableDriverText(signals) {
  const labels = signals.map((signal) => {
    if (signal.type === "weather") return "heavy precipitation forecast at the origin";
    if (signal.type === "wind") return "potentially disruptive wind";
    if (signal.type === "aviation-weather") {
      const station = signal.message.match(/near\s+([A-Z0-9]+)/);
      return station ? `${station[1]} airport weather conditions` : "airport weather conditions";
    }
    if (signal.type === "official-alert") {
      const event = signal.message.match(/alert:\s*(.+)$/);
      return event ? `an active ${event[1]}` : "an active official weather alert";
    }
    return signal.message.toLowerCase();
  });

  if (labels.length <= 1) return labels[0] || "current weather conditions";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

async function fetchJson(url) {
  const response = await requestText("GET", String(url), null, {
    "User-Agent": USER_AGENT,
    Accept: "application/json"
  });
  if (response.statusCode === 204) return [];
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Fetch failed ${response.statusCode} for ${url}: ${response.body.slice(0, 160)}`);
  }
  return JSON.parse(response.body || "null");
}

async function postJson(url, options) {
  const response = await requestText("POST", String(url), options.body || "", options.headers || {});
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`OpenAI request failed: ${response.statusCode} ${response.body.slice(0, 160)}`);
  }
  return JSON.parse(response.body || "{}");
}

function requestText(method, urlString, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === "http:" ? http : https;
    const payload = body || null;
    const requestHeaders = Object.assign({}, headers || {});
    if (payload) {
      requestHeaders["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = transport.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        headers: requestHeaders,
        timeout: 15000
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out for ${urlString}`));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanAirport(value) {
  const cleaned = clean(value).toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(cleaned) ? cleaned : "";
}

function firstNumber(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const num = Number(values[0]);
  return Number.isFinite(num) ? num : null;
}

function displayValue(value, fallback = "?") {
  return value === null || value === undefined ? fallback : value;
}

function validateTravelDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { valid: false, message: "Travel date must use YYYY-MM-DD format." };
  }

  const requested = parseIsoDate(date);
  if (!requested) {
    return { valid: false, message: "Travel date is not valid." };
  }

  const today = startOfUtcDay(new Date());
  const maxForecastDate = addUtcDays(today, 15);

  if (requested < today) {
    return { valid: false, message: "Travel date must be today or later." };
  }

  if (requested > maxForecastDate) {
    return {
      valid: false,
      message: `Travel date is too far out for the live forecast window. This prototype can assess trips through ${formatIsoDate(maxForecastDate)} because the weather API only provides forecast data for about the next 15 days.`
    };
  }

  return { valid: true };
}

function parseIsoDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function severityFromWeather(precip, precipAmount, wind, gust) {
  if ((precip || 0) >= 80 || (precipAmount || 0) >= 25 || (wind || 0) >= 55 || (gust || 0) >= 75) {
    return "high";
  }
  if ((precip || 0) >= 60 || (precipAmount || 0) >= 10 || (wind || 0) >= 40 || (gust || 0) >= 55) {
    return "medium";
  }
  return "low";
}

function nwsSeverity(severity, urgency) {
  if (["Extreme", "Severe"].includes(severity) || urgency === "Immediate") return "high";
  if (["Moderate"].includes(severity) || urgency === "Expected") return "medium";
  return "low";
}

function isStaleNwsAlert(props) {
  const text = `${props.headline || ""} ${props.description || ""} ${props.instruction || ""}`.toLowerCase();
  return props.urgency === "Past" || text.includes("has been replaced") || text.includes("expired");
}

function severityFromFlightCategory(category, wind, gust, visibility) {
  const vis = parseFloat(String(visibility || "").replace("+", ""));
  if (category === "LIFR" || category === "IFR" || Number(gust) >= 35 || Number(wind) >= 30 || vis < 3) {
    return "high";
  }
  if (category === "MVFR" || Number(gust) >= 25 || Number(wind) >= 20 || vis < 6) {
    return "medium";
  }
  return "low";
}

function severityRank(severity) {
  return { high: 3, medium: 2, low: 1, info: 0, unknown: 0 }[severity] || 0;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function extractOutputText(data) {
  const parts = [];
  const output = data.output || [];
  for (const item of output) {
    const contents = item.content || [];
    for (const content of contents) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
