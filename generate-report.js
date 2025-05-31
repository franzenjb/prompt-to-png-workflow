const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// --- Configuration ---
const OUTPUT_DIR = './output';
const HTML_FILENAME = 'weather-report.html';
const PNG_FILENAME = 'weather-alert.png';
const GITHUB_PAGES_INDEX_FILENAME = 'index.html';

// --- Date Formatting ---
function getReportDates() {
    const today = new Date();
    const day5 = new Date(today);
    day5.setDate(today.getDate() + 4);
    const optionsLong = { year: 'numeric', month: 'long', day: 'numeric' };
    return {
        headerDateRange: `${today.toLocaleDateString('en-US', optionsLong)} - ${day5.toLocaleDateString('en-US', optionsLong)}`,
        aiContextTodayDate: today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        todayDateObject: today
    };
}

// --- OpenAI API Call ---
async function getWeatherDataFromAI(apiKey, aiContextTodayDate) {
    const systemMessage = `You are an expert weather forecaster preparing a concise 5-day severe weather risk report for emergency management in the southeastern US. Today is ${aiContextTodayDate}.
Focus ONLY on official-source-style information (NWS, SPC, WPC, NHC type outlooks).
Do NOT include seasonal commentary, historical context, speculation, or third-party sources.
Cover potential threats from SPC Day 1-3 Convective Outlooks, Day 4-8 Fire Weather Outlooks (if significant), WPC excessive rainfall, and NHC tropical outlooks.
States to cover: TN, MS, GA, AL, FL, NC, SC. Include USVI ONLY if a significant tropical threat exists.

Output Structure (Use these exact headings and then provide the information as plain text):
REPORT_FORECAST:
[For each identified threat over the next 5 days (today is Day 1), provide:
1.  A descriptive title (e.g., "SPC Day 1 Convective Outlook", "WPC Day 2 Excessive Rainfall Risk", "NHC Tropical Update - Area 1").
2.  The specific Day number (e.g., "Day 1", "Day 2").
3.  Timing (e.g., "Afternoon and Evening", "All Day").
4.  Affected Areas (list specific regions/states).
5.  Primary Hazards (e.g., "Damaging winds (58+ mph), large hail (up to 1.5 inches), a few tornadoes possible").
6.  Categorical Risk Level (Use ONLY: ENHANCED, SLIGHT, MARGINAL. For tropical/other, describe threat level if these don't apply).
Format each distinct threat clearly. If no threats, state within this section: "No significant weather threats are currently forecast..."]

RECOMMENDATIONS_IMMEDIATE_ACTIONS:
[Based on the forecast above, list 3-5 bulleted immediate action recommendations. If no significant threats, provide general preparedness advice.]

RECOMMENDATIONS_5_DAY_MONITORING:
[Based on the forecast above, list 3-5 bulleted 5-day monitoring recommendations. If no significant threats, provide general monitoring advice.]

Ensure Day 1 corresponds to today's date (${aiContextTodayDate}). Output as plain text only, respecting the heading structure.`;

    const userPrompt = `Provide the 5-day weather risk report for today, ${aiContextTodayDate}, following all instructions and the specified output structure (REPORT_FORECAST, RECOMMENDATIONS_IMMEDIATE_ACTIONS, RECOMMENDATIONS_5_DAY_MONITORING).`;

    console.log("Sending prompt to OpenAI for dynamic forecast and recommendations...");
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o',
            messages: [ { role: 'system', content: systemMessage }, { role: 'user', content: userPrompt } ],
            max_tokens: 2000, temperature: 0.2
        }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` } });
        console.log("Received response from OpenAI.");
        return response.data.choices[0].message.content.trim();
    } catch (error) {
        console.error('Error calling OpenAI API:', error.response ? error.response.data : error.message);
        throw error;
    }
}

// --- HTML Styling Helpers ---
const HAZARD_KEYWORDS_TO_BOLD = [
    "damaging winds (?:\\(58\\+\\s*mph\\))?", "damaging wind gusts", "severe wind gusts", "58\\+\\s*mph winds", "60\\+\\s*mph winds", "70\\+\\s*mph winds",
    "large hail", "hail up to", "hail \\(up to", "significant hail", "golf ball sized hail", "baseball sized hail",
    "small hail", "pea sized hail",
    "tornadoes possible", "a few tornadoes", "isolated tornadoes", "tornado risk", "potential for tornadoes", "tornadoes", "tornado watch", "tornado warning",
    "flooding possible", "localized flooding", "flash flooding", "flash flood warning", "flash flood watch", "river flooding", "coastal flooding", "urban flooding", "significant flooding", "moderate flooding", "major flooding",
    "heavy rainfall", "heavy rain", "excessive rainfall", "torrential rain", "inches of rain",
    "strong thunderstorms", "severe thunderstorms", "scattered thunderstorms", "isolated thunderstorms", "thunderstorm risk",
    "high winds", "strong winds", "gusty winds", "wind advisory", "high wind warning",
    "critical fire weather", "extreme fire weather", "elevated fire weather", "red flag warning", "fire weather watch",
    "tropical storm conditions", "tropical storm warning", "tropical storm watch",
    "hurricane conditions", "hurricane warning", "hurricane watch",
    "storm surge warning", "storm surge watch", "storm surge", "life-threatening storm surge",
    "tropical depression", "tropical storm", "hurricane", "major hurricane", "tropical disturbance", "area of interest", "potential tropical cyclone",
    "dangerous surf", "rip currents", "high surf advisory",
    "dense fog", "visibility near zero", "dense fog advisory",
    "winter storm", "blizzard", "heavy snow", "ice storm", "freezing rain", "sleet"
    // This list should be continually updated based on observed AI outputs
];

function styleText(text) {
    if (!text) return "";
    let styledText = text;

    HAZARD_KEYWORDS_TO_BOLD.forEach(keywordPattern => { // keywordPattern is now a regex string
        const regex = new RegExp(`\\b(${keywordPattern})\\b`, 'gi');
        styledText = styledText.replace(regex, (match) => `<span style="font-weight:bold;">${match}</span>`);
    });

    const riskLevels = {
        "ENHANCED": '<span style="color:#cc0000; font-weight:bold;">ENHANCED</span>',
        "SLIGHT": '<span style="color:#e67300; font-weight:bold;">SLIGHT</span>',
        "MARGINAL": '<span style="color:#ffcc00; font-weight:bold;">MARGINAL</span>',
        "HIGH": '<span style="color:#FF00FF; font-weight:bold;">HIGH</span>',         // Often for WPC Excessive Rainfall or Fire Weather
        "MODERATE": '<span style="color:#DC143C; font-weight:bold;">MODERATE</span>', // Often for WPC Excessive Rainfall or SPC (Day 1-3 for SPC is different)
        "CRITICAL": '<span style="color:#FF4500; font-weight:bold;">CRITICAL</span>', // Fire Weather
        "EXTREME": '<span style="color:#8B0000; font-weight:bold;">EXTREME</span>'    // Fire Weather
    };
    Object.keys(riskLevels).forEach(level => {
        const regex = new RegExp(`\\b(${level})(?!\\w|-)`, 'g'); // Match whole word, case sensitive, ensure it's not part of a larger word like "MARGINALLY"
        styledText = styledText.replace(regex, riskLevels[level]);
    });
    return styledText.replace(/\n/g, '<br />'); // Convert newlines to <br> for HTML display
}

function parseAIResponse(aiText, todayDateObject) {
    const sections = {
        forecast: "No forecast data extracted.",
        immediateActions: "<li>No immediate actions extracted.</li>",
        fiveDayMonitoring: "<li>No 5-day monitoring actions extracted.</li>"
    };

    const forecastMatch = aiText.match(/REPORT_FORECAST:([\s\S]*?)RECOMMENDATIONS_IMMEDIATE_ACTIONS:/);
    const immediateMatch = aiText.match(/RECOMMENDATIONS_IMMEDIATE_ACTIONS:([\s\S]*?)RECOMMENDATIONS_5_DAY_MONITORING:/);
    const monitoringMatch = aiText.match(/RECOMMENDATIONS_5_DAY_MONITORING:([\s\S]*)/);

    if (forecastMatch && forecastMatch[1]) {
        let forecastText = forecastMatch[1].trim();
        // Replace Day X with Day X (Full Date)
        forecastText = forecastText.replace(/Day\s*(\d+)/gi, (match, dayNum) => {
            const dNum = parseInt(dayNum);
            const threatDate = new Date(todayDateObject);
            threatDate.setDate(todayDateObject.getDate() + (dNum - 1));
            return `<strong>Day ${dNum} (${threatDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })})</strong>`;
        });
        sections.forecast = styleText(forecastText);
    }

    if (immediateMatch && immediateMatch[1]) {
        const items = immediateMatch[1].trim().split(/\n-\s*|\n\*\s*|\n\s*\d\.\s*/).filter(item => item.trim() !== "");
        sections.immediateActions = items.map(item => `<li>${styleText(item.trim())}</li>`).join('');
    }

    if (monitoringMatch && monitoringMatch[1]) {
        const items = monitoringMatch[1].trim().split(/\n-\s*|\n\*\s*|\n\s*\d\.\s*/).filter(item => item.trim() !== "");
        sections.fiveDayMonitoring = items.map(item => `<li>${styleText(item.trim())}</li>`).join('');
    }
    
    // If the AI specific "no significant threats" message is present in the forecast section
    if (forecastMatch && forecastMatch[1] && forecastMatch[1].toLowerCase().includes("no significant weather threats")) {
        sections.forecast = `<p>${styleText(forecastMatch[1].trim())}</p>`; // Style the "no threats" message too
    }


    return sections;
}

// --- Main HTML Structure ---
function generateFullHtml(headerDateRange, parsedSections) {
    const attribution = `<p style="font-size:14px; color:#666;">Sources: Information synthesized based on official forecast agency outlooks (NWS Storm Prediction Center, NOAA, FEMA, and state emergency management agencies).</p>`;
    return `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Weather Risk Report | ${headerDateRange}</title>
<style>
    body { margin: 0; padding: 0; }
    #weatherReportContainer { background-color:#ffffff; font-family:Arial, Helvetica, sans-serif; color:#333333; font-size:16px; line-height:1.6; padding:24px; margin:0 auto; width: 700px; border: 1px solid #ccc; }
    #weatherReportContainer h2 { color:#990000; font-weight:bold; margin-top:0; padding-bottom: 5px; border-bottom: 2px solid #990000; }
    #weatherReportContainer h3 { color:#990000; font-weight:bold; margin-top: 20px; margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
    #weatherReportContainer h4 { color:#990000; font-weight:bold; margin-top: 15px; margin-bottom: 5px; }
    #weatherReportContainer ul { margin-top: 0; padding-left: 20px; }
    #weatherReportContainer li { margin-bottom: 5px; }
    #weatherReportContainer p { margin-top: 0; margin-bottom: 10px; }
    #weatherReportContainer .forecast-section p { margin-bottom: 1em; } /* Add space between forecast paragraphs */
</style></head><body>
    <div id="weatherReportContainer">
        <h2>${headerDateRange}</h2>
        <h3>Severe Weather Threats (5-Day Outlook)</h3>
        <div class="forecast-section">${parsedSections.forecast}</div>
        <h3>Recommendations</h3>
        <h4>Immediate Actions</h4>
        <ul>${parsedSections.immediateActions}</ul>
        <h4>5-Day Monitoring</h4>
        <ul>${parsedSections.fiveDayMonitoring}</ul>
        <br/> 
        ${attribution}
    </div>
</body></html>`;
}

// --- Puppeteer PNG Generation (same as before, ensure element ID matches) ---
async function generatePng(htmlContent, outputPath) {
    let browser;
    try {
        console.log("Launching Puppeteer...");
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--font-render-hinting=medium']});
        const page = await browser.newPage();
        await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1.5 });
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        const reportElement = await page.$('#weatherReportContainer');
        if (!reportElement) throw new Error("Could not find #weatherReportContainer for screenshotting.");
        await reportElement.screenshot({ path: outputPath, type: 'png' });
        console.log(`PNG saved to ${outputPath}`);
    } finally {
        if (browser) { console.log("Closing Puppeteer."); await browser.close(); }
    }
}

// --- GitHub Pages Index File (same as before) ---
async function createGitHubPagesIndex(pngFileNameInOutput) {
    const html = `<!DOCTYPE html><html><head><title>Weather Alert</title><meta http-equiv="refresh" content="0; url=${pngFileNameInOutput}"><style> body { margin: 20px; font-family: Arial, sans-serif; text-align: center;} img { max-width: 100%; height: auto; border: 1px solid #ccc; } </style></head><body><h1>Weather Alert</h1><p>If you are not redirected, <a href="${pngFileNameInOutput}">click here to view the weather alert image</a>.</p><img src="${pngFileNameInOutput}" alt="Daily Weather Alert"></body></html>`;
    await fs.writeFile(path.join(OUTPUT_DIR, GITHUB_PAGES_INDEX_FILENAME), html);
    console.log(`GitHub Pages index.html created at ${path.join(OUTPUT_DIR, GITHUB_PAGES_INDEX_FILENAME)}`);
}

// --- Main Function ---
async function main() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) { console.error("OPENAI_API_KEY environment variable is not set."); process.exit(1); }

    try {
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        const { headerDateRange, aiContextTodayDate, todayDateObject } = getReportDates();
        console.log(`Report Date Range: ${headerDateRange}`);

        const aiRawTextResponse = await getWeatherDataFromAI(apiKey, aiContextTodayDate);
        console.log("\n--- Raw AI Text Response (for debugging) ---");
        console.log(aiRawTextResponse); // Log the raw response for easier debugging of parsing
        console.log("--- End of Raw AI Text Response ---\n");

        const parsedSections = parseAIResponse(aiRawTextResponse, todayDateObject);
        
        const fullHtml = generateFullHtml(headerDateRange, parsedSections);
        const htmlFilePath = path.join(OUTPUT_DIR, HTML_FILENAME);
        await fs.writeFile(htmlFilePath, fullHtml);
        console.log(`HTML report saved to ${htmlFilePath}`);

        const pngFilePath = path.join(OUTPUT_DIR, PNG_FILENAME);
        await generatePng(fullHtml, pngFilePath);
        
        await createGitHubPagesIndex(PNG_FILENAME);
        console.log("Weather report generation process completed successfully!");

    } catch (error) {
        console.error("Error in main function:", error);
        process.exit(1);
    }
}

main();
