const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

loadEnv();

const PORT = Number(process.env.PORT || 5177);
const PUBLIC_DIR = path.join(__dirname, "public");
const USER_AGENT = "travel-risk-prototype/1.0 (candidate assessment prototype)";

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
    sendJson(res, 500, {
      error: "Unexpected server error",
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

  if (!origin || !destination || !date) {
    sendJson(res, 400, {
      error: "origin, destination, and date are required"
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
      getOpenMeteo(originGeo, date, "Origin forecast"),
      getOpenMeteo(destinationGeo, date, "Destination forecast"),
      getOpenMeteo(midpoint, date, "Route midpoint forecast"),
      getNwsBundle(originGeo, "Origin NWS"),
      getNwsBundle(destinationGeo, "Destination NWS"),
      getAviationBundle(originGeo, destinationGeo)
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
    input: { origin, destination, date, mode },
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
    severity: severityFromWeather(precipProbability, windMax, gustMax),
    headline: `${label}: ${displayValue(tempMin)}-${displayValue(tempMax)} C, ${displayValue(precipProbability, 0)}% precipitation risk, max wind ${displayValue(windMax)} km/h`,
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
      signals.push({
        type: "official-alert",
        severity,
        message: `${label} has active NWS alert: ${props.event || props.headline}`,
        evidence: props.headline || props.event
      });
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

async function getAviationBundle(origin, destination) {
  const originData = await getNearestMetars(origin, "Origin airport weather");
  const destData = await getNearestMetars(destination, "Destination airport weather");
  return {
    evidence: [...originData.evidence, ...destData.evidence],
    signals: [...originData.signals, ...destData.signals]
  };
}

async function getNearestMetars(point, label) {
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
    const nearest = rows
      .filter((row) => Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon)))
      .map((row) => ({
        ...row,
        distanceKm: haversineKm(point.lat, point.lon, Number(row.lat), Number(row.lon))
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 3);

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

      if (["IFR", "LIFR", "MVFR"].includes(metar.fltCat) || Number(metar.wspd) >= 25 || Number(metar.wgst) >= 35) {
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
    points += weights[signal.severity] || 0;
    if (mode === "flight" && signal.type === "aviation-weather") points += 1;
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
  const riskText =
    top.length > 0
      ? top.map((signal) => signal.message).join(" ")
      : "No major risk signals were found in the current data sources.";

  const recommendation =
    context.score.level === "High"
      ? "Consider alternate timing or routing, monitor official alerts closely, and confirm flight or road status before departure."
      : context.score.level === "Medium"
      ? "Proceed with caution, build in extra time, and recheck conditions closer to departure."
      : "Trip risk appears manageable based on currently available evidence; still recheck conditions before leaving.";

  return {
    summary: `${context.score.level} disruption risk. ${riskText}`,
    recommendation,
    uncertainty:
      "This prototype combines live weather and aviation signals. It does not include airline-specific operations, booked flight status, road closures, or private corporate policies."
  };
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
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream"
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

function firstNumber(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const num = Number(values[0]);
  return Number.isFinite(num) ? num : null;
}

function displayValue(value, fallback = "?") {
  return value === null || value === undefined ? fallback : value;
}

function severityFromWeather(precip, wind, gust) {
  if ((precip || 0) >= 80 || (wind || 0) >= 55 || (gust || 0) >= 75) return "high";
  if ((precip || 0) >= 60 || (wind || 0) >= 40 || (gust || 0) >= 55) return "medium";
  return "low";
}

function nwsSeverity(severity, urgency) {
  if (["Extreme", "Severe"].includes(severity) || urgency === "Immediate") return "high";
  if (["Moderate"].includes(severity) || urgency === "Expected") return "medium";
  return "low";
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
