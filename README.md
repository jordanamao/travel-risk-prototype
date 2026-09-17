# Travel Disruption Risk Prototype

This project is a working prototype for the Nukudo project assignment. It lets a user enter a U.S. travel route and date, gathers real external data, combines risk signals, and shows the evidence behind a travel disruption recommendation.

## What It Does

- Accepts origin, destination, date, and trip type.
- Geocodes the route.
- Pulls real weather and aviation data from multiple external sources.
- Scores risk signals as Low, Medium, or High.
- Shows evidence cards for every recommendation.
- Uses an AI synthesis step when `OPENAI_API_KEY` is configured, with a transparent local fallback when no key is present.

## External Data Sources

1. OpenStreetMap Nominatim
   - Used for geocoding user-entered locations.
   - https://nominatim.openstreetmap.org/

2. Open-Meteo Forecast API
   - Used for date-specific weather forecasts at origin, midpoint, and destination.
   - https://open-meteo.com/

3. National Weather Service API
   - Used for official U.S. weather alerts and point forecasts.
   - https://www.weather.gov/documentation/services-web-api

4. Aviation Weather Center API
   - Used for METAR airport weather observations near the route endpoints.
   - https://aviationweather.gov/data/api/

## AI Usage

The prototype uses AI to turn structured evidence into a concise operations-style risk narrative, recommendation, and uncertainty statement.

If `OPENAI_API_KEY` is set, the backend calls the OpenAI Responses API. If no key is available, the app uses a transparent local fallback so the rest of the prototype still works and remains demoable.

## How to Run

This project uses only built-in Node.js modules. No npm install is required.

```bash
cd ~/Desktop/travel-risk-prototype
npm start
```

Then open:

```text
http://localhost:5177
```

Optional AI setup:

```bash
cp .env.example .env
```

Then edit `.env`:

```text
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-6-astra
```

Restart the server after editing `.env`.

## Risk Scoring Approach

The prototype scores signals from:

- precipitation probability and precipitation amount
- high wind or wind gusts
- official NWS alerts
- aviation flight categories such as MVFR, IFR, or LIFR
- METAR wind, gust, visibility, and weather strings

The score is intentionally explainable. Every risk level is tied back to visible evidence so the user can see why a recommendation was made.

## Assumptions

- The route is within the United States.
- Flight disruption risk is approximated using nearby airport weather observations and official weather alerts.
- Driving disruption risk is approximated using weather signals because this prototype does not include paid traffic or road-closure APIs.
- Airline-specific delays, aircraft availability, crew scheduling, and private company policies are out of scope.

## What I Would Improve Before Production

- Add live flight status and airline delay data.
- Add traffic, road closure, and incident data for driving routes.
- Add airport code selection and route path sampling.
- Cache external API calls and add retry/backoff behavior.
- Add user accounts, saved trips, notifications, and alert subscriptions.
- Add monitoring and structured logging.
- Add unit tests for scoring and API parsing.
