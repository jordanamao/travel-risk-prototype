const form = document.querySelector("#trip-form");
const dateInput = form.elements.date;
const emptyState = document.querySelector("#empty-state");
const loading = document.querySelector("#loading");
const results = document.querySelector("#results");
const errorBox = document.querySelector("#error");

const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
dateInput.value = tomorrow.toISOString().slice(0, 10);

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
    errorBox.textContent = error.message;
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
    `${data.input.origin} to ${data.input.destination} on ${data.input.date}`;
  document.querySelector("#risk-summary").textContent = data.summary;
  document.querySelector("#recommendation").textContent = data.recommendation;
  document.querySelector("#uncertainty").textContent =
    `${data.uncertainty} AI status: ${data.ai.used ? "OpenAI synthesis used." : `Fallback synthesis used (${data.ai.reason || data.ai.error || "no key"}).`}`;

  const badge = document.querySelector("#risk-badge");
  badge.className = `risk-badge ${level}`;
  badge.textContent = data.score.level;

  renderCards(
    "#signals",
    data.signals.length
      ? data.signals.map((signal) => ({
          meta: `${signal.type} · ${signal.severity}`,
          title: signal.message,
          body: signal.evidence,
          severity: signal.severity
        }))
      : [
          {
            meta: "No major signals",
            title: "No meaningful risk signal was detected.",
            body: "The evidence still appears below for review.",
            severity: "low"
          }
        ]
  );

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

function renderEvidence(evidence) {
  const container = document.querySelector("#evidence");
  container.innerHTML = "";
  for (const item of evidence) {
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
    container.appendChild(card);
  }
}

function summarizeDetails(details) {
  if (!details) return "";
  if (Array.isArray(details)) {
    return details
      .map((item) => `${item.name || "Period"}: ${item.shortForecast || item.detailedForecast || ""}`)
      .join(" ");
  }
  return Object.entries(details)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 8)
    .map(([key, value]) => `${labelize(key)}: ${String(value)}`)
    .join(" · ");
}

function labelize(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}
