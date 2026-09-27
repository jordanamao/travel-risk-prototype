const form = document.querySelector("#trip-form");
const dateInput = document.querySelector('input[name="date"]');
const emptyState = document.querySelector("#empty-state");
const loading = document.querySelector("#loading");
const results = document.querySelector("#results");
const errorBox = document.querySelector("#error");

// Helper function to format Date object into YYYY-MM-DD using local time
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Initialize date field values
const today = new Date();
const tomorrow = new Date();
tomorrow.setDate(today.getDate() + 1);

const maxForecastDate = new Date();
maxForecastDate.setDate(today.getDate() + 15);

if (dateInput) {
  dateInput.min = formatDate(today);
  dateInput.max = formatDate(maxForecastDate);
  dateInput.value = formatDate(tomorrow);
}

const dateHelp = document.querySelector("#date-help");
if (dateHelp) {
  dateHelp.textContent = `Live forecast data is available for the next 15 days, so this prototype can assess trips through ${formatDate(maxForecastDate)}.`;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const params = new URLSearchParams(new FormData(form));
  setState("loading");

  try {
    const response = await fetch(`/api/analyze?${params}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to analyze trip");
    }
    renderResults(data);
    setState("results");
  } catch (error) {
    errorBox.textContent =
        error.message === "Failed to fetch"
            ? "Could not reach the local prototype server. Refresh http://localhost:5178 and try again."
            : error.message;
    setState("error");
  }
});

function setState(state) {
  emptyState.classList.toggle("hidden", state !== "empty");
  loading.classList.toggle("hidden", state !== "loading");
  results.classList.toggle("hidden", state !== "results");
  errorBox.classList.toggle("hidden", state !== "error");
}

function renderResults(data) {
  const level = data.score.level.toLowerCase();
  document.querySelector("#risk-title").textContent =
      `${data.input.origin} to ${data.input.destination} on ${data.input.date} · ${tripTypeLabel(data.input.mode)}`;
  document.querySelector("#risk-summary").textContent = data.summary;
  document.querySelector("#recommendation").textContent = data.recommendation;
  document.querySelector("#uncertainty").textContent =
      `${data.uncertainty} ${summaryModeText(data.ai)}`;

  const header = document.querySelector(".risk-header");
  header.className = `risk-header ${level}`;

  const badge = document.querySelector("#risk-badge");
  badge.className = `risk-badge ${level}`;
  badge.textContent = data.score.level;

  updateRadarMap(data.input.destination);
  renderGlance(data);
  renderWhySummary(data);
  renderSignals(data.signals);

  renderCards(
      "#sources",
      data.sources.map((source) => ({
        meta: source.name,
        title: source.purpose,
        body: source.url
      }))
  );

  renderEvidence(data.evidence);
}

function updateRadarMap(destination) {
  const iframe = document.querySelector("#radar-iframe");
  if (!iframe) return;

  let lat = 39.8283;
  let lon = -98.5795;
  let zoom = 5;

  const dest = destination.toLowerCase();
  if (dest.includes("san francisco") || dest.includes("sfo")) {
    lat = 37.7749; lon = -122.4194; zoom = 7;
  } else if (dest.includes("new york") || dest.includes("jfk") || dest.includes("lga") || dest.includes("ewr")) {
    lat = 40.7128; lon = -74.0060; zoom = 7;
  } else if (dest.includes("chicago") || dest.includes("ord")) {
    lat = 41.8781; lon = -87.6298; zoom = 7;
  } else if (dest.includes("los angeles") || dest.includes("lax")) {
    lat = 34.0522; lon = -118.2437; zoom = 7;
  }

  iframe.src = `https://embed.windy.com/embed2.html?lat=${lat}&lon=${lon}&zoom=${zoom}&level=surface&overlay=radar&menu=&message=true&marker=true&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=default&metricTemp=default&radarRange=-1`;
}

function renderGlance(data) {
  const alertCount = data.signals.filter((signal) => signal.type === "official-alert").length;
  const airportIssueCount = data.signals.filter((signal) => signal.type === "aviation-weather").length;
  const forecastIssueCount = data.signals.filter((signal) =>
      ["weather", "wind"].includes(signal.type)
  ).length;
  const sourceCount = new Set(data.evidence.map((item) => item.source)).size;

  const metrics = [
    {
      label: "Risk Score",
      val: `${data.score.level} risk`,
      sub: `${data.score.points} pts · ${data.score.confidence} confidence`,
      sev: data.score.level.toLowerCase()
    },
    {
      label: "Signals",
      val: `${data.signals.length} detected`,
      sub: `${alertCount} alerts · ${airportIssueCount} airport · ${forecastIssueCount} forecast`,
      sev: data.signals.length ? data.score.level.toLowerCase() : "low"
    },
    {
      label: "Evidence",
      val: `${data.evidence.length} items`,
      sub: `${sourceCount} external sources checked`,
      sev: "info"
    },
    {
      label: "Summary Mode",
      val: data.ai.used ? "OpenAI API" : "Local Engine",
      sub: data.ai.used ? "OpenAI synthesis used" : "OpenAI disabled",
      sev: "info"
    }
  ];

  const container = document.querySelector("#glance");
  container.innerHTML = metrics.map(m => `
    <div class="card metric-card">
      <span class="meta">${m.label}</span>
      <strong class="metric-val">${m.val}</strong>
      <span class="body">${m.sub}</span>
      <span class="severity ${m.sev}">${m.sev}</span>
    </div>
  `).join('');
}

function renderWhySummary(data) {
  const list = document.querySelector("#why-list");
  const math = document.querySelector("#score-math");
  list.innerHTML = "";

  const scoredSignals = [...data.signals]
      .sort((a, b) => (b.points || 0) - (a.points || 0));

  if (!scoredSignals.length) {
    const item = document.createElement("li");
    item.textContent = "No scored risk signals were detected.";
    list.appendChild(item);
  } else {
    for (const signal of scoredSignals) {
      const item = document.createElement("li");
      item.textContent = `${shortSignalLabel(signal)}: +${signal.points || 0}${shortPointReason(signal)}`;
      list.appendChild(item);
    }
  }

  const pointParts = data.signals.map((signal) => `${signal.points || 0} ${shortSignalLabel(signal)}`);
  math.textContent = pointParts.length
      ? `${pointParts.join(" + ")} = ${data.score.points} points; ${data.score.level} risk`
      : `0 points; ${data.score.level} risk`;
}

function renderCards(selector, items) {
  const container = document.querySelector(selector);
  container.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <p class="meta"></p>
      <p><strong></strong></p>
      <p class="body"></p>
      ${item.severity ? `<span class="severity ${item.severity}">${item.severity}</span>` : ""}
    `;
    card.querySelector(".meta").textContent = item.meta;
    card.querySelector("strong").textContent = item.title;
    card.querySelector(".body").textContent = item.body || "";
    container.appendChild(card);
  }
}

function renderSignals(signals) {
  const container = document.querySelector("#signals");
  container.innerHTML = "";

  if (!signals.length) {
    renderCards("#signals", [
      {
        meta: "No major signals",
        title: "No meaningful risk signal was detected.",
        body: "The evidence still appears below for review.",
        severity: "low"
      }
    ]);
    return;
  }

  for (const group of groupSignals(signals)) {
    const heading = document.createElement("div");
    heading.className = "evidence-group-heading";
    heading.innerHTML = `
      <h4></h4>
      <p class="section-note"></p>
    `;
    heading.querySelector("h4").textContent = group.title;
    heading.querySelector("p").textContent = group.description;
    container.appendChild(heading);

    for (const signal of group.items) {
      container.appendChild(createSignalCard(signal));
    }
  }
}

function createSignalCard(signal) {
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    <p class="meta"></p>
    <p><strong></strong></p>
    <p class="body"></p>
    ${signal.points !== undefined ? `<p class="field-note points"></p>` : ""}
    <span class="severity ${signal.severity}">${signal.severity}</span>
  `;
  card.querySelector(".meta").textContent = `${signal.type} · ${signal.severity}`;
  card.querySelector("strong").textContent = signal.message;
  card.querySelector(".body").textContent = signal.evidence || "";
  const points = card.querySelector(".points");
  if (points) points.textContent = pointExplanation(signal);
  return card;
}

function pointExplanation(signal) {
  const points = signal.points || 0;
  const label = `Adds ${points} point${points === 1 ? "" : "s"} to the risk score.`;
  if (signal.type === "aviation-weather" && points === 4 && signal.severity === "medium") {
    return `${label} 3 medium-risk points + 1 flight-focused airport bonus.`;
  }
  if (signal.type === "aviation-weather" && points === 7 && signal.severity === "high") {
    return `${label} 6 high-risk points + 1 flight-focused airport bonus.`;
  }
  if (signal.severity === "high") return `${label} High-risk signal = 6 points.`;
  if (signal.severity === "medium") return `${label} Medium-risk signal = 3 points.`;
  if (signal.severity === "low") return `${label} Low-risk signal = 1 point.`;
  return label;
}

function shortPointReason(signal) {
  if (signal.type === "aviation-weather" && signal.points > 0) {
    return " (flight bonus included)";
  }
  return "";
}

function shortSignalLabel(signal) {
  if (signal.type === "weather") return "Heavy precipitation forecast";
  if (signal.type === "wind") return "Wind forecast";
  if (signal.type === "aviation-weather") {
    const match = signal.message.match(/near\s+([A-Z0-9]+)/);
    return match ? `${match[1]} airport weather` : "Airport weather";
  }
  if (signal.type === "official-alert") {
    const match = signal.message.match(/alert:\s*(.+)$/);
    return match ? match[1] : "Official alert";
  }
  return signal.type || "Signal";
}

function groupSignals(signals) {
  const forecast = [];
  const officialAlerts = [];
  const airportWeather = [];
  const otherSignals = [];

  for (const signal of signals) {
    if (["weather", "wind"].includes(signal.type)) {
      forecast.push(signal);
    } else if (signal.type === "official-alert") {
      officialAlerts.push(signal);
    } else if (signal.type === "aviation-weather") {
      airportWeather.push(signal);
    } else {
      otherSignals.push(signal);
    }
  }

  return [
    {
      title: `Forecast weather signals (${forecast.length})`,
      description: "Open-Meteo precipitation or wind conditions that affect the score.",
      items: forecast
    },
    {
      title: `Official alert signals (${officialAlerts.length})`,
      description: "National Weather Service alerts that affect the score.",
      items: officialAlerts
    },
    {
      title: `Airport weather signals (${airportWeather.length})`,
      description: "Airport observations such as MVFR, IFR, LIFR, gusts, or visibility that affect flight risk.",
      items: airportWeather
    },
    {
      title: `Other signals (${otherSignals.length})`,
      description: "Additional detected risk signals.",
      items: otherSignals
    }
  ].filter((group) => group.items.length);
}

function renderEvidence(evidence) {
  const container = document.querySelector("#evidence");
  container.innerHTML = "";

  const groups = groupEvidence(evidence);
  groups.forEach((group, index) => {
    const wrapper = document.createElement("details");
    wrapper.className = "evidence-group";
    if (index === 0) wrapper.open = true;
    wrapper.innerHTML = `
      <summary>
        <span class="summary-title"></span>
        <span class="summary-description"></span>
      </summary>
      <div class="evidence-group-body"></div>
    `;
    wrapper.querySelector(".summary-title").textContent = group.title;
    wrapper.querySelector(".summary-description").textContent = group.description;

    const body = wrapper.querySelector(".evidence-group-body");
    for (const item of group.items) {
      body.appendChild(createEvidenceCard(item));
    }
    container.appendChild(wrapper);
  });
}

function createEvidenceCard(item) {
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
      <p class="meta"></p>
      <p><strong></strong></p>
      <p class="body"></p>
      <span class="severity ${item.severity || "unknown"}">${item.severity || "unknown"}</span>
    `;
  card.querySelector(".meta").textContent = `${item.source} · ${item.label}`;
  card.querySelector("strong").textContent = item.headline;
  card.querySelector(".body").textContent = summarizeDetails(item.details);
  return card;
}

function groupEvidence(evidence) {
  const openMeteo = [];
  const nationalWeather = [];
  const otherEvidence = [];
  const originAirports = [];
  const destinationAirports = [];

  for (const item of evidence) {
    if (item.source === "Open-Meteo Forecast API") {
      openMeteo.push(item);
    } else if (item.source === "National Weather Service API") {
      nationalWeather.push(item);
    } else if (item.label === "Origin airport weather") {
      originAirports.push(item);
    } else if (item.label === "Destination airport weather") {
      destinationAirports.push(item);
    } else {
      otherEvidence.push(item);
    }
  }

  return [
    {
      title: `Open-Meteo forecast (${openMeteo.length})`,
      description: "Daily forecast data for the origin, midpoint, and destination.",
      items: openMeteo
    },
    {
      title: `National Weather Service (${nationalWeather.length})`,
      description: "Official point forecasts and active alerts near the route endpoints.",
      items: nationalWeather
    },
    {
      title: `Origin airport weather (${originAirports.length})`,
      description: aviationCategoryGuide(),
      items: originAirports
    },
    {
      title: `Destination airport weather (${destinationAirports.length})`,
      description: aviationCategoryGuide(),
      items: destinationAirports
    },
    {
      title: `Other evidence (${otherEvidence.length})`,
      description: "Additional source data reviewed for this assessment.",
      items: otherEvidence
    }
  ].filter((group) => group.items.length);
}

function aviationCategoryExplanation(category) {
  return {
    VFR: "VFR means Visual Flight Rules: good visibility and cloud conditions.",
    MVFR: "MVFR means Marginal Visual Flight Rules: reduced visibility or lower clouds; delays become more likely.",
    IFR: "IFR means Instrument Flight Rules: poor visibility or low clouds; higher delay risk.",
    LIFR: "LIFR means Low Instrument Flight Rules: very poor visibility or very low clouds; highest disruption risk."
  }[category] || "";
}

function aviationCategoryGuide() {
  return "Nearest airport observations. VFR = good visual conditions. MVFR = marginal visibility or clouds. IFR = poor visibility or low clouds. LIFR = very poor visibility or very low clouds.";
}

function summarizeDetails(details) {
  if (!details) return "";
  if (!Array.isArray(details) && details.flightCategory) {
    const explanation = aviationCategoryExplanation(details.flightCategory);
    const base = summarizeObjectDetails(details);
    return explanation ? `${base} · ${explanation}` : base;
  }
  if (Array.isArray(details)) {
    return details
        .map((item) => `${item.name || "Period"}: ${item.shortForecast || item.detailedForecast || ""}`)
        .join(" ");
  }
  return summarizeObjectDetails(details);
}

function summarizeObjectDetails(details) {
  return Object.entries(details)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .slice(0, 8)
      .map(([key, value]) => `${labelize(key)}: ${String(value)}`)
      .join(" · ");
}

function labelize(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function tripTypeLabel(mode) {
  return {
    flight: "Flight-focused trip",
    drive: "Driving-focused trip",
    general: "Business trip with mixed transportation"
  }[mode] || "Travel assessment";
}

function summaryModeText(ai) {
  if (ai.used) return "Summary generated with the OpenAI API.";
  if (ai.error) return "Summary generated locally because the OpenAI API is unavailable.";
  return "Summary generated locally. OpenAI API is disabled.";
}
